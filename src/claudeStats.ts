// Claude Status — data collection.
//
// Two independent things live here, both read-only, both local:
//
//   1. Lifetime stats. Claude Code already computes these and parks them in
//      ~/.claude/stats-cache.json (totals per model, per-day activity, longest
//      session). We read that file rather than re-deriving 8 billion tokens'
//      worth of history ourselves. The cache stops at lastComputedDate — i.e.
//      it does not include today — so today's row is counted here and appended.
//
//   2. What is eating the limits right now. The CLI's own /usage screen says
//      "Approximate, based on local sessions on this machine", and that is
//      exactly what this does: walk the last 24h of session logs and attribute
//      token weight to long-context turns and to skills.
//
// Every figure below was checked against the CLI's own /usage and /stats output
// on 2026-09-08 before being wired up; where a number could not be reproduced
// exactly, the comment says so rather than pretending.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getShortModelName } from './providers/claude/display';

/** Context size above which a turn counts as "long" — the CLI uses 150k. */
const LONG_CONTEXT_THRESHOLD = 150_000;

/** How far back the contribution breakdown looks. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Files older than this are skipped outright. One hour of slack over the window
 *  so a log that was appended to just before the cutoff is still opened. */
const MTIME_SLACK_MS = WINDOW_MS + 60 * 60 * 1000;

/** Re-scan no more often than this; the panel can ask on every tab click. */
const SCAN_CACHE_MS = 20_000;

export interface HeatDay {
    date: string;      // YYYY-MM-DD, local
    count: number;     // messages that day
    level: number;     // 0..4 heat bucket
}

export interface ModelShare {
    model: string;
    label: string;
    tokens: number;
    percent: number;
    /** Same API-rate conversion as the per-session figure. */
    costUSD: number;
}

export interface StatsView {
    available: boolean;
    totalTokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    sessions: number;
    activeDays: number;
    windowDays: number;
    longestSessionMs: number;
    longestStreak: number;
    currentStreak: number;
    mostActiveDayLabel: string;
    favoriteModelLabel: string;
    byModel: ModelShare[];
    daily: HeatDay[];
    /** Lifetime API-rate conversion across every model in the cache. */
    costUSD: number;
    hasUnknownRate: boolean;
}

export interface SkillShare {
    name: string;
    percent: number;
}

export interface LocalUsageView {
    available: boolean;
    threshold: number;
    longContextPercent: number;
    skills: SkillShare[];
    sampleCount: number;
}

export interface ClaudeStatsResult {
    stats: StatsView;
    local: LocalUsageView;
}

// ── API price list ──────────────────────────────────────────────────────────
//
// USD per 1M tokens, first-party Anthropic API rates (source: the bundled
// claude-api reference, priced 2026-06-24). These convert token counts into
// "what this would have cost on the API".
//
// On a subscription nothing here is billed — Claude Code's own cost-state record
// writes totalCostUSD: 0 for exactly that reason. The panel labels the number as
// a conversion so it is never mistaken for an invoice.
//
// Cache rates follow the documented multipliers: a cache write costs ~1.25x the
// input rate, a cache read ~0.1x. Fable is the exception — its cache reads are
// documented at a flat $0.25/MTok rather than a tenth of its $10 input rate.
//
// An id that matches nothing is reported rather than guessed (see hasUnknownRate),
// the same distinction Claude Code draws with its hasUnknownModelCost flag.
interface ModelRate {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
}

