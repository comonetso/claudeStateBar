import { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { probeSettingsCache } from "./settingsCache";
import { useScreenRole } from "./screenRole";
import { useSyncSlots, type SyncSlotsView } from "./settingsSync";
import { appBundleId, isCompactWidth, isDesktopApp, onPaseoStoresHydrated, probePaseoInternals, type InternalsReason, type PaseoInternals } from "./web";

// 기능별 상태(10-08 리규형님 결정 — Codex 261008_150613 작업 1~3, 정본 응답 5.3절).
// 0.11.1 업데이트 때 판 칸이 "아는 판 = 모두 켜짐"이라 실제로 꺼진 것을 알 길이 없었다. 기능마다 다섯 가지로 판정한다:
//   정상(ok) · 제한(limited: 막혔지만 대신 하는 동작이 있음) · 중단(stopped) · 확인 중(checking) · 해당 없음(na)
// 판정은 내부 연결이 갖춰졌는지와 설정 맞추기 응답만 본다(읽기만, 값·배치를 바꾸지 않음). 실제로 눌러 되는지는 아니다 —
// 그래서 화면에 "갖춰졌는지만 본 것"이라고 함께 적는다. "확인 중"·"해당 없음"은 왼쪽 칸 요약에 세지 않는다.

export type HealthState = "ok" | "limited" | "stopped" | "checking" | "na";
export type FeatureId = "split" | "jsonOpen" | "layoutPull" | "settingsLive" | "settingsSync";
export type HealthReason =
  | "unknown-bundle" // 이 판의 내부 번호를 모름(web.ts PASEO_BUNDLES 에 없음)
  | "internals-changed" // 번호는 아는데 그 자리 모양이 다름
  | "loading" // 저장소가 아직 저장 파일을 읽는 중
  | "not-web" // 폰 공식 앱 등 이 화면에서는 쓰지 않음
  | "narrow" // 좁은 화면은 원래 나누지 않음(activityButton isCompactWidth)
  | "publisher" // 이 화면이 기준 화면(화면 구성을 저장하는 쪽 — 대표 PC 웹, 없으면 PC 앱. client/screenRole)
  | "no-slot" // 이 판 공통 설정 칸이 아직 없음
  | "other-version" // 이 화면을 연 뒤 판이 다른 화면이 설정을 바꿈
  | "rpc-failed"; // PC 데몬에 물어보지 못함
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
};

/** 내부 연결 이유들 중 처음 걸린 것으로 판정한다. failState = 막혔을 때 그 기능이 어떻게 되는지 */
function fromInternals(id: FeatureId, reasons: (InternalsReason | null)[], failState: "limited" | "stopped"): FeatureHealth {
  const r = reasons.find((x) => x !== null) ?? null;
  if (r === null) return { id, state: "ok", reason: null };
  if (r === "not-web") return { id, state: "na", reason: "not-web" };
  if (r === "not-hydrated") return { id, state: "checking", reason: "loading" };
  if (r === "unknown-bundle") return { id, state: failState, reason: "unknown-bundle" };
  return { id, state: failState, reason: "internals-changed", detail: r };
}

function judgeSync(slot: string | null, publisher: boolean, sync: SyncSlotsView | null): FeatureHealth {
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
  const { slot, publisher, compact, internals: i, cache, sync } = input;
  return [
    // 막히면 같은 칸 탭으로 연다(activityButton → client.openPanel)
    slot && compact ? { id: "split", state: "na", reason: "narrow" } : fromInternals("split", [i.layout, i.schema], "limited"),
    // 막히면 열지 못하고 이유만 띄운다(projectsData openProjectsFile)
    fromInternals("jsonOpen", [i.layout, i.navigate], "stopped"),
    // 기준 화면이 아닌 화면의 자동 반영. 막혀도 톱니 메뉴 "PC 에서 가져오기"(새로 읽기)는 된다
    publisher ? { id: "layoutPull", state: "na", reason: "publisher" } : fromInternals("layoutPull", [i.layout, i.sidebarOrder], "limited"),
    // 막히면 화면을 새로 읽어 반영한다(settingsSync)
    fromInternals("settingsLive", [cache], "limited"),
    judgeSync(slot, publisher, sync),
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
  return useMemo(
    () =>
      judgeHealth({
        slot: appBundleId(),
        publisher: role.publisher ?? isDesktopApp(),
        compact: isCompactWidth(),
        internals: probePaseoInternals(),
        cache: probeSettingsCache(),
        sync,
      }),
    // width·hydrated 는 다시 판정할 때를 알리는 값이다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync, width, hydrated, role.publisher],
  );
}
