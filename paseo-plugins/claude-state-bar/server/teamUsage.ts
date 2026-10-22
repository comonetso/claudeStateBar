import { renameRetry } from "./renameRetry";
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import { hashAccountKey, toneFromUsedPct, unavailable, windowFromUsedPct, type UsageReport, type UsageWindow } from "@getpaseo/plugin/server/usage";
import { claudeProviders } from "./account";
import { teamUsageSourceId } from "../shared/account";
import { accountOrgKey } from "../shared/usageIdentity";
import { tokenProviders, usageLoginDir } from "./usageLogin";

// 팀 공급자(claude-yeogiaen) 한도를 Paseo 사용량 목록에 늘 올린다(10-15 리규형님 "Claude 공급자가 여러 개면 한도 상황판에
// 언제든 표시"). Paseo 의 내장 Claude 사용량 원천은 데몬 자신의 로그인(~/.claude)만 찾아서, 다른 설정 폴더로 로그인한
// 팀 공급자는 그 공급자로 연 대화가 있을 때조차 화면에 안 나왔다. 그래서 같은 데몬 목록에 원천을 하나 더 등록한다 — 데몬은
// 그 목록을 모든 화면에 주고, 사용량 칸은 소리 담당 PC 의 목록을 모든 기기가 같이 쓴다(PC 앱·웹·폰).
// 막대 규칙은 Paseo 0.11.1 내장 claude-usage-source 와 같다: five_hour → 5h · seven_day → wk · limits[] 의 모델·영역별 주간 → "wk 이름".
// 로그인은 팀 공급자 설정의 CLAUDE_CONFIG_DIR(.credentials.json). 처음엔 읽기만 하고 갱신은 그 Claude 에 맡겼는데, PC 에서 팀
// 대화를 안 쓰면 몇 시간짜리 열쇠가 그대로 만료돼 카드가 사라졌다(10-15 08:34 만료 → 401). 리규형님 결정(10-15): 만료됐거나
// 401 이면 플러그인이 Claude Code 와 같은 방식으로 갱신해 그 파일에 써 넣는다(refreshTeamLogin). 이 파일은 PC 에서만 쓰인다.
// 서버의 팀 공급자는 1년 열쇠(CLAUDE_CODE_OAUTH_TOKEN)인데 그 열쇠로는 한도 조회가 429 로 막혀(10-15 콜어드민 실측) 찾지 않는다.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20"; // 내장 원천과 같은 값

// Claude Code 2.x 본체(claude.exe)의 운영 설정과 갱신 요청을 그대로 옮겼다(10-15 확인): TOKEN_URL · CLIENT_ID ·
// JSON 본문 { grant_type, refresh_token, client_id, scope: 공백으로 이은 scopes } · 응답 { access_token, refresh_token?, expires_in(초) }
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_EARLY_MS = 60_000; // 만료 1분 전부터 갱신한다(조회 도중 만료되지 않게)

const inputSchema = z.object({ dir: z.string().min(1) }).strict();
const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().optional(), refreshToken: z.string().optional(), expiresAt: z.number().optional(), scopes: z.array(z.string()).optional(), subscriptionType: z.string().optional() }).passthrough().optional(),
}).passthrough();
const tokenResponseSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.coerce.number().positive() });
const windowSchema = z.object({ utilization: z.coerce.number().finite(), resets_at: z.string().nullish() });
const responseSchema = z.object({ five_hour: windowSchema.nullish(), seven_day: windowSchema.nullish(), limits: z.array(z.unknown()).nullish() });
const nameSchema = z.object({ id: z.string().nullish(), display_name: z.string().nullish() }).nullish();
const limitSchema = z.object({
  kind: z.string(),
  percent: z.coerce.number().finite().nullish(),
  resets_at: z.string().nullish(),
  scope: z.object({ model: nameSchema, surface: nameSchema }).nullish(),
});

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 이 기기 팀 공급자의 로그인 폴더 — 없으면 null(서버처럼 열쇠로만 들어가는 곳) */
function teamDir(provider: string): string | null {
  const dir = claudeProviders()[provider]?.env?.CLAUDE_CONFIG_DIR;
  return typeof dir === "string" && dir.trim() ? dir.trim() : null;
}

