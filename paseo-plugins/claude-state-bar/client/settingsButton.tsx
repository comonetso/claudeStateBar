import type { PluginButtonBehavior, PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { soundProvider } from "./sounds";
import type { HeaderButtonSet } from "./usageButton";

/** Paseo 설정 안 우리 화면의 id — 예전 "Claude 상태 소리" 화면 그대로 쓴다(이름만 Claude State Bar 로 바뀜). */
export const SETTINGS_SCREEN_ID = "sounds";

/**
 * 작업 공간 머리줄 톱니(리규형님 10-07 결정 — 사용량 왼쪽). 누르면 Paseo 설정 안 우리 화면.
 * 설정 화면은 소리 담당 호스트(이 PC) 플러그인만 등록하므로 서버 작업 공간의 톱니도 그쪽 화면을 연다.
 * extra(웹·폰의 "PC 에서 가져오기")가 있으면 톱니는 [설정 열기 · extra] 메뉴가 된다 — 따로 단추를 두면 Paseo 가 셋까지만
 * 보여 줘 작업 현황이 ⋯ 로 접혀서 합쳤다(10-07). PC 앱은 extra 가 없어 지금처럼 바로 연다
 */
export function createSettingsButtons(client: PluginClientContext, extra?: PluginButtonMenuEntry | null): HeaderButtonSet {
  const registrations = new Map<string, PluginButtonRegistration>();
  const open = () => {
    const provider = soundProvider();
    if (provider?.openSettings) provider.openSettings();
    else client.openSettings(SETTINGS_SCREEN_ID);
  };
  const behavior: PluginButtonBehavior = extra
    ? { kind: "menu", items: [{ kind: "item", id: "open-settings", title: "Claude State Bar 설정", icon: "Settings", behavior: { kind: "action", onPress: open } }, extra] }
    : { kind: "action", onPress: open };
  return {
    add(workspaceId) {
      if (registrations.has(workspaceId)) return;
      registrations.set(
        workspaceId,
        client.addHeaderButton({
          id: "settings",
          workspaceId,
          button: { title: "Claude State Bar 설정", icon: "Settings", behavior },
        }),
      );
    },
    drop(workspaceId) {
      registrations.get(workspaceId)?.remove();
      registrations.delete(workspaceId);
    },
    dispose() {
      for (const registration of registrations.values()) registration.remove();
      registrations.clear();
    },
  };
}

/** 단추 묶음을 이 순서로 단다 — Paseo 는 등록한 순서대로 왼쪽부터 놓는다. */
export function chainButtons(...sets: HeaderButtonSet[]): HeaderButtonSet {
  return {
    add(workspaceId) {
      for (const set of sets) set.add(workspaceId);
    },
    drop(workspaceId) {
      for (const set of sets) set.drop(workspaceId);
    },
    dispose() {
      for (const set of sets) set.dispose?.();
    },
  };
}
