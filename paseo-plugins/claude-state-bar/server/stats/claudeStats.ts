import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeStatsView, ModelShare } from "../../shared/stats";
import { getShortModelName } from "../activity/modelName";
import { cacheWriteCost, rateFor } from "./rates";

// 작업 현황 "통계" 탭의 데몬 쪽(리규형님 10-08 결정: 확장 Claude Status 패널 통계 탭과 같은 내용).
// 복사본: VS Code 확장 src/claudeStats.ts(2026-10-08 기준) 중 통계 탭이 쓰는 부분만 —
//   · readStatsCache · heatLevels · streaks · dayKey · daysBetween · addDays (270~332줄)
//   · listSessionLogs (351~377줄)
//   · scanRecentLogs 의 "오늘 메시지·오늘 대화" 셈 (387~461줄 중 436~439줄)
//   · collectClaudeStats 의 lifetime 부분 (642~726줄)
// 확장 쪽 규칙을 고치면 여기도 같이 고친다. 사용량 탭의 "24시간 기여도"(긴 컨텍스트·스킬 몫)는 통계 탭에 안 나와서 옮기지 않았다.
//
// 무엇을 읽나(확장과 같다):
//   1. 누적 — Claude Code 가 ~/.claude/stats-cache.json 에 정리해 둔 모델별 토큰·날짜별 활동·대화 수·가장 긴 대화.
//      이 파일은 lastComputedDate 날까지만 담고 오늘은 없다.
//   2. 오늘 — ~/.claude/projects 의 대화 기록(본 대화만, subagents·workflows 폴더 제외)에서 오늘 메시지 수와 오늘 대화 수를 직접 센다.
// 날짜는 이 데몬이 도는 기기의 시간대로 가른다(stats-cache.json 도 그 기기에서 Claude Code 가 만들었다).

/** 확장 SCAN_CACHE_MS 와 같다 — 이보다 자주 다시 읽지 않는다(화면 여럿이 같이 물어도 한 번) */
const SCAN_CACHE_MS = 20_000;
/** 확장 MTIME_SLACK_MS 의 "창보다 1시간 여유"와 같은 여유 — 경계 직전에 덧붙은 기록도 연다 */
const MTIME_SLACK_MS = 60 * 60 * 1000;

