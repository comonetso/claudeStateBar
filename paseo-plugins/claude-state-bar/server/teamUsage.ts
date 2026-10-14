import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import { hashAccountKey, toneFromUsedPct, unavailable, windowFromUsedPct, type UsageReport, type UsageWindow } from "@getpaseo/plugin/server/usage";
import { readProviders, TEAM_PROVIDER } from "./account";
import { TEAM_USAGE_SOURCE_ID } from "../shared/account";

// 팀 공급자(claude-yeogiaen) 한도를 Paseo 사용량 목록에 늘 올린다(10-15 리규형님 "Claude 공급자가 여러 개면 한도 상황판에
// 언제든 표시"). Paseo 의 내장 Claude 사용량 원천은 데몬 자신의 로그인(~/.claude)만 찾아서, 다른 설정 폴더로 로그인한
// 팀 공급자는 그 공급자로 연 대화가 있을 때조차 화면에 안 나왔다. 그래서 같은 데몬 목록에 원천을 하나 더 등록한다 — 데몬은
// 그 목록을 모든 화면에 주고, 사용량 칸은 소리 담당 PC 의 목록을 모든 기기가 같이 쓴다(PC 앱·웹·폰).
// 막대 규칙은 Paseo 0.11.1 내장 claude-usage-source 와 같다: five_hour → 5h · seven_day → wk · limits[] 의 모델·영역별 주간 → "wk 이름".
// 로그인은 팀 공급자 설정의 CLAUDE_CONFIG_DIR(.credentials.json)만 읽고 쓰지 않는다 — 토큰 갱신은 그 Claude 가 한다.
// 서버의 팀 공급자는 1년 열쇠(CLAUDE_CODE_OAUTH_TOKEN)인데 그 열쇠로는 한도 조회가 429 로 막혀(10-15 콜어드민 실측) 찾지 않는다.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20"; // 내장 원천과 같은 값

const inputSchema = z.object({ dir: z.string().min(1) }).strict();
const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().optional(), expiresAt: z.number().optional(), subscriptionType: z.string().optional() }).optional(),
});
const accountSchema = z.object({ oauthAccount: z.object({ emailAddress: z.string().optional(), accountUuid: z.string().optional() }).optional() });
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
function teamDir(): string | null {
  const dir = readProviders()[TEAM_PROVIDER]?.env?.CLAUDE_CONFIG_DIR;
  return typeof dir === "string" && dir.trim() ? dir.trim() : null;
}

function readLogin(dir: string) {
  const parsed = credentialsSchema.safeParse(readJson(join(dir, ".credentials.json")));
  return parsed.success ? parsed.data.claudeAiOauth ?? null : null;
}

/** 팀 공급자 이름(Paseo 설정 label) — 카드 제목. 리규형님 결정: "팀·개인" 말고 공급자 이름 그대로 */
export function teamUsageLabel(): string {
  const v = readProviders()[TEAM_PROVIDER]?.label;
  return typeof v === "string" && v.trim() ? v.trim() : TEAM_PROVIDER;
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

export function teamUsageSource(): UsageSourceRegistration {
  return {
    id: TEAM_USAGE_SOURCE_ID,
    label: teamUsageLabel(),
    input: inputSchema,
    async discover() {
      const dir = teamDir();
      if (!dir || !existsSync(join(dir, ".credentials.json")) || !readLogin(dir)?.accessToken) return [];
      const account = accountSchema.safeParse(readJson(join(dir, ".claude.json")));
      const who = account.success ? account.data.oauthAccount : undefined;
      // 카드 제목에 메일을 붙이지 않는다 — 공급자 이름("Claude (como)")이 이미 계정을 가리킨다(10-15 리규형님 "너무 길어")
      return [{ key: hashAccountKey(who?.accountUuid ?? dir), input: { dir } }];
    },
    async fetch(input): Promise<UsageReport> {
      const { dir } = inputSchema.parse(input);
      const login = readLogin(dir);
      if (!login?.accessToken) return { status: "error", error: "팀 공급자 로그인이 없습니다" };
      if (login.expiresAt !== undefined && login.expiresAt <= Date.now()) return unavailable({ kind: "expired", expiresAt: new Date(login.expiresAt).toISOString() });
      const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${login.accessToken}`, "anthropic-beta": OAUTH_BETA } });
      if (!res.ok) return unavailable({ kind: "rejected", status: res.status });
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return { status: "error", error: "한도 응답 형식을 읽지 못했습니다" };
      const plan = login.subscriptionType ? login.subscriptionType.charAt(0).toUpperCase() + login.subscriptionType.slice(1) : undefined;
      return { status: "available", ...(plan ? { planLabel: plan } : {}), windows: windowsOf(parsed.data) };
    },
  };
}