function readLogin(dir: string) {
  const parsed = credentialsSchema.safeParse(readJson(join(dir, ".credentials.json")));
  return parsed.success ? parsed.data.claudeAiOauth ?? null : null;
}

const refreshing = new Map<string, Promise<string | null>>();

/**
 * 팀 로그인 갱신 — 새 액세스 열쇠를 돌려준다(실패하면 null, 이유는 로그에만 · 열쇠 값은 어디에도 남기지 않는다).
 * 같은 데몬 안 동시 조회는 한 번만 갱신한다. 보내기 전에 파일을 다시 읽어 이미 새 열쇠면 그것을 쓰고, 쓰기 직전에도 다시 읽어
 * 그사이 팀 Claude 가 먼저 바꿨으면(갱신용 열쇠가 달라짐) 덮어쓰지 않고 파일 값을 쓴다. 쓰기는 임시 파일 → 이름 바꾸기.
 */
export function refreshTeamLogin(dir: string, log: (m: string) => void = () => {}): Promise<string | null> {
  const pending = refreshing.get(dir);
  if (pending) return pending;
  const running = (async () => {
    const path = join(dir, ".credentials.json");
    const fresh = (o: ReturnType<typeof readLogin>) => !!o?.accessToken && (o.expiresAt === undefined || o.expiresAt - REFRESH_EARLY_MS > Date.now());
    const before = readLogin(dir);
    if (fresh(before)) return before!.accessToken!;
    if (!before?.refreshToken) { log("[team-usage] no refresh token"); return null; }
    const body = { grant_type: "refresh_token", refresh_token: before.refreshToken, client_id: CLIENT_ID, ...(before.scopes?.length ? { scope: before.scopes.join(" ") } : {}) };
    const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status !== 200) {
      log(`[team-usage] refresh failed HTTP ${res.status}`);
      const now = readLogin(dir); // 팀 Claude 가 같은 순간 먼저 바꿔 우리 갱신용 열쇠가 폐기됐을 수 있다
      return fresh(now) ? now!.accessToken! : null;
    }
    const tok = tokenResponseSchema.safeParse(await res.json().catch(() => null));
    if (!tok.success) { log("[team-usage] refresh response unreadable"); return null; }
    const raw = readJson(path) as Record<string, unknown> | null;
    const current = credentialsSchema.safeParse(raw);
    if (!current.success || current.data.claudeAiOauth?.refreshToken !== before.refreshToken) {
      log("[team-usage] login file changed during refresh — keeping the file's value");
      const now = readLogin(dir);
      return fresh(now) ? now!.accessToken! : tok.data.access_token;
    }
    const next = { ...current.data, claudeAiOauth: { ...current.data.claudeAiOauth, accessToken: tok.data.access_token, refreshToken: tok.data.refresh_token ?? before.refreshToken, expiresAt: Date.now() + tok.data.expires_in * 1000 } };
    const tmp = `${path}.${process.pid}.tmp`;
    let mode = 0o600;
    try { mode = statSync(path).mode & 0o777; } catch { /* 없으면 600 */ }
    writeFileSync(tmp, JSON.stringify(next), { mode });
    try { chmodSync(tmp, mode); } catch { /* Windows */ }
    let changed = false;
    try {
      await renameRetry(tmp, path, { beforeAttempt: () => {
        if (readLogin(dir)?.refreshToken !== before.refreshToken) { changed = true; throw new Error("login file changed during rename retry"); }
      } });
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* 이미 없음 */ }
      if (!changed) throw error;
      const now = readLogin(dir);
      return fresh(now) ? now!.accessToken! : tok.data.access_token;
    }
    log(`[team-usage] refreshed, valid until ${new Date(next.claudeAiOauth.expiresAt).toISOString()}`);
    return tok.data.access_token;
  })().catch(() => { log("[team-usage] refresh error"); return null; }).finally(() => { refreshing.delete(dir); });
  refreshing.set(dir, running);
  return running;
}