function claudeDir(): string {
  // 다른 데몬 판독(server/activity/workflows.ts projectsDir)과 같게 CLAUDE_CONFIG_DIR 을 먼저 본다(확장은 늘 ~/.claude)
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// ── 날짜 ─────────────────────────────────────────────────────────────────────

/** 이 기기 시간대의 YYYY-MM-DD. 캐시의 날짜도 같은 모양이라 글자로 비교한다 */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function daysBetween(fromKey: string, toKey: string): number {
  const a = new Date(fromKey + "T00:00:00");
  const b = new Date(toKey + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function addDays(key: string, delta: number): string {
  const d = new Date(key + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return dayKey(d);
}

// ── stats-cache.json ─────────────────────────────────────────────────────────

interface RawDailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount?: number;
}
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

async function readStatsCache(): Promise<RawStatsCache | null> {
  try {
    const parsed = JSON.parse(await readFile(join(claudeDir(), "stats-cache.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as RawStatsCache;
  } catch {
    // 없음(새로 깐 기기)·못 읽음·깨짐 — 모두 "아직 통계 없음"
    return null;
  }
}

/**
 * 그날 메시지 수로 1~4 색 단계. 최댓값 비율이 아니라 분위수다 — 활동이 한쪽으로 크게 치우쳐서(하루 4,576 대 중앙값 400 안팎)
 * 최댓값 기준이면 거의 모든 날이 가장 옅은 색이 된다(확장 주석).
 */
function heatLevels(counts: number[]): (n: number) => number {
  const sorted = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const q1 = q(0.25);
  const q2 = q(0.5);
  const q3 = q(0.75);
  return (n: number) => {
    if (n <= 0) return 0;
    if (n <= q1) return 1;
    if (n <= q2) return 2;
    if (n <= q3) return 3;
    return 4;
  };
}

/** 가장 긴 연속 활동일과 지금 이어지는 연속 활동일 */
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

  // 오늘(또는 어제)까지 닿아야 "지금 연속"이다 — 아침에 아직 안 쓴 오늘 때문에 끊긴 것으로 보이지 않게
  let anchor: string | null = null;
  if (present.has(todayKey)) anchor = todayKey;
  else if (present.has(addDays(todayKey, -1))) anchor = addDays(todayKey, -1);

  let current = 0;
  if (anchor) {
    let cursor = anchor;
    while (present.has(cursor)) {
      current++;
      cursor = addDays(cursor, -1);
    }
  }
  return { longest, current };
}

// ── 오늘 대화 기록 ────────────────────────────────────────────────────────────

/**
 * 본 대화 기록만(projects/<폴더>/<번호>.jsonl). subagents·workflows 아래는 건너뛴다 — 확장이 2026-09-08 CLI /usage 와 대조해
 * 본 대화만 세는 쪽이 CLI 와 맞는다고 확인했다(확장 listSessionLogs 주석).
 */
async function listSessionLogs(dir: string, out: string[], depth = 0): Promise<string[]> {
  if (depth > 4) return out;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "subagents" || e.name === "workflows") continue;
      await listSessionLogs(join(dir, e.name), out, depth + 1);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

interface DayTally {
  messages: number;
  sessions: string[];
}

/**
 * 파일 하나의 [from, to) 사이 메시지 수와 대화 번호. 확장 scanRecentLogs 와 같은 줄 고르기:
 * user·assistant 줄만, 스트리밍 중 같은 응답이 여러 줄로 남은 것도 각각 센다(확장도 그렇다 — CLI 가 낸 값보다 조금 크게 나오지만
 * 오늘 칸 색 단계에만 쓰이고, 다음 날이면 캐시 값이 대신한다).
 */
function tallyDay(content: string, from: number, to: number): DayTally {
  let messages = 0;
  const sessions = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    // 값싼 거르기: 줄마다 JSON.parse 하는 것이 비싼 부분이다
    if (line.indexOf('"type":"assistant"') < 0 && line.indexOf('"type":"user"') < 0) continue;
    let rec: { type?: unknown; timestamp?: unknown; sessionId?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "assistant" && rec.type !== "user") continue;
    const ts = Date.parse(typeof rec.timestamp === "string" ? rec.timestamp : "");
    if (!ts || ts < from || ts >= to) continue;
    messages++;
    if (typeof rec.sessionId === "string" && rec.sessionId) sessions.add(rec.sessionId);
  }
  return { messages, sessions: [...sessions] };
}

// 파일별 셈 기억 — 대화 기록은 덧붙이기만 하므로 (크기, 수정 시각, 날짜)가 같으면 셈도 같다. 원문은 담지 않는다
const tallyCache = new Map<string, { size: number; mtimeMs: number; day: string; value: DayTally }>();

async function scanToday(now: number): Promise<{ messages: number; sessions: Set<string> }> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const from = start.getTime();
  const to = end.getTime();
  const todayKey = dayKey(start);
  // 기록은 덧붙이기만 하므로 오늘 자정 전에 마지막으로 바뀐 파일엔 오늘 기록이 없다(확장과 같은 1시간 여유를 둔다).
  // 확장은 사용량 탭 24시간 기여도 때문에 25시간 안 파일을 다 열지만, 통계 탭이 쓰는 "오늘" 셈은 이것으로 같은 값이 나온다
  const mtimeFloor = from - MTIME_SLACK_MS;

  const res = { messages: 0, sessions: new Set<string>() };
  const files = await listSessionLogs(join(claudeDir(), "projects"), []);
  const seen = new Set<string>();
  for (const file of files) {
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (info.mtimeMs < mtimeFloor) continue;
    seen.add(file);
    let tally: DayTally;
    const hit = tallyCache.get(file);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs && hit.day === todayKey) {
      tally = hit.value;
    } else {
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      tally = tallyDay(content, from, to);
      tallyCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, day: todayKey, value: tally });
    }
    res.messages += tally.messages;
    for (const s of tally.sessions) res.sessions.add(s);
  }
  for (const key of tallyCache.keys()) if (!seen.has(key)) tallyCache.delete(key);
  return res;
}

// ── 모으기 ───────────────────────────────────────────────────────────────────

function emptyView(todayKey: string): ClaudeStatsView {
  return {
    available: false,
    totalTokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    sessions: 0,
    activeDays: 0,
    windowDays: 0,
    longestSessionMs: 0,
    longestStreak: 0,
    currentStreak: 0,
    mostActiveDay: "",
    favoriteModelLabel: "",
    byModel: [],
    daily: [],
    costUSD: 0,
    hasUnknownRate: false,
    lastComputedDate: "",
    today: todayKey,
  };
}

