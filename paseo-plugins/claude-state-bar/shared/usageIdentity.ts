import { isTeamUsageSource } from "./account";

// 사용량 칸에 같은 계정 카드가 두 장 나오던 것(10-18 C2 — 리규형님 결정 "우리 팀 카드 남기기").
// 팀 공급자로 연 대화가 있으면 Paseo 내장 Claude 원천(claude-usage-source)이 그 대화의 로그인으로도 계정을 찾아 "Claude (메일)" 카드를
// 하나 더 만든다 — 우리 팀 카드(server/teamUsage)와 같은 계정이다. 같은 계정인지는 메일·이름이 아니라 계정+조직 번호로만 본다
// (Codex 261018_052815 C2 — 같은 메일·다른 조직이 있다). 내장 원천의 계정 열쇠는 /api/oauth/profile 의 `계정uuid.조직uuid`
// (설치본 builtin-plugins/claude-usage-source/server/usage.ts:680-690)이고, 우리 팀 원천도 같은 방식으로 확인한 값만 그 열쇠로 쓴다.
// 데몬은 보고 번호를 `원천id:계정열쇠`로 만들고(설치본 0.11.4 server/plugins/usage-sources/index.js:145) 옛 목록(providers.listUsage)에는
// 원천 id 만 남긴다(같은 파일 177줄) — 그래서 판정은 원본 보고(listUsageReports)로 하고, 거른 뒤 옛 목록과 같은 모양으로 바꿔 쓴다.
// 우리 팀 카드가 정상(사용량을 읽었고 창이 있음)일 때만 내장 카드를 숨긴다 — 팀 카드가 실패하면 내장 카드를 그대로 보인다.
// 우리 팀 카드 둘이 같은 계정+조직이면 설정 순서상 첫 카드 한 장만 남긴다(10-18 2차 결정). 데몬은 원천을 등록한 차례로 보고를 주고
// (index.js 133·163-166줄, 합칠 때도 전역 결과가 먼저 — 111-116줄) 우리 팀 원천은 Paseo 설정의 공급자 차례로 등록한다
// (index.server.ts teamUsageSources ← server/account claudeProviders). 사용량을 읽은 카드 가운데 첫 장을 남긴다 — 앞 카드가 실패면
// 사용량 칸은 어차피 그 카드를 그리지 않으므로 다음 카드를 숨기지 않는다. Paseo 내장 사용량 화면은 바꾸지 않는다(우리 칸만).

/** Paseo 내장 Claude 사용량 원천 번호(설치본 builtin-plugins/claude-usage-source/index.server.ts registerUsageSource id) */
export const BUILTIN_CLAUDE_USAGE_SOURCE = "claude";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 확인한 계정·조직 번호로 만든 열쇠 — 내장 원천과 같은 `계정uuid.조직uuid`. 둘 중 하나라도 UUID 모양이 아니면 null(미확인) */
export function accountOrgKey(accountUuid: unknown, organizationUuid: unknown): string | null {
  return typeof accountUuid === "string" && typeof organizationUuid === "string" && UUID.test(accountUuid) && UUID.test(organizationUuid)
    ? `${accountUuid}.${organizationUuid}`
    : null;
}

/** 계정+조직으로 확인된 열쇠인가 — 확인 못 한 원천의 대체 열쇠(hashAccountKey: 점 없는 64자 16진수)는 아니다 */
export function isVerifiedAccountOrgKey(key: string | null | undefined): key is string {
  if (typeof key !== "string") return false;
  const parts = key.split(".");
  return parts.length === 2 && UUID.test(parts[0]) && UUID.test(parts[1]);
}

/** 원본 보고 한 줄(데몬 UsageReportEntry 중 여기서 쓰는 칸) */
export interface UsageReportLike {
  id: string;
  sourceId: string;
  sourceLabel: string;
  fetchedAt: string;
  account: { label?: string };
  report: { status: string; planLabel?: string; windows?: unknown[]; balances?: unknown[]; details?: unknown[]; error?: string; problem?: { kind?: string } };
}

/** 옛 목록(providers.listUsage)과 같은 모양 — 사용량 칸(client/usageFooter)이 그리는 값 */
export interface LegacyUsageLike {
  fetchedAt: string;
  providers: Array<{
    providerId: string;
    displayName: string;
    status: string;
    planLabel: string | null;
    windows: unknown[];
    balances: unknown[];
    details: unknown[];
    error: string | null;
  }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 원본 보고 목록 읽기 — `{ reports: [...] }`(listUsageReports 응답) 또는 배열. 모양이 다르면 null(옛 목록으로 돌아간다) */
export function parseUsageReports(raw: unknown): UsageReportLike[] | null {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.reports) ? raw.reports : null;
  if (!list) return null;
  const out: UsageReportLike[] = [];
  for (const r of list) {
    if (!isRecord(r) || typeof r.id !== "string" || typeof r.sourceId !== "string" || typeof r.sourceLabel !== "string"
      || typeof r.fetchedAt !== "string" || !isRecord(r.report) || typeof r.report.status !== "string") return null;
    const account = isRecord(r.account) && typeof r.account.label === "string" ? { label: r.account.label } : {};
    out.push({ ...(r as unknown as UsageReportLike), account });
  }
  return out;
}