/** 팀 공급자 이름(Paseo 설정 label) — 카드 제목. 리규형님 결정: "팀·개인" 말고 공급자 이름 그대로 */
export function teamUsageLabel(provider: string): string {
  const v = claudeProviders()[provider]?.label;
  return typeof v === "string" && v.trim() ? v : provider === "claude" ? "Claude" : provider;
}

function windowsOf(resp: z.infer<typeof responseSchema>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const unscoped = [
    { w: resp.five_hour, id: "five_hour", label: "Session", shortLabel: "5h" },
    { w: resp.seven_day, id: "weekly", label: "Weekly", shortLabel: "wk" },
  ];
  for (const s of unscoped) {
    if (!s.w) continue;
    windows.push(windowFromUsedPct({ id: s.id, label: s.label, shortLabel: s.shortLabel, summary: true, utilizationPct: s.w.utilization, resetsAt: s.w.resets_at ?? null, tone: toneFromUsedPct(s.w.utilization) }));
  }
  const taken = new Set(windows.map((w) => w.id));
  for (const raw of resp.limits ?? []) {
    const limit = limitSchema.safeParse(raw);
    if (!limit.success || limit.data.kind !== "weekly_scoped") continue;
    const scope = limit.data.scope?.model ?? limit.data.scope?.surface;
    const name = scope?.display_name ?? scope?.id;
    if (!name) continue;
    let id = `weekly_${limit.data.scope?.model ? "model" : "surface"}_${scope?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    for (let n = 2; taken.has(id); n++) id = `${id}_${n}`;
    taken.add(id);
    const pct = limit.data.percent ?? null;
    windows.push(windowFromUsedPct({ id, label: `Weekly · ${name}`, shortLabel: `wk ${name}`, utilizationPct: pct, resetsAt: limit.data.resets_at ?? null, tone: toneFromUsedPct(pct) }));
  }
  return windows;
}

export function teamUsageSources(): UsageSourceRegistration[] {
  // 1년 열쇠 공급자는 사용량 보기용 로그인을 먼저 본다(10-22 — tokenUsageSource). 팀원 데몬은 그 목록이 비어 예전처럼 실행기 기록만
  const usageLogin = new Set(tokenProviders());
  return Object.keys(claudeProviders()).flatMap((id) => (teamDir(id) !== null ? [teamUsageSource(id)]
    : usageLogin.has(id) ? [tokenUsageSource(id)] : tokenTeam(id) ? [poolUsageSource(id)] : []));
}

// 서버처럼 1년 열쇠(CLAUDE_CODE_OAUTH_TOKEN)로만 들어가는 팀 공급자는 한도 조회가 429 로 막혀 위 원천을 못 쓴다. 그래서 PC 가 절전하면
// 사용량 칸에서 como·hrg 카드가 사라졌다(10-16 리규형님 [66]). 리규형님 결정 [69]: 서버에 로그인을 따로 두지 않고 실행기 기록으로 —
// 무중단 작업(10-16) 실행기가 Claude 의 사용률 신호·넘김 탐침으로 남긴 좌석 관측을 감독자(claude-work-supervisor)가 모은
// claude-work/pool.json 으로 카드를 만든다. 마지막으로 본 값이라 그 뒤 쓴 양은 모른다 — 창이 지났으면 0% 를 지어내지 않고 "초기화됨"으로만 적는다.
// 이 파일은 리규형님 서버에만 있다(없으면 카드도 없다)
const POOL_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-work", "pool.json");
const poolInputSchema = z.object({ provider: z.string().min(1) }).strict();
const poolSeatSchema = z.object({
  pct: z.number().finite().nullish(),
  resetsAt: z.number().finite().nullish(),
  observedAt: z.string().nullish(),
  status: z.string().nullish(),
  limitType: z.string().nullish(),
  limitReset: z.number().finite().nullish(),
  week: z.object({ pct: z.number().finite(), resetsAt: z.number().finite() }).nullish(),
}).passthrough();
const tokenTeam = (provider: string) => typeof claudeProviders()[provider]?.env?.CLAUDE_CODE_OAUTH_TOKEN === "string";
function poolSeat(provider: string) {
  const doc = readJson(POOL_FILE) as { seats?: Record<string, unknown> } | null;
  const parsed = poolSeatSchema.safeParse(doc?.seats?.[provider]);
  return parsed.success ? parsed.data : null;
}
export function poolUsageReport(seat: z.infer<typeof poolSeatSchema>, now = Date.now()): UsageReport {
  const windows: UsageWindow[] = [];
  const reset = typeof seat.resetsAt === "number" ? seat.resetsAt * 1000 : null;
  const live = reset !== null && reset > now;
  // 거절은 그 창에만 — 주간 거절을 5시간 100% 로 덮지 않는다(Codex 리뷰 261016_182309). 5시간 거절이거나 종류를 모르면 5시간 100%
  const weeklyLimit = seat.status === "limit" && /seven_day|week/i.test(seat.limitType ?? "");
  const pct = seat.status === "limit" && !weeklyLimit ? 100 : seat.pct ?? null;
  // 창이 지났거나 사용률을 모르면 "—" 막대를 남긴다 — 창이 하나도 없으면 사용량 칸(usageFooter availableProviders)이 카드를 통째로 뺀다
  windows.push(windowFromUsedPct({ id: "five_hour", label: "Session", shortLabel: "5h", summary: true, utilizationPct: live ? pct : null,
    resetsAt: live ? new Date(reset).toISOString() : null, tone: live && pct !== null ? toneFromUsedPct(pct) : undefined }));
  const weekReset = seat.week?.resetsAt ?? (weeklyLimit ? seat.limitReset ?? null : null);
  if (typeof weekReset === "number" && weekReset * 1000 > now) {
    const wpct = weeklyLimit ? 100 : seat.week?.pct ?? null;
    windows.push(windowFromUsedPct({ id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, utilizationPct: wpct, resetsAt: new Date(weekReset * 1000).toISOString(), tone: wpct !== null ? toneFromUsedPct(wpct) : undefined }));
  }
  const at = seat.observedAt ? Date.parse(seat.observedAt) : NaN;
  const ago = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
  const when = ago === null ? "모름" : ago < 60 ? `${ago}분 전` : `${Math.floor(ago / 60)}시간 ${ago % 60}분 전`;
  return { status: "available", windows, details: [{ id: "observed", label: "관측", value: live || reset === null ? when : `${when} · 그 뒤 5시간 창 초기화됨` }] };
}
function poolUsageSource(provider: string): UsageSourceRegistration {
  return {
    id: teamUsageSourceId(provider),
    label: teamUsageLabel(provider),
    input: poolInputSchema,
    async discover() {
      return poolSeat(provider) ? [{ key: hashAccountKey(`pool:${provider}`), input: { provider } }] : [];
    },
    async fetch(input): Promise<UsageReport> {
      const seat = poolSeat(poolInputSchema.parse(input).provider);
      return seat ? poolUsageReport(seat) : { status: "error", error: "좌석 관측이 아직 없습니다" };
    },
  };
}

// 1년 열쇠 공급자의 사용량 보기용 로그인(10-22 리규형님 — server/usageLogin): 그 폴더에 로그인이 있으면 PC 팀 카드와 같은 방법(계정 확인·
// 사용량 조회·만료 갱신)으로 읽고, 없으면 위 실행기 기록으로. 데몬은 원천을 플러그인이 뜰 때 한 번 등록하므로, 로그인을 나중에 해도
// 플러그인을 다시 읽지 않고 바뀌게 묻을 때마다 고른다. 대화 범위 발견에는 내지 않는다(10-18 2차 — 팀 카드는 전역 발견에만)
const tokenInputSchema = z.union([inputSchema, poolInputSchema]);
export function tokenUsageSource(provider: string, dir: string = usageLoginDir(provider)): UsageSourceRegistration {
  const pool = poolUsageSource(provider);
  return {
    id: teamUsageSourceId(provider),
    label: teamUsageLabel(provider),
    input: tokenInputSchema,
    async discover(scope?: DiscoverScope) {
      if (scope?.kind === "session") return [];
      const found = await discoverLogin(dir);
      return found.length ? found : pool.discover();
    },
    async fetch(input): Promise<UsageReport> {
      const parsed = tokenInputSchema.parse(input);
      return "dir" in parsed ? fetchTeamReport(parsed.dir) : pool.fetch(parsed);
    },
  };
}

// 사용량 보기용 로그인 유지(10-22). 이 폴더는 사용량을 물을 때만 쓰이는데, PC 가 켜져 있으면 서버 사용량을 묻는 화면이 거의 없어 며칠이고
// 안 쓰인다 — 그사이 갱신용 열쇠까지 묵어 풀리면 정작 PC 가 꺼졌을 때 카드가 안 나온다. 그래서 데몬 플러그인이 파일만 보고 액세스 열쇠가
// 곧 만료면(REFRESH_EARLY_MS) 미리 바꿔 둔다 — 바깥 사용량 조회는 없고 열쇠 바꾸는 요청만, 열쇠 수명마다 한 번꼴. 보는 주기 30초는 사용량 칸
// 주기·개인 로그인 유지(keepPersonalLogin)와 같은 값이고, 실패하면 사용량 칸(client/usageFooter POLL_STEPS_MS)처럼 1분·2분으로 물러난다
// (성공하면 처음으로). 실패가 이어져도 기록은 처음 한 번만 남긴다 — 갱신용 열쇠가 죽었으면 설정 화면에서 다시 로그인한다
const KEEP_STEPS_MS = [30_000, 60_000, 120_000];
export function startUsageLoginKeeper(
  dirs: () => string[] = () => tokenProviders().map(usageLoginDir),
  log: (m: string) => void = console.warn,
  now: () => number = Date.now,
): { stop: () => void; tick: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fails = new Map<string, number>(); // 폴더 → 이어진 실패 수
  const nextAt = new Map<string, number>(); // 폴더 → 다음 시도 시각(물러나는 중일 때만)
  const tick = async () => {
    for (const dir of dirs()) {
      const login = readLogin(dir);
      if (!login?.accessToken || !login.refreshToken) continue;
      if (login.expiresAt === undefined || login.expiresAt - REFRESH_EARLY_MS > now()) continue;
      if ((nextAt.get(dir) ?? 0) > now()) continue;
      const n = fails.get(dir) ?? 0;
      const token = await refreshTeamLogin(dir, n === 0 ? (m) => log(m.replace("[team-usage]", "[usage-login]")) : () => {});
      if (token) {
        fails.delete(dir);
        nextAt.delete(dir);
      } else {
        fails.set(dir, n + 1);
        nextAt.set(dir, now() + KEEP_STEPS_MS[Math.min(n + 1, KEEP_STEPS_MS.length - 1)]);
      }
    }
  };
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick().catch(() => {}).finally(loop), KEEP_STEPS_MS[0]);
  };
  loop();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
  };
}

// 팀 카드의 계정 열쇠 = 내장 Claude 원천과 같은 `계정uuid.조직uuid`(10-18 C2 — shared/usageIdentity). 사용량 칸이 이 열쇠로 같은 계정의
// 내장 카드를 숨긴다. 그래서 파일(.claude.json)에 적힌 값이 아니라 지금 열쇠로 /api/oauth/profile 에 물어 확인한 값만 쓴다 — 열쇠의
// 활성 조직이 파일과 다를 수 있다(Codex 261018_052815 C2). 묻는 방법·헤더·15초 제한은 내장 원천 readProfile(설치본 usage.ts:654-698)과 같다.
// 확인 결과는 열쇠 세대(액세스 열쇠 해시)별로 5분 기억한다 — 내장 원천 PROFILE_TTL_MS(300000)와 같은 값. 데몬은 사용량을 물을 때마다
// discover 를 부르므로(사용량 칸 30초) 기억 없이 두면 profile 을 30초마다 두드린다. 실패(401·403·그 밖 응답·네트워크·형식)도 같은 시간
// "미확인"으로 기억한다 — 미확인이면 내장 카드를 숨기지 않으니(두 장 그대로) 늦게 풀려도 카드가 사라지지는 않는다. 열쇠가 바뀌면 다시 묻는다.
// 만료된 열쇠로는 묻지 않는다(내장 원천과 같게) — 사용량 조회(fetchTeamReport)가 열쇠를 갱신한 뒤 다음 discover 에서 확인된다
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const IDENTITY_TTL_MS = 300_000;
const PROFILE_TIMEOUT_MS = 15_000;
const profileSchema = z.object({ account: z.object({ uuid: z.string().min(1) }), organization: z.object({ uuid: z.string().min(1) }) });
const identities = new Map<string, { tokenHash: string; at: number; result: Promise<string | null> }>();

/** 팀 로그인 폴더의 지금 열쇠로 확인한 계정+조직 열쇠 — 확인 못 하면 null. 열쇠 값은 어디에도 남기지 않는다(해시만 비교) */
export function resolveUsageIdentity(dir: string, fetchApi: typeof fetch = fetch, now: () => number = Date.now): Promise<string | null> {
  return resolveIdentityGeneration(dir, fetchApi, now).then((r) => r.key);
}
/** 위와 같고, 그 확인에 쓴(또는 쓰려던) 열쇠 세대(액세스 열쇠 해시)를 함께 — 같은 열쇠 한 번 읽기로 둘을 묶어, 조회 도중 파일이 바뀌어도
 *  "어느 열쇠로 확인한 결과인지"가 어긋나지 않는다(10-18 Codex 261018_164051 F4). 열쇠가 없으면 세대도 null */
function resolveIdentityGeneration(dir: string, fetchApi: typeof fetch, now: () => number): Promise<{ key: string | null; generation: string | null }> {
  const login = readLogin(dir);
  const token = login?.accessToken;
  if (!token) return Promise.resolve({ key: null, generation: null });
  const tokenHash = hashAccountKey(token);
  const withGen = (result: Promise<string | null>) => result.then((key) => ({ key, generation: tokenHash }));
  if (login?.expiresAt !== undefined && login.expiresAt <= now()) return Promise.resolve({ key: null, generation: tokenHash });
  const cached = identities.get(dir);
  if (cached && cached.tokenHash === tokenHash && now() - cached.at < IDENTITY_TTL_MS) return withGen(cached.result);
  const result = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
    try {
      const res = await fetchApi(PROFILE_URL, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "anthropic-beta": OAUTH_BETA },
      });
      if (!res.ok) return null;
      const parsed = profileSchema.safeParse(await res.json().catch(() => null));
      return parsed.success ? accountOrgKey(parsed.data.account.uuid, parsed.data.organization.uuid) : null;
    } finally {
      clearTimeout(timer);
    }
  })().catch(() => null);
  identities.set(dir, { tokenHash, at: now(), result });
  return withGen(result);
}

// 팀 카드가 두 장 나오던 것(10-18 2차 — 1차 검증 2 지적 3). 설치본 데몬(0.11.4 server/plugins/usage-sources/index.js)은
// ① 대화 범위 발견(discoverAgent, 81-110줄) 결과를 그 대화가 같은 세션인 동안 다시 묻지 않고 그대로 쓰고(sameScope 88-92줄),
// ② 전역 발견 결과와 보고 번호로 합친다(mergeKnown 111-131줄). 그래서 대화 범위 발견이 "미확인"(대체 열쇠) 순간에 일어나고
// 뒤에 전역 발견이 "확인됨"(계정uuid.조직uuid)이면 두 번호가 함께 남아 같은 팀 카드가 두 장이 됐다.
// 고침: 팀 카드는 전역 발견에만 낸다(대화 범위면 빈 목록). 전역 결과는 데몬이 사용량을 물을 때마다 통째로 새로 만들므로(listReports 58줄)
// 열쇠가 바뀌어도 옛 번호가 남지 않는다. 팀 공급자 대화의 대화별 사용량은 내장 Claude 원천이 그 대화의 로그인 폴더로 같은 계정 카드를
// 이미 만든다(Claude 대화는 provider "claude" 로 넘어온다 — 설치본 providers/claude/agent.js usageSession). 그래서 대화 범위에서
// 빠져도 그 계정의 사용량은 사라지지 않고, 개인·Codex 대화의 대화별 목록에 상관없는 팀 카드가 끼던 것도 없어진다.
// 보조: 한 번 확인한 열쇠는 같은 로그인 열쇠 세대 동안 그 폴더의 열쇠로 쓴다(아래 verifiedKeys) — SDK 약속 "열쇠는 고정"(plugin
// server/usage.d.ts UsageAccount.key). 5분 기억이 풀린 뒤 같은 열쇠로 profile 이 한 번 실패(429·네트워크)해도 전역 카드 번호가 대체 열쇠로
// 바뀌지 않아, 데몬 5분 기억(번호가 기억 열쇠에 들어감 — fetchId 192줄)이 깨져 사용량을 다시 묻거나 거르기가 잠깐 꺼지지 않는다.
// 이 세대에서 확인하지 못했으면 대체 열쇠(계정+조직 모양이 아니라 어떤 카드도 숨기지 않음)를 쓴다.
// 고정 열쇠는 그것을 확인한 열쇠 세대(액세스 열쇠 해시)가 지금과 같을 때만 쓴다 — 5분 기억이 풀린 뒤 같은 열쇠로 다시 물어 실패한
// 경우·열쇠가 만료된 경우만 덮는다. 열쇠가 바뀐 뒤(갱신·다시 로그인·조직 바꾸기) 확인이 실패하면 대체 열쇠로 내려가 잠깐 두 장이 보인다
// (안전한 쪽). 10-18 보수 2차 검증·Codex 261018_164051 F4: 계정 번호만 비교하면 같은 계정에서 조직만 바뀐 뒤 확인이 실패할 때 옛 조직
// 열쇠를 새 조직 사용량에 붙여 옛 조직의 진짜 카드를 숨겼다. .claude.json 의 조직은 실제 활성 조직의 권위가 아니라 쓰지 않는다
const verifiedKeys = new Map<string, { key: string; generation: string }>();
type DiscoverScope = { kind?: string } | undefined;

/** 그 로그인 폴더의 계정 하나(로그인이 없으면 빈 목록) — PC 팀 공급자 폴더와 서버 사용량 보기용 폴더(server/usageLogin)가 같이 쓴다 */
async function discoverLogin(dir: string): Promise<Array<{ key: string; input: { dir: string } }>> {
  if (!existsSync(join(dir, ".credentials.json")) || !readLogin(dir)?.accessToken) return [];
  // 카드 제목에 메일을 붙이지 않는다 — 공급자 이름("Claude (como)")이 이미 계정을 가리킨다(10-15 리규형님 "너무 길어")
  const { key: identity, generation } = await resolveIdentityGeneration(dir, fetch, Date.now);
  if (identity && generation) verifiedKeys.set(dir, { key: identity, generation });
  const kept = verifiedKeys.get(dir);
  const keptKey = kept && generation && kept.generation === generation ? kept.key : undefined;
  return [{ key: identity ?? keptKey ?? hashAccountKey(`unknown:${dir}`), input: { dir } }];
}

export function teamUsageSource(provider: string): UsageSourceRegistration {
  return {
    id: teamUsageSourceId(provider),
    label: teamUsageLabel(provider),
    input: inputSchema,
    // 데몬은 discover(scope) 로 부른다(index.js 143줄) — 이 SDK 판(0.11.0-beta.3) 타입에는 인자가 없어 선택 인자로 받는다
    async discover(scope?: DiscoverScope) {
      if (scope?.kind === "session") return [];
      const dir = teamDir(provider);
      return dir ? discoverLogin(dir) : [];
    },
    async fetch(input): Promise<UsageReport> {
      return fetchTeamReport(inputSchema.parse(input).dir);
    },
  };
}

async function fetchTeamReport(dir: string): Promise<UsageReport> {
  const login = readLogin(dir);
  if (!login?.accessToken) return { status: "error", error: "팀 공급자 로그인이 없습니다" };
  let token: string | null = login.accessToken;
  if (login.expiresAt !== undefined && login.expiresAt - REFRESH_EARLY_MS <= Date.now()) {
    token = await refreshTeamLogin(dir, console.warn);
    if (!token) return unavailable({ kind: "expired", expiresAt: new Date(login.expiresAt).toISOString() });
  }
  const ask = (t: string) => fetch(USAGE_URL, { headers: { Authorization: `Bearer ${t}`, "anthropic-beta": OAUTH_BETA } });
  let res = await ask(token);
  if (res.status === 401) {
    // 만료 시각 전인데 거절 — 다른 곳에서 열쇠가 바뀌었거나 폐기됨. 한 번만 갱신하고 다시 묻는다
    const again = await refreshTeamLogin(dir, console.warn);
    if (again && again !== token) res = await ask(again);
  }
  if (!res.ok) return unavailable({ kind: "rejected", status: res.status });
  const parsed = responseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { status: "error", error: "한도 응답 형식을 읽지 못했습니다" };
  const plan = login.subscriptionType ? login.subscriptionType.charAt(0).toUpperCase() + login.subscriptionType.slice(1) : undefined;
  return { status: "available", ...(plan ? { planLabel: plan } : {}), windows: windowsOf(parsed.data) };
}

// 개인 계정 로그인(이 데몬의 기본 Claude 폴더)도 곧 만료면 미리 바꿔 둔다(10-17 리규형님) — 개인 카드는 Paseo 기본 Claude 원천이
// 이 폴더의 열쇠로 묻는데, 개인 계정으로 도는 Claude 가 없으면 아무도 안 바꿔 만료(401)되고 카드가 사라졌다(10-17 09:40).
// 바꾸는 방법·덮어쓰기 규칙은 팀과 같다(refreshTeamLogin). 새 열쇠는 데몬 기억(5분)이 풀린 다음 조회나 "지금 갱신"부터 쓰인다.
// 사용량 칸이 읽을 때마다(30초) 불러 만료 1분 전 창을 놓치지 않는다. 바깥 사용량 조회는 하지 않는다
const personalDir = () => (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"));

export async function keepPersonalLogin(): Promise<{ ok: boolean }> {
  // 팀 로그인 폴더가 있는 데몬(= 사용량 칸을 맡는 PC)에서만 — 서버의 개인 로그인은 서버 Claude 대화들이 직접 쓴다
  const hasTeam = Object.keys(claudeProviders()).some((provider) => teamDir(provider) !== null);
  const personal = personalDir();
  if (!hasTeam || !existsSync(join(personal, ".credentials.json"))) return { ok: false };
  const token = await refreshTeamLogin(personal, (m) => console.warn(m.replace("[team-usage]", "[personal-login]")));
  return { ok: token !== null };
}
