import type { PluginButtonBehavior, PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { agentOf, useProviderName } from "./accountPill";
import { openActivityFor } from "./activityButton";
import { SETTINGS_TITLE } from "./settingsButton";
import { UsageTable } from "./usageFooter";
import { totalOf, useCounts } from "./useCounts";
import { phonePillsShown, setPillBadge, watchCompactWidth } from "./web";

// 폰(좁은 화면) 입력창 위 알약 줄에 "사용량"·"작업 현황"(10-17 리규형님 — "오른쪽 위 세로 … 를 누르면 사용량·작업 현황이 아래에서 올라와
// 자주 누르는데 매우 불편, 각각 독립 아이콘으로").Paseo 는 좁은 화면에서 머리줄 단추를 세로 점 메뉴로 접고, 접지 않게 하는 설정이
// 플러그인 도구에 없어 알약으로 따로 꺼낸다(버튼 답 "입력창 위 알약 줄"). 넓은 화면은 머리줄 단추가 그대로 보이므로 알약을 감춘다.
// 10-18: 좁은 화면에선 머리줄 단추를 아예 안 붙이고(activityButton.tsx — 세로 점 메뉴 제거), 이 두 알약과 컨텍스트 알약을 띠 아랫줄로
// 내린다(web.ts RAIL_CSS data-csb-rows). 붙일지 판정은 둘이 같은 phonePillsShown 하나를 쓴다.
// 알약 줄 위 왼쪽 끝에 서브에이전트·백그라운드·Codex 개수를 프로젝트 목록과 같은 "(1, 0, 3)" 으로 작게 쓴다
// (폰은 프로젝트 목록이 안 보여서 · 10-18 리규형님 "왼쪽정렬"). 셋 다 0 이면 숨긴다(10-18 리규형님 "없으면 보여주지마").
// 그 뒤에 지금 공급자 이름을 늘 붙인다 — "(1, 0, 1) · COMO", 셋 다 0 이면 "COMO" 만(10-21 리규형님 — 폰은 공급자 알약이 아이콘만이라).
// 공급자 알약이 안 붙는 대화(Codex·팀원 데몬)는 예전처럼 개수만.

type AgentLike = { id: string; workspaceId?: string | null };
// 글자는 폭 없는 공백 한 글자 — 빈 글자는 Paseo 가 거절한다(thinkingFoldPill.ts 와 같은 까닭). 아이콘만 보인다
const ICON_ONLY = "​";
const POPOVER_WIDTH = 300;
// 알약 이름 = 접근성 이름(aria-label) — 개수 글씨를 달 알약을 이것으로 찾는다
const ACTIVITY_TITLE = "작업 현황";


function UsagePopover({ theme }: PluginButtonContentProps) {
  return (
    <View style={{ width: POPOVER_WIDTH }}>
      <UsageTable theme={theme} />
    </View>
  );
}

function ActivityPillIcon(props: PluginButtonIconProps) {
  const { workspaceId, size, color, theme } = props;
  const counts = useCounts(workspaceId);
  const provider = useProviderName(agentOf(props as { context: "workspace" | "agent"; agentId?: string }));
  const total = counts ? totalOf(counts) : 0;
  const countText = counts && total > 0 ? `(${counts.workflows}, ${counts.background}, ${counts.codexRuns + counts.codexChats})` : null;
  const text = countText && provider ? `${countText} · ${provider}` : (countText ?? provider);
  const node = useRef<unknown>(null);
  // 아이콘 상자는 밖을 잘라 글씨를 못 그린다 — 담고 있는 알약 요소에 달아 그 위에 띄운다(web.ts setPillBadge)
  useEffect(() => {
    setPillBadge(node.current, ACTIVITY_TITLE, text, theme.colors.foregroundMuted, theme.colors.surface0);
  }, [text, theme]);
  useEffect(() => () => setPillBadge(node.current, ACTIVITY_TITLE, null, "", ""), []);
  // 아이콘은 늘 작업 현황 화면과 같은 파형(10-18 리규형님 "아이콘을 통일" — 돌고 있을 때 LoaderCircle 로 바뀌어 화면 제목 아이콘과 달랐다).
  // 돌고 있는지는 위 개수 글씨가 알려 준다
  return (
    <View ref={(n) => { node.current = n; }}>
      <Icon name="Activity" size={size} color={color} />
    </View>
  );
}

/** settings: 톱니 동작(settingsButton.tsx settingsBehavior). 주면 설정 알약을 화면 폭과 상관없이 늘 붙인다 — 10-18 리규형님: 좁은 화면
 *  "맨오른쪽에 설정아이콘", 넓은 화면도 "설정을 알약들 맨 오른쪽에"(머리줄은 셋까지만 보여서). 넓은 화면 자리는 공급자 알약 다음 ·
 *  Paseo 변경사항 단추 앞(등록 순서 — index.client.tsx 가 공급자 알약을 먼저 단다), 좁은 화면 자리는 web.ts RAIL_CSS */
export function createPhonePills(client: PluginClientContext, log: (message: string) => void, settings?: PluginButtonBehavior) {
  const pills = new Map<string, PluginButtonRegistration[]>();
  const settingsPills = new Map<string, PluginButtonRegistration>();
  const attachSettings = (agentId: string, workspaceId: string) => {
    if (!settings || settingsPills.has(agentId)) return;
    try {
      settingsPills.set(agentId, client.addComposerPill({
        id: "phone-settings",
        workspaceId,
        agentId,
        button: { title: SETTINGS_TITLE, icon: "Settings", label: ICON_ONLY, visible: true, behavior: settings },
      }));
    } catch (error) {
      log(`settings pill ${agentId.slice(0, 8)}: ${String(error)}`);
    }
  };
  const detachSettings = (agentId: string) => {
    settingsPills.get(agentId)?.remove();
    settingsPills.delete(agentId);
  };
  // 본 대화(대화 → 작업 공간) — 넓은 화면에선 알약을 떼 두었다가 좁아지면 다시 붙인다
  const agents = new Map<string, string>();
  // 숨김(visible:false)으로 붙였다가 보이게 바꾸는 갱신은 Paseo 가 반영하지 않았다(10-17 제 탭 실측 — 폭을 390 으로 줄여도 안 나옴) →
  // 좁은 화면일 때만 붙이고 넓어지면 뗀다
  let shown = phonePillsShown();

  const detach = (agentId: string) => {
    for (const reg of pills.get(agentId) ?? []) reg.remove();
    pills.delete(agentId);
  };
  const attach = (agentId: string, workspaceId: string) => {
    if (pills.has(agentId)) return;
    try {
      const usage = client.addComposerPill({
        id: "phone-usage",
        workspaceId,
        agentId,
        button: { title: "사용량", icon: "Gauge", label: ICON_ONLY, visible: true, behavior: { kind: "popover", Content: UsagePopover } },
      });
      const activity = client.addComposerPill({
        id: "phone-activity",
        workspaceId,
        agentId,
        button: {
          title: "작업 현황",
          icon: ActivityPillIcon,
          label: ICON_ONLY,
          visible: true,
          behavior: { kind: "action", onPress: () => { if (!openActivityFor(workspaceId)) client.openPanel("activity", { workspaceId }); } },
        },
      });
      pills.set(agentId, [usage, activity]);
    } catch (error) {
      log(`phone pills ${agentId.slice(0, 8)}: ${String(error)}`);
    }
  };
  const stopWidth = Platform.OS === "web" ? watchCompactWidth((compact) => {
    if (compact === shown) return;
    shown = compact;
    if (shown) for (const [agentId, workspaceId] of agents) attach(agentId, workspaceId);
    else for (const agentId of [...pills.keys()]) detach(agentId);
  }) : () => {};

  return {
    observe(agent: AgentLike) {
      if (!agent.workspaceId) return;
      agents.set(agent.id, agent.workspaceId);
      if (shown) attach(agent.id, agent.workspaceId);
      attachSettings(agent.id, agent.workspaceId);
    },
    remove(agentId: string) {
      agents.delete(agentId);
      detach(agentId);
      detachSettings(agentId);
    },
    dispose() {
      stopWidth();
      for (const id of [...pills.keys()]) detach(id);
      for (const id of [...settingsPills.keys()]) detachSettings(id);
      agents.clear();
    },
  };
}