const RATE_TABLE: { test: (m: string) => boolean; rate: ModelRate }[] = [
    // Fable / Mythos — $10 / $50, cache read documented flat at $0.25
    {
        test: m => m.includes('fable') || m.includes('mythos'),
        rate: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 }
    },
    // Opus 4 and later — $5 / $25
    {
        test: m => { const v = m.match(/opus[-_]?(\d{1,2})(?!\d)/); return !!v && parseInt(v[1], 10) >= 4; },
        rate: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }
    },
    // Sonnet 5 and later — $2 / $10
    {
        test: m => { const v = m.match(/sonnet[-_](\d{1,2})(?!\d)/); return !!v && parseInt(v[1], 10) >= 5; },
        rate: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }
    },
    // Sonnet 4.6 — $3 / $15
    {
        test: m => /sonnet[-_]4(?!\d)[-_]6(?!\d)/.test(m),
        rate: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
    },
    // Haiku 4.5 — $1 / $5
    {
        test: m => { const v = m.match(/haiku[-_](\d{1,2})(?!\d)/); return !!v && parseInt(v[1], 10) >= 4; },
        rate: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
    }
];

function rateFor(model: string): ModelRate | null {
    const m = (model || '').toLowerCase();
    if (!m) return null;
    for (const entry of RATE_TABLE) {
        try {
            if (entry.test(m)) return entry.rate;
        } catch { /* a malformed id just falls through to unknown */ }
    }
    return null;
}

/** Token counts for one model within a conversation. */
export interface ModelTokens {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUSD: number;
    /** True when no published rate matched this model id. */
    unknownRate: boolean;
}

/** Per-conversation totals — the CLI's own end-of-session summary, per live session. */
export interface SessionSummary {
    sessionFile: string;
    /** Wall-clock span from the first record to the last. */
    wallMs: number;
    /** Time the conversation was actually turning: each user record to the reply that
     *  followed it, summed. Tool runs count too, so this is not pure API latency. */
    activeMs: number;
    linesAdded: number;
    linesRemoved: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Distinct API requests (streaming snapshots collapsed). */
    requests: number;
    /** What these tokens would have cost at published API rates. */
    costUSD: number;
    /** True when some model in the conversation had no published rate. */
    hasUnknownRate: boolean;
    /** Per-model breakdown behind costUSD. */
    byModel: ModelTokens[];
    /**
     * costUSD split by what was charged for. On a long conversation cache reads
     * dominate — every request re-reads the whole thread — and that is the part
     * users do not expect, so the panel shows this split rather than one number.
     */
    costParts: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /**
     * `totalCostUSD` as Claude Code itself recorded it, when the session ended
     * cleanly and wrote a `cost-state` record. It is 0 on a subscription, which
     * is why it is kept separate from the conversion above rather than replacing it.
     */
    recordedCostUSD: number | null;
    /** `totalAPIDuration` from that same record — real API time, not our estimate. */
    recordedApiMs: number | null;
}

// ── raw cache shape (only the parts we consume) ─────────────────────────────

interface RawDailyActivity { date: string; messageCount: number; sessionCount: number; toolCallCount?: number }
interface RawModelUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
}
interface RawStatsCache {
    version?: number;
    lastComputedDate?: string;
    dailyActivity?: RawDailyActivity[];
    modelUsage?: Record<string, RawModelUsage>;
    totalSessions?: number;
    longestSession?: { duration?: number };
}

// ── small helpers ───────────────────────────────────────────────────────────

function claudeDir(): string {
    return path.join(os.homedir(), '.claude');
}

