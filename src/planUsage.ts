import * as https from 'https';

const BASE = 'https://claude.ai';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// One per-model weekly bucket (seven_day_sonnet, seven_day_opus, seven_day_fable, ...).
export interface ModelUsage {
    key: string;
    label: string;
    percent: number;
    resetAt: string | null;
}

export interface NormalizedUsage {
    sessionPercent: number | null;
    sessionResetAt: string | null;
    weeklyPercent: number | null;
    weeklyResetAt: string | null;
    sonnetPercent: number | null;
    sonnetResetAt: string | null;
    opusPercent: number | null;
    opusResetAt: string | null;
    fablePercent: number | null;
    fableResetAt: string | null;
    // Every per-model bucket claude.ai returned, including ones we don't know by name.
    models: ModelUsage[];
}

export interface UsageResult {
    source: string;
    normalized: NormalizedUsage;
    // Untouched response body — logged for diagnosis when claude.ai changes the schema.
    raw: any;
}

export class AuthExpiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthExpiredError';
    }
}

// Cloudflare blocked the request (bot challenge) — this is NOT an expired Session Key.
// It happens when the request originates from a network stack with a non-browser TLS
// fingerprint (plain Node `https`), typically on a remote/headless extension host.
export class CloudflareBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CloudflareBlockedError';
    }
}

interface RawResponse {
    status: number;
    json: any | null;
    raw: string;
}

const HEADERS = (sessionCookie: string): Record<string, string> => ({
    Cookie: `sessionKey=${sessionCookie}`,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
    Referer: `${BASE}/`
});

// claude.ai sits behind Cloudflare, which fingerprints the TLS handshake and blocks
// plain Node `https` requests (returns a 403 "Just a moment..." challenge page). The VS
// Code extension host runs on Electron, whose `net` module uses Chromium's network stack
// and passes the challenge — so we use it when available and fall back to https otherwise.
let electronNet: any | undefined;
function getElectronNet(): any | null {
    if (electronNet !== undefined) return electronNet;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require('electron');
        electronNet = electron && electron.net ? electron.net : null;
    } catch {
        electronNet = null;
    }
    return electronNet;
}

// Distinguish a Cloudflare bot challenge from a genuine API auth rejection. A challenge
// returns an HTML "Just a moment..." interstitial (or cf-mitigated/challenge-platform
// markers); a real expired Session Key returns a JSON/empty 401/403 from the origin.
function isCloudflareChallenge(status: number, body: string): boolean {
    if (status !== 403 && status !== 503 && status !== 429) return false;
    return /just a moment|challenge-platform|cf-chl|cdn-cgi\/challenge|_cf_chl|cf-mitigated/i.test(body);
}

function classify(status: number, body: string): RawResponse {
    if (status >= 200 && status < 300) {
        try {
            return { status, json: JSON.parse(body), raw: body };
        } catch {
            return { status, json: null, raw: body };
        }
    }
    if (isCloudflareChallenge(status, body)) {
        throw new CloudflareBlockedError(`Cloudflare challenge (HTTP ${status})`);
    }
    if (status === 401 || status === 403) {
        throw new AuthExpiredError(`Auth failed (HTTP ${status})`);
    }
    throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
}