/** 보고의 계정 열쇠 — 번호가 `원천id:` 로 시작할 때만 그 뒤(원천 번호의 마지막 ':' 를 짐작으로 자르지 않는다) */
export function reportAccountKey(r: Pick<UsageReportLike, "id" | "sourceId">): string | null {
  return r.id.startsWith(r.sourceId + ":") ? r.id.slice(r.sourceId.length + 1) : null;
}

const healthy = (r: UsageReportLike): boolean => r.report.status === "available" && Array.isArray(r.report.windows) && r.report.windows.length > 0;

/** 같은 계정 거르기 — 정상인 우리 팀 카드와 계정+조직이 같은 내장 Claude 카드를 빼고, 우리 팀 카드끼리 같으면 받은 차례(= 설정 차례)의
 *  첫 정상 카드만 남긴다. 확인 안 된 열쇠(대체 열쇠)는 어느 쪽도 빼지 않는다. 순서는 그대로 */
export function dedupeUsageReports(reports: UsageReportLike[]): { visible: UsageReportLike[]; hiddenIds: string[] } {
  const preferred = new Set(reports.filter((r) => isTeamUsageSource(r.sourceId) && healthy(r))
    .map(reportAccountKey).filter(isVerifiedAccountOrgKey));
  const keptTeam = new Set<string>();
  const hiddenIds: string[] = [];
  const visible = reports.filter((r) => {
    const key = reportAccountKey(r);
    let hide = false;
    if (healthy(r) && isVerifiedAccountOrgKey(key)) {
      if (isTeamUsageSource(r.sourceId)) {
        hide = keptTeam.has(key);
        keptTeam.add(key);
      } else hide = r.sourceId === BUILTIN_CLAUDE_USAGE_SOURCE && preferred.has(key);
    }
    if (hide) hiddenIds.push(r.id);
    return !hide;
  });
  return { visible, hiddenIds };
}

/** 쓸 수 없을 때의 한 줄 — 옛 목록의 error 칸 자리. 사용량 칸은 쓸 수 있는 카드만 그려 이 글은 화면에 나오지 않는다 */
function legacyError(report: UsageReportLike["report"]): string | null {
  if (report.status === "error") return typeof report.error === "string" ? report.error : "error";
  if (report.status === "unavailable") return `unavailable${report.problem?.kind ? ` (${report.problem.kind})` : ""}`;
  return null;
}

/** 원본 보고 → 옛 목록 모양 — 데몬 listLegacyUsage 와 같은 규칙(설치본 0.11.4 usage-sources/index.js:170-189):
 *  providerId = 원천 번호 · 이름 = 원천 이름(계정 이름이 있으면 "원천 (계정)") · fetchedAt = 가장 오래된 받은 시각(없으면 지금).
 *  fetchedAt 은 숨긴 카드까지 넣어 센다(fetchedFrom) — 데몬 옛 목록과 같은 값이어야 "다음 갱신까지" 시각이 달라지지 않는다 */
export function legacyUsageFromReports(reports: UsageReportLike[], now: number = Date.now(), fetchedFrom: UsageReportLike[] = reports): LegacyUsageLike {
  return {
    fetchedAt: fetchedFrom.length ? fetchedFrom.reduce((oldest, r) => (r.fetchedAt < oldest ? r.fetchedAt : oldest), fetchedFrom[0].fetchedAt) : new Date(now).toISOString(),
    providers: reports.map((r) => {
      const ok = r.report.status === "available";
      return {
        providerId: r.sourceId,
        displayName: r.account.label ? `${r.sourceLabel} (${r.account.label})` : r.sourceLabel,
        status: r.report.status,
        planLabel: ok ? r.report.planLabel ?? null : null,
        windows: ok ? r.report.windows ?? [] : [],
        balances: ok ? r.report.balances ?? [] : [],
        details: ok ? r.report.details ?? [] : [],
        error: legacyError(r.report),
      };
    }),
  };
}

/** 원본 보고로 사용량 칸 값을 만든다(같은 계정 거른 뒤). 원본 보고를 못 읽으면 null — 그때는 옛 목록을 그대로 쓴다(두 장 유지) */
export function usageFromReports(raw: unknown, now: number = Date.now()): { usage: LegacyUsageLike; hiddenIds: string[] } | null {
  const reports = parseUsageReports(raw);
  if (!reports) return null;
  const { visible, hiddenIds } = dedupeUsageReports(reports);
  return { usage: legacyUsageFromReports(visible, now, reports), hiddenIds };
}