/** 확장 collectClaudeStats 의 lifetime 부분 그대로(642~726줄). 순수 함수 — 시험이 디스크 없이 부른다 */
export function buildStatsView(cache: RawStatsCache | null, today: { messages: number; sessions: Set<string> }, now: number): ClaudeStatsView {
  const todayKey = dayKey(new Date(now));
  const stats = emptyView(todayKey);
  if (!cache) return stats;
  stats.lastComputedDate = typeof cache.lastComputedDate === "string" ? cache.lastComputedDate : "";

  const mu = cache.modelUsage || {};
  const shares: ModelShare[] = [];
  for (const [model, v] of Object.entries(mu)) {
    if (!v || typeof v !== "object") continue;
    const tokens = (v.inputTokens || 0) + (v.outputTokens || 0) + (v.cacheReadInputTokens || 0) + (v.cacheCreationInputTokens || 0);
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
        // 요약 파일엔 5분/1시간 구분이 없다 — 전부 1시간 단가(09-30 결정, rates.ts)
        cacheWriteCost(v.cacheCreationInputTokens || 0, 0, rate);
      stats.costUSD += costUSD;
    }
    // 확장 ModelShare 에는 unknownRate 가 없어 단가 모름 모델이 설명 글에 $0.00 으로 나온다 — 여기선 "단가 모름"으로 보이려고 싣는다
    shares.push({ model, label: getShortModelName(model) || model, tokens, percent: 0, costUSD, unknownRate: !rate });
  }
  stats.totalTokens = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
  for (const s of shares) s.percent = stats.totalTokens ? Math.round((100 * s.tokens) / stats.totalTokens) : 0;
  shares.sort((a, b) => b.tokens - a.tokens);
  stats.byModel = shares;
  stats.favoriteModelLabel = shares.length ? shares[0].label : "";

  stats.longestSessionMs = cache.longestSession?.duration || 0;

  // 날짜별 활동 + 오늘 줄. 캐시는 lastComputedDate 에서 멈춰 오늘이 늘 빠져 있어 직접 센다(확장 주석: 셈이 CLI 값과 꼭 같지는
  // 않지만 오늘 칸 색 단계에만 쓰이고, 다음 날이면 캐시 값이 대신한다)
  const rows = (Array.isArray(cache.dailyActivity) ? cache.dailyActivity : [])
    .filter((d) => d && typeof d.date === "string")
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const daily: { date: string; count: number }[] = rows.filter((d) => d.date < todayKey).map((d) => ({ date: d.date, count: d.messageCount || 0 }));

  const cachedToday = rows.find((d) => d.date === todayKey);
  const todayCount = Math.max(cachedToday?.messageCount || 0, today.messages);
  if (todayCount > 0) daily.push({ date: todayKey, count: todayCount });

  const level = heatLevels(daily.map((d) => d.count));
  stats.daily = daily.map((d) => ({ date: d.date, count: d.count, level: level(d.count) }));

  stats.activeDays = daily.length;
  stats.windowDays = daily.length ? daysBetween(daily[0].date, todayKey) + 1 : 0;

  const st = streaks(
    daily.map((d) => d.date),
    todayKey,
  );
  stats.longestStreak = st.longest;
  stats.currentStreak = st.current;

  const busiest = daily.slice().sort((a, b) => b.count - a.count)[0];
  stats.mostActiveDay = busiest ? busiest.date : "";

  // 캐시의 대화 수도 어제에서 멈춘다 — 오늘 만난 대화 수를 더해 하루 동안 따라가게 한다
  stats.sessions = (cache.totalSessions || 0) + (cachedToday ? 0 : today.sessions.size);

  stats.available = stats.totalTokens > 0 || daily.length > 0;
  return stats;
}

// 화면 여럿(PC 앱·웹·폰)이 같이 물어도 한 번만 읽는다: 최근 결과 SCAN_CACHE_MS 동안 재사용 + 읽는 중이면 그 결과를 나눠 쓴다
let cached: { at: number; value: { computedAt: number; stats: ClaudeStatsView } } | null = null;
let pending: Promise<{ computedAt: number; stats: ClaudeStatsView }> | null = null;

export async function collectClaudeStats(force = false): Promise<{ computedAt: number; stats: ClaudeStatsView }> {
  const now = Date.now();
  if (!force && cached && now - cached.at < SCAN_CACHE_MS) return cached.value;
  if (pending) return pending;
  const run = (async () => {
    const started = Date.now();
    const [today, cache] = await Promise.all([scanToday(started), readStatsCache()]);
    const value = { computedAt: started, stats: buildStatsView(cache, today, started) };
    cached = { at: started, value };
    return value;
  })();
  pending = run;
  try {
    return await run;
  } finally {
    if (pending === run) pending = null;
  }
}
