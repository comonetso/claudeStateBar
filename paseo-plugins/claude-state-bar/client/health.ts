import { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { probeSettingsCache } from "./settingsCache";
import { useScreenRole } from "./screenRole";
import { useSyncSlots, type SyncSlotsView } from "./settingsSync";
import {
  appBundleId,
  isCompactWidth,
  isDesktopApp,
  isGateMember,
  onPaseoStoresHydrated,
  probePaseoInternals,
  type InternalsReason,
  type PaseoInternals,
} from "./web";

// 기능별 상태(10-08 리규형님 결정 — Codex 261008_150613 작업 1~3, 정본 응답 5.3절).
// 0.11.1 업데이트 때 판 칸이 "아는 판 = 모두 켜짐"이라 실제로 꺼진 것을 알 길이 없었다. 기능마다 다섯 가지로 판정한다:
//   정상(ok) · 제한(limited: 막혔지만 대신 하는 동작이 있음) · 중단(stopped) · 확인 중(checking) · 해당 없음(na)
// 판정은 내부 연결이 갖춰졌는지와 설정 맞추기 응답만 본다(읽기만, 값·배치를 바꾸지 않음). 실제로 눌러 되는지는 아니다 —
// 그래서 화면에 "갖춰졌는지만 본 것"이라고 함께 적는다. "확인 중"·"해당 없음"은 왼쪽 칸 요약에 세지 않는다.

export type HealthState = "ok" | "limited" | "stopped" | "checking" | "na";
export type FeatureId = "split" | "jsonOpen" | "layoutPull" | "settingsLive" | "settingsSync" | "usageDedupe";
export type HealthReason =
  | "unknown-bundle" // 이 판의 내부 번호를 모름(web.ts PASEO_BUNDLES 에 없음)
  | "internals-changed" // 번호는 아는데 그 자리 모양이 다름
  | "loading" // 저장소가 아직 저장 파일을 읽는 중
  | "not-web" // 폰 공식 앱 등 이 화면에서는 쓰지 않음
  | "narrow" // 좁은 화면은 원래 나누지 않음(activityButton isCompactWidth)
  | "publisher" // 이 화면이 기준 화면(화면 구성을 저장하는 쪽 — 대표 PC 웹, 없으면 PC 앱. client/screenRole)
  | "no-slot" // 이 판 공통 설정 칸이 아직 없음
  | "other-version" // 이 화면을 연 뒤 판이 다른 화면이 설정을 바꿈
  | "rpc-failed" // PC 데몬에 물어보지 못함
  | "member"; // 직원 계정 화면 — 기준 화면(리규형님 PC)이 없어 설정 맞추기를 하지 않음(10-11)
export type FeatureHealth = { id: FeatureId; state: HealthState; reason: HealthReason | null; detail?: string };

export type HealthInput = {
  /** 이 화면 번들 지문(웹·PC 앱이 아니면 null) */
  slot: string | null;
  /** 이 화면이 기준 화면인가(10-08 대표 PC 웹 — 데몬에 못 물었으면 PC 앱인지로) */
  publisher: boolean;
  compact: boolean;
  internals: PaseoInternals;
  cache: InternalsReason | null;
  sync: SyncSlotsView | null;
  /** 직원 계정 화면(로그인 서버 표식) */
  member: boolean;
  /** 사용량 같은 계정 카드 거르기의 마지막 결과(10-18 C2 — 아래 reportUsageDedupe). 없으면 아직 안 물음 */
  usage?: UsageDedupeView | null;
};

// 사용량 같은 계정 카드 거르기 상태(10-18 C2 — Codex 261018_052815 C2 "기능 상태를 표시"). 사용량 칸이 묻을 때마다(client/usageFooter
// readUsage) 알린다 — 여기 두는 까닭: 이 파일은 가벼운 모듈만 불러와야 해서(기능 상태 시험이 이 파일을 따로 불러온다) 무거운 사용량 칸을 불러오지 않는다.
// mode "reports" = 원본 보고로 거름 · "legacy" = 못 해서 옛 목록 그대로(같은 계정 카드 두 장이 다 보임). reason = 못 한 이유
// (web.ts usageClient 의 InternalsReason·"no-client", usageFooter 의 "no-provider"·"shape-mismatch", 또는 요청 오류 글)
export type UsageDedupeView = { mode: "reports" | "legacy"; hidden: number; reason: string | null };
let usageDedupe: UsageDedupeView | null = null;
const usageDedupeSubs = new Set<() => void>();
export function reportUsageDedupe(view: UsageDedupeView): void {
  const prev = usageDedupe;
  usageDedupe = view;
  if (prev?.mode === view.mode && prev.reason === view.reason) return;
  for (const fn of [...usageDedupeSubs]) {
    try { fn(); } catch { /* 한 화면의 오류가 다른 화면을 막지 않게 */ }
  }
}
export function usageDedupeView(): UsageDedupeView | null {
  return usageDedupe;
}
const INTERNAL_REASONS = new Set(["no-require", "load-failed", "no-export", "shape-mismatch"]);
// 설정 화면 목록(judgeHealth) 맨 끝 칸이다. 기능 이름표·대신 하는 동작 글은 client/settingsI18n.ts featureName·featureFallback 의 usageDedupe(10-18 통합)
export type UsageDedupeHealth = { id: "usageDedupe"; state: HealthState; reason: HealthReason | null; detail?: string };
/** 막히면 같은 계정 카드 두 장(내장 + 우리 팀)을 그대로 보인다 — 카드가 사라지지는 않는다 */
export function judgeUsageDedupe(view: UsageDedupeView | null | undefined): UsageDedupeHealth {
  const id = "usageDedupe" as const;
  if (!view) return { id, state: "checking", reason: null };
  if (view.mode === "reports") return { id, state: "ok", reason: null };
  const r = view.reason ?? "";
  if (r === "not-web") return { id, state: "na", reason: "not-web" };
  if (r === "unknown-bundle") return { id, state: "limited", reason: "unknown-bundle" };
  if (INTERNAL_REASONS.has(r)) return { id, state: "limited", reason: "internals-changed", detail: r };
  return { id, state: "limited", reason: "rpc-failed", detail: r.slice(0, 200) };
}

/** 내부 연결 이유들 중 처음 걸린 것으로 판정한다. failState = 막혔을 때 그 기능이 어떻게 되는지 */
function fromInternals(id: FeatureId, reasons: (InternalsReason | null)[], failState: "limited" | "stopped"): FeatureHealth {
  const r = reasons.find((x) => x !== null) ?? null;
  if (r === null) return { id, state: "ok", reason: null };
  if (r === "not-web") return { id, state: "na", reason: "not-web" };
  if (r === "not-hydrated") return { id, state: "checking", reason: "loading" };
  if (r === "unknown-bundle") return { id, state: failState, reason: "unknown-bundle" };
  return { id, state: failState, reason: "internals-changed", detail: r };
}

function judgeSync(slot: string | null, publisher: boolean, sync: SyncSlotsView | null, member: boolean): FeatureHealth {
  const id: FeatureId = "settingsSync";
  if (!slot) return { id, state: "na", reason: "not-web" };
  if (!sync) return { id, state: "checking", reason: null };
  if (sync.error) return { id, state: "stopped", reason: "rpc-failed", detail: sync.error };
  // 기준 화면은 칸이 없으면 스스로 만든다(settingsSync seed) — 그 사이는 확인 중. 다른 화면은 기준 화면이 이 판으로 열려야 생긴다
  if (sync.waiting) return publisher ? { id, state: "checking", reason: null } : { id, state: "stopped", reason: "no-slot" };
  const mine = sync.slots.find((s) => s.slot === slot)?.at ?? 0;
  const seen = sync.firstSeen ?? {};
  const newer = sync.slots.filter((s) => s.slot !== slot && s.at > mine && s.at > (seen[s.slot] ?? 0));
  if (newer.length > 0) return { id, state: "limited", reason: "other-version", detail: newer.map((s) => s.slot).join(",") };
  return { id, state: "ok", reason: null };
}

export function judgeHealth(input: HealthInput): FeatureHealth[] {
  const { slot, publisher, compact, internals: i, cache, sync, member } = input;
  return [
    // 막히면 같은 칸 탭으로 연다(activityButton → client.openPanel)
    slot && compact ? { id: "split", state: "na", reason: "narrow" } : fromInternals("split", [i.layout, i.schema], "limited"),
    // 막히면 열지 못하고 이유만 띄운다(projectsData openProjectsFile)
    fromInternals("jsonOpen", [i.layout, i.navigate], "stopped"),
    // 기준 화면이 아닌 화면의 자동 반영. 막혀도 톱니 메뉴 "PC 에서 가져오기"(새로 읽기)는 된다
    publisher ? { id: "layoutPull", state: "na", reason: "publisher" } : fromInternals("layoutPull", [i.layout, i.sidebarOrder], "limited"),
    // 막히면 화면을 새로 읽어 반영한다(settingsSync)
    fromInternals("settingsLive", [cache], "limited"),
    judgeSync(slot, publisher, sync, member),
    // 막히면 같은 계정 카드 두 장(내장 + 우리 팀)을 그대로 보인다(usageFooter readUsage 의 옛 목록)
    judgeUsageDedupe(input.usage),
  ];
}

/** 왼쪽 칸 요약에 셀 것 — 제한·중단만 */
export function healthCounts(list: FeatureHealth[]): { stopped: number; limited: number } {
  return { stopped: list.filter((f) => f.state === "stopped").length, limited: list.filter((f) => f.state === "limited").length };
}

/** 이 화면의 기능 상태. 설정 맞추기 응답·창 폭이 바뀌거나 저장소가 다 읽히면 다시 판정한다 */
export function useHealth(): FeatureHealth[] {
  const sync = useSyncSlots();
  const role = useScreenRole();
  const { width } = useWindowDimensions();
  const [hydrated, setHydrated] = useState(0);
  useEffect(() => onPaseoStoresHydrated(() => setHydrated((n) => n + 1)), []);
  const [usageTick, setUsageTick] = useState(0);
  useEffect(() => {
    const fn = () => setUsageTick((n) => n + 1);
    usageDedupeSubs.add(fn);
    return () => {
      usageDedupeSubs.delete(fn);
    };
  }, []);
  return useMemo(
    () =>
      judgeHealth({
        slot: appBundleId(),
        publisher: role.publisher ?? isDesktopApp(),
        compact: isCompactWidth(),
        internals: probePaseoInternals(),
        cache: probeSettingsCache(),
        sync,
        member: isGateMember(),
        usage: usageDedupe,
      }),
    // width·hydrated·usageTick 는 다시 판정할 때를 알리는 값이다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync, width, hydrated, role.publisher, usageTick],
  );
}