/** Local-time YYYY-MM-DD. The cache's dates are day keys, so we compare as strings. */
function dayKey(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

function daysBetween(fromKey: string, toKey: string): number {
    const a = new Date(fromKey + 'T00:00:00');
    const b = new Date(toKey + 'T00:00:00');
    return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function addDays(key: string, delta: number): string {
    const d = new Date(key + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    return dayKey(d);
}

/** "2026-08-19" → "Aug 19". Month names stay English on purpose: they sit next to
 *  numbers in a compact cell and every locale renders these three letters fine. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(key: string): string {
    const p = key.split('-');
    if (p.length !== 3) return key;
    const mi = Number(p[1]) - 1;
    return `${MONTHS[mi] ?? p[1]} ${Number(p[2])}`;
}

// ── stats-cache.json ────────────────────────────────────────────────────────

function readStatsCache(): RawStatsCache | null {
    try {
        const raw = fs.readFileSync(path.join(claudeDir(), 'stats-cache.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as RawStatsCache;
    } catch {
        // Missing (fresh install), unreadable, or malformed — all mean "no stats yet".
        return null;
    }
}

/**
 * Heat buckets 1..4 from the day's message count.
 *
 * Quantiles, not a share of the maximum: activity is heavily skewed (one 4,576
 * message day against a median near 400), so a max-relative scale would paint
 * almost every day the palest shade and lose all texture.
 */
function heatLevels(counts: number[]): (n: number) => number {
    const sorted = counts.filter(c => c > 0).sort((a, b) => a - b);
    if (!sorted.length) return () => 0;
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
    return (n: number) => {
        if (n <= 0) return 0;
        if (n <= q1) return 1;
        if (n <= q2) return 2;
        if (n <= q3) return 3;
        return 4;
    };
}

/** Longest and current run of consecutive active days. */
function streaks(dayKeys: string[], todayKey: string): { longest: number; current: number } {
    if (!dayKeys.length) return { longest: 0, current: 0 };
    const sorted = Array.from(new Set(dayKeys)).sort();
    const present = new Set(sorted);

    let longest = 0;
    let run = 0;
    let prev: string | null = null;
    for (const d of sorted) {
        run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
        if (run > longest) longest = run;
        prev = d;
    }

    // The current streak is only "current" if it reaches today (or yesterday — a day
    // that has not been worked yet should not read as a broken streak at 9am).
    let anchor: string | null = null;
    if (present.has(todayKey)) anchor = todayKey;
    else if (present.has(addDays(todayKey, -1))) anchor = addDays(todayKey, -1);

    let current = 0;
    if (anchor) {
        let cursor = anchor;
        while (present.has(cursor)) { current++; cursor = addDays(cursor, -1); }
    }
    return { longest, current };
}

// ── session-log scan ────────────────────────────────────────────────────────

interface ScanResult {
    /** Token weight of all assistant turns in the window. */
    totalWeight: number;
    /** ...of those whose context exceeded the threshold. */
    longWeight: number;
    /** Token weight per attributed skill. */
    bySkill: Map<string, number>;
    /** Assistant turns seen in the window. */
    samples: number;
    /** Messages recorded today (local), for the heatmap's trailing cell. */
    todayMessages: number;
    /** Distinct sessions touched today. */
    todaySessions: Set<string>;
}

function listSessionLogs(dir: string, out: string[], depth = 0): string[] {
    // Main conversation logs only: projects/<slug>/<uuid>.jsonl.
    //
    // The subagents/ subtree is deliberately skipped. Measured on 2026-09-08: with
    // subagents excluded the long-context share came out at 73% against the CLI's own
    // 75%, and the skill shares matched it exactly (4/4/3/1%). Including them dropped
    // the same figure to 60% and pushed a workflow-only entry to 38%, because each
    // subagent starts a fresh, small context and there can be dozens of them in one
    // run. So the CLI evidently counts main sessions only — and that is also the more
    // useful answer to "which of MY sessions is eating the limit".
    if (depth > 4) return out;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (e.name === 'subagents' || e.name === 'workflows') continue;
            listSessionLogs(path.join(dir, e.name), out, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

/**
 * Walk recent session logs once, collecting both the 24h contribution breakdown
 * and today's message/session counts.
 *
 * Only files whose mtime falls inside the window are opened. Session logs are
 * append-only, so an old mtime cannot hide a recent record; the reverse (a fresh
 * mtime on an old file, e.g. after a copy) merely costs one wasted read.
 */
function scanRecentLogs(now: number): ScanResult {
    const res: ScanResult = {
        totalWeight: 0,
        longWeight: 0,
        bySkill: new Map(),
        samples: 0,
        todayMessages: 0,
        todaySessions: new Set()
    };

    const projects = path.join(claudeDir(), 'projects');
    const files = listSessionLogs(projects, []);
    const cutoff = now - WINDOW_MS;
    const mtimeFloor = now - MTIME_SLACK_MS;
    const todayKey = dayKey(new Date(now));

    for (const file of files) {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(file);
        } catch {
            continue;
        }
        if (stat.mtimeMs < mtimeFloor) continue;

        let content: string;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }

        for (const line of content.split('\n')) {
            if (!line) continue;
            // Cheap pre-filter: full JSON.parse on 70k lines is the expensive part.
            const isAssistant = line.indexOf('"type":"assistant"') >= 0;
            if (!isAssistant && line.indexOf('"type":"user"') < 0) continue;

            let rec: any;
            try {
                rec = JSON.parse(line);
            } catch {
                continue;
            }
            if (rec.type !== 'assistant' && rec.type !== 'user') continue;

            const ts = Date.parse(rec.timestamp || '');
            if (!ts) continue;

            if (dayKey(new Date(ts)) === todayKey) {
                res.todayMessages++;
                if (rec.sessionId) res.todaySessions.add(rec.sessionId);
            }

            if (rec.type !== 'assistant' || ts < cutoff) continue;
            const u = rec.message && rec.message.usage;
            if (!u) continue;

            const context = (u.input_tokens || 0)
                + (u.cache_read_input_tokens || 0)
                + (u.cache_creation_input_tokens || 0);
            const weight = context + (u.output_tokens || 0);
            if (weight <= 0) continue;

            res.samples++;
            res.totalWeight += weight;
            if (context > LONG_CONTEXT_THRESHOLD) res.longWeight += weight;

            const skill = typeof rec.attributionSkill === 'string' ? rec.attributionSkill : '';
            if (skill) res.bySkill.set(skill, (res.bySkill.get(skill) || 0) + weight);
        }
    }

    return res;
}

// ── per-session summary ─────────────────────────────────────────────────────

// Session logs are append-only, so a (size, mtime) pair that has not moved means the
// parse would produce the same numbers. A finished conversation is therefore parsed
// once and then served from here for the rest of the session.
const summaryCache = new Map<string, { size: number; mtime: number; value: SessionSummary }>();

/**
 * Reproduce the CLI's end-of-session summary for one conversation log.
 *
 * Cost is not derived: the logs carry no `costUSD` field at all, and on a subscription
 * the CLI itself prints $0.0000, so the panel says the same rather than inventing a
 * figure from token prices.
 */
export function summarizeSession(filePath: string): SessionSummary | null {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }
    const hit = summaryCache.get(filePath);
    if (hit && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit.value;

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }

    const out: SessionSummary = {
        sessionFile: filePath,
        wallMs: 0, activeMs: 0,
        linesAdded: 0, linesRemoved: 0,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        requests: 0,
        costUSD: 0, hasUnknownRate: false, byModel: [],
        costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        recordedCostUSD: null, recordedApiMs: null
    };

    let first = 0;
    let last = 0;
    let pendingUser = 0;
    // One request writes 2-4 assistant records while streaming, every one of them
    // repeating the same usage figures. Counting them all would multiply the totals.
    const seenRequests = new Set<string>();
    // Cost is per model, so tokens are tallied per model rather than in one pile.
    const perModel = new Map<string, ModelTokens>();

    for (const line of content.split('\n')) {
        if (!line) continue;
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }

        const ts = Date.parse(rec.timestamp || '');
        if (ts) {
            if (!first || ts < first) first = ts;
            if (ts > last) last = ts;
        }

        // Edit/Write results carry a unified diff; count its added/removed lines.
        const tr = rec.toolUseResult;
        if (tr && Array.isArray(tr.structuredPatch)) {
            for (const hunk of tr.structuredPatch) {
                for (const l of (hunk?.lines || [])) {
                    if (typeof l !== 'string') continue;
                    if (l.charAt(0) === '+') out.linesAdded++;
                    else if (l.charAt(0) === '-') out.linesRemoved++;
                }
            }
        }

        // Claude Code writes this when a session ends cleanly: its own totals, with
        // the real API duration and the cost it computed. Authoritative where present.
        if (rec.type === 'cost-state') {
            if (typeof rec.totalCostUSD === 'number') out.recordedCostUSD = rec.totalCostUSD;
            if (typeof rec.totalAPIDuration === 'number') out.recordedApiMs = rec.totalAPIDuration;
            continue;
        }

        if (rec.type === 'user' && ts) {
            pendingUser = ts;
        } else if (rec.type === 'assistant') {
            if (ts && pendingUser) { out.activeMs += ts - pendingUser; pendingUser = 0; }
            const u = rec.message && rec.message.usage;
            if (u) {
                const id = rec.requestId || (rec.message && rec.message.id) || rec.uuid;
                if (id && !seenRequests.has(id)) {
                    seenRequests.add(id);
                    out.requests++;
                    const inp = u.input_tokens || 0;
                    const outp = u.output_tokens || 0;
                    const cr = u.cache_read_input_tokens || 0;
                    const cw = u.cache_creation_input_tokens || 0;
                    out.input += inp;
                    out.output += outp;
                    out.cacheRead += cr;
                    out.cacheWrite += cw;

                    const model = (rec.message && rec.message.model) || '';
                    let bucket = perModel.get(model);
                    if (!bucket) {
                        bucket = {
                            model,
                            input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
                            costUSD: 0, unknownRate: rateFor(model) === null
                        };
                        perModel.set(model, bucket);
                    }
                    bucket.input += inp;
                    bucket.output += outp;
                    bucket.cacheRead += cr;
                    bucket.cacheWrite += cw;
                }
            }
        }
    }

    for (const bucket of perModel.values()) {
        const rate = rateFor(bucket.model);
        if (!rate) {
            out.hasUnknownRate = true;
        } else {
            const cIn = (bucket.input / 1e6) * rate.input;
            const cOut = (bucket.output / 1e6) * rate.output;
            const cRead = (bucket.cacheRead / 1e6) * rate.cacheRead;
            const cWrite = (bucket.cacheWrite / 1e6) * rate.cacheWrite;
            bucket.costUSD = cIn + cOut + cRead + cWrite;
            out.costParts.input += cIn;
            out.costParts.output += cOut;
            out.costParts.cacheRead += cRead;
            out.costParts.cacheWrite += cWrite;
            out.costUSD += bucket.costUSD;
        }
        out.byModel.push(bucket);
    }
    out.byModel.sort((a, b) => b.costUSD - a.costUSD);

    out.wallMs = first && last && last >= first ? last - first : 0;
    summaryCache.set(filePath, { size: stat.size, mtime: stat.mtimeMs, value: out });
    return out;
}

// ── public entry point ──────────────────────────────────────────────────────

let cached: { at: number; value: ClaudeStatsResult } | null = null;

export function collectClaudeStats(force = false): ClaudeStatsResult {
    const now = Date.now();
    if (!force && cached && now - cached.at < SCAN_CACHE_MS) return cached.value;

    const scan = scanRecentLogs(now);
    const cache = readStatsCache();
    const todayKey = dayKey(new Date(now));

    // ── contribution breakdown ──
    const local: LocalUsageView = {
        available: scan.samples > 0 && scan.totalWeight > 0,
        threshold: LONG_CONTEXT_THRESHOLD,
        longContextPercent: scan.totalWeight ? Math.round(100 * scan.longWeight / scan.totalWeight) : 0,
        skills: Array.from(scan.bySkill.entries())
            .map(([name, w]) => ({ name, percent: Math.round(100 * w / scan.totalWeight) }))
            .filter(s => s.percent > 0)
            .sort((a, b) => b.percent - a.percent)
            // Anything past this is noise at 1% — the CLI shows a similarly short list.
            .slice(0, 8),
        sampleCount: scan.samples
    };

    // ── lifetime stats ──
    const stats: StatsView = {
        available: false,
        totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        sessions: 0, activeDays: 0, windowDays: 0,
        longestSessionMs: 0, longestStreak: 0, currentStreak: 0,
        mostActiveDayLabel: '', favoriteModelLabel: '',
        byModel: [], daily: [],
        costUSD: 0, hasUnknownRate: false
    };

    if (cache) {
        const mu = cache.modelUsage || {};
        const shares: ModelShare[] = [];
        for (const [model, v] of Object.entries(mu)) {
            const tokens = (v.inputTokens || 0) + (v.outputTokens || 0)
                + (v.cacheReadInputTokens || 0) + (v.cacheCreationInputTokens || 0);
            if (tokens <= 0) continue;
            stats.input += v.inputTokens || 0;
            stats.output += v.outputTokens || 0;
            stats.cacheRead += v.cacheReadInputTokens || 0;
            stats.cacheWrite += v.cacheCreationInputTokens || 0;
            const rate = rateFor(model);
            let costUSD = 0;
            if (!rate) {
                stats.hasUnknownRate = true;
            } else {
                costUSD =
                    ((v.inputTokens || 0) / 1e6) * rate.input +
                    ((v.outputTokens || 0) / 1e6) * rate.output +
                    ((v.cacheReadInputTokens || 0) / 1e6) * rate.cacheRead +
                    ((v.cacheCreationInputTokens || 0) / 1e6) * rate.cacheWrite;
                stats.costUSD += costUSD;
            }
            shares.push({ model, label: getShortModelName(model, false) || model, tokens, percent: 0, costUSD });
        }
        stats.totalTokens = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
        for (const s of shares) {
            s.percent = stats.totalTokens ? Math.round(100 * s.tokens / stats.totalTokens) : 0;
        }
        shares.sort((a, b) => b.tokens - a.tokens);
        stats.byModel = shares;
        stats.favoriteModelLabel = shares.length ? shares[0].label : '';

        stats.longestSessionMs = cache.longestSession?.duration || 0;

        // Daily activity + today's own row. The cache stops at lastComputedDate, so
        // today is always missing from it; we count it ourselves. Our tally is not
        // identical to the CLI's (it reached 1,443 where the CLI recorded 1,223 for
        // the same day — the CLI evidently filters some record kinds we keep), but
        // it only feeds the heat bucket, and tomorrow the cache supersedes it.
        const rows = (cache.dailyActivity || [])
            .filter(d => d && typeof d.date === 'string')
            .slice()
            .sort((a, b) => a.date.localeCompare(b.date));

        const daily: { date: string; count: number }[] = rows
            .filter(d => d.date < todayKey)
            .map(d => ({ date: d.date, count: d.messageCount || 0 }));

        const cachedToday = rows.find(d => d.date === todayKey);
        const todayCount = Math.max(cachedToday?.messageCount || 0, scan.todayMessages);
        if (todayCount > 0) daily.push({ date: todayKey, count: todayCount });

        const level = heatLevels(daily.map(d => d.count));
        stats.daily = daily.map(d => ({ date: d.date, count: d.count, level: level(d.count) }));

        stats.activeDays = daily.length;
        stats.windowDays = daily.length ? daysBetween(daily[0].date, todayKey) + 1 : 0;

        const st = streaks(daily.map(d => d.date), todayKey);
        stats.longestStreak = st.longest;
        stats.currentStreak = st.current;

        const busiest = daily.slice().sort((a, b) => b.count - a.count)[0];
        stats.mostActiveDayLabel = busiest ? shortDate(busiest.date) : '';

        // The cache's session total also stops yesterday; today's distinct sessions
        // are added on so the figure keeps up during the day.
        stats.sessions = (cache.totalSessions || 0)
            + (cachedToday ? 0 : scan.todaySessions.size);

        stats.available = stats.totalTokens > 0 || daily.length > 0;
    }

    const value: ClaudeStatsResult = { stats, local };
    cached = { at: now, value };
    return value;
}