function requestViaElectron(net: any, url: string, sessionCookie: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url, redirect: 'follow' });
        const headers = HEADERS(sessionCookie);
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
        let body = '';
        req.on('response', (res: any) => {
            res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
            res.on('end', () => {
                try {
                    resolve(classify(res.statusCode || 0, body));
                } catch (e) {
                    reject(e);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

function requestViaHttps(url: string, sessionCookie: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'GET',
                headers: HEADERS(sessionCookie),
                timeout: 15000
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk.toString('utf8')));
                res.on('end', () => {
                    try {
                        resolve(classify(res.statusCode || 0, body));
                    } catch (e) {
                        reject(e);
                    }
                });
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.end();
    });
}

function request(url: string, sessionCookie: string): Promise<RawResponse> {
    const net = getElectronNet();
    return net ? requestViaElectron(net, url, sessionCookie) : requestViaHttps(url, sessionCookie);
}

// Which network transport is in use — 'electron' (desktop) passes Cloudflare; 'https'
// (remote/headless host) gets a 403 challenge or, on some networks, a failed connection.
export function getTransport(): 'electron' | 'https' {
    return getElectronNet() ? 'electron' : 'https';
}

// claude.ai /api/organizations/{orgId}/usage carries per-model weekly caps in two shapes:
//
//   Legacy (confirmed 2026-04-21) — one bucket per model:
//     { five_hour: {utilization, resets_at}, seven_day: {...},
//       seven_day_sonnet: {...}, seven_day_opus: null|{...} }
//
//   Current (confirmed 2026-07-13) — a `limits` array; the legacy buckets are all null:
//     limits: [ {kind: "session",       percent, resets_at, scope: null},
//               {kind: "weekly_all",    percent, resets_at, scope: null},
//               {kind: "weekly_scoped", percent, resets_at,
//                scope: {model: {display_name: "Fable"}}} ]
//
// The model line-up changes (Sonnet left the weekly caps, Fable joined), so nothing here
// hardcodes a model name: every `weekly_scoped` entry is rendered under whatever
// display_name it carries, and the legacy buckets are still read for accounts that get
// only the old shape.
const MODEL_BUCKET_PREFIX = 'seven_day_';

interface RawLimit {
    kind?: string;
    percent?: number;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
}

function readBucket(bucket: any) {
    return {
        percent: bucket && typeof bucket.utilization === 'number' ? bucket.utilization : null,
        resetAt: (bucket && bucket.resets_at) || null
    };
}

// "seven_day_fable_5" → "Fable 5"
function modelLabel(key: string): string {
    return key
        .slice(MODEL_BUCKET_PREFIX.length)
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function collectModels(json: any, limits: RawLimit[]): ModelUsage[] {
    const models: ModelUsage[] = [];
    const seen = new Set<string>();
    const add = (key: string, label: string | null, percent: number | null, resetAt: string | null) => {
        if (!label || percent == null || seen.has(label.toLowerCase())) return;
        seen.add(label.toLowerCase());
        models.push({ key, label, percent, resetAt });
    };

    for (const entry of limits) {
        if (entry?.kind !== 'weekly_scoped') continue;
        const label = entry.scope?.model?.display_name || entry.scope?.surface || null;
        add(
            `weekly_scoped:${label}`,
            label,
            typeof entry.percent === 'number' ? entry.percent : null,
            entry.resets_at ?? null
        );
    }

    for (const [key, bucket] of Object.entries(json ?? {})) {
        if (!key.startsWith(MODEL_BUCKET_PREFIX)) continue;
        const { percent, resetAt } = readBucket(bucket);
        add(key, modelLabel(key), percent, resetAt);
    }

    return models;
}

function normalizeUsage(json: any): NormalizedUsage {
    const limits: RawLimit[] = Array.isArray(json?.limits) ? json.limits : [];
    const byKind = (kind: string) => limits.find((l) => l?.kind === kind);

    // Prefer the top-level buckets, fall back to the `limits` array if they ever go null too.
    const fromLimit = (kind: string) => {
        const l = byKind(kind);
        return {
            percent: l && typeof l.percent === 'number' ? l.percent : null,
            resetAt: l?.resets_at ?? null
        };
    };
    const pick = (bucket: any, kind: string) => {
        const b = readBucket(bucket);
        return b.percent != null ? b : fromLimit(kind);
    };

    const session = pick(json?.five_hour, 'session');
    const weekly = pick(json?.seven_day, 'weekly_all');
    const models = collectModels(json, limits);
    const named = (name: string) => models.find((m) => m.label.toLowerCase().startsWith(name));

    const sonnet = named('sonnet');
    const opus = named('opus');
    const fable = named('fable');

    return {
        sessionPercent: session.percent,
        sessionResetAt: session.resetAt,
        weeklyPercent: weekly.percent,
        weeklyResetAt: weekly.resetAt,
        sonnetPercent: sonnet?.percent ?? null,
        sonnetResetAt: sonnet?.resetAt ?? null,
        opusPercent: opus?.percent ?? null,
        opusResetAt: opus?.resetAt ?? null,
        fablePercent: fable?.percent ?? null,
        fableResetAt: fable?.resetAt ?? null,
        models
    };
}

// Tries several candidate endpoints (the usage endpoint is unofficial). Returns the
// first that yields JSON. Throws AuthExpiredError on 401/403 so the caller can prompt
// for a fresh Session Key.
export async function fetchUsage(sessionCookie: string, orgId: string): Promise<UsageResult> {
    const candidates = [
        `${BASE}/api/organizations/${orgId}/usage`,
        `${BASE}/api/organizations/${orgId}/usage_limits`,
        `${BASE}/api/bootstrap/${orgId}/statsig`,
        `${BASE}/api/organizations/${orgId}`
    ];

    const errors: string[] = [];
    for (const url of candidates) {
        try {
            const res = await request(url, sessionCookie);
            if (res.json) {
                return { source: url, normalized: normalizeUsage(res.json), raw: res.json };
            }
        } catch (err: any) {
            if (err instanceof AuthExpiredError || err instanceof CloudflareBlockedError) throw err;
            errors.push(`${url} → ${err?.message ?? err}`);
        }
    }
    throw new Error(`All endpoints failed:\n${errors.join('\n')}`);
}
