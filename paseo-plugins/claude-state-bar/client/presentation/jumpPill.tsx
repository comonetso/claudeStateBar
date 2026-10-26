import { type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Platform } from "react-native";
import { isCompactWidth, jumpToPreviousUserMessage, watchCompactWidth } from "../web";

// 대화마다 입력창 위 알약 줄에 "직전 내 말로" 알약(10-15 리규형님 — 대화가 길면 스크롤을 아무리 올려도 내 말을 찾기 어렵다).
// 누를 때마다 한 칸 더 위의 내 말로 간다(판단은 web.ts pickJumpTarget). 넓은 화면은 아이콘 + "내말", 좁은 화면(폰)은 아이콘만
// (리규형님 "PC 에서는 내말, 폰에서는 아이콘"). 이동은 Paseo 대화 개요의 이동 함수를 빌리므로 안 불러온 옛 기록까지 간다

type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null };

// 폭 없는 공백 한 글자 — Paseo 는 빈 글자 알약을 거절한다(accountPill 과 같다). 화면엔 아이콘만 남는다
const ICON_ONLY = "​";
const TITLE = "직전 내 말로";
const label = () => (isCompactWidth() ? ICON_ONLY : "내말");

function JumpIcon(props: PluginButtonIconProps) {
  return <Icon name="CornerLeftUp" size={props.size} color={props.color} />;
}

export function createJumpPills(client: PluginClientContext, log: (message: string) => void) {
  const pills = new Map<string, PluginButtonRegistration>();
  const stopWidth = watchCompactWidth(() => {
    for (const reg of pills.values()) reg.update({ label: label() });
  });

  const drop = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const observe = (agent: AgentLike) => {
    if (agent.archivedAt) return drop(agent.id);
    // 웹·데스크톱 화면에서만 — 이동은 화면의 대화 칸을 직접 찾는다
    if (Platform.OS !== "web" || !agent.workspaceId || pills.has(agent.id)) return;
    try {
      const reg = client.addComposerPill({
        id: "jump-to-my-message",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: TITLE,
          icon: JumpIcon,
          label: label(),
          behavior: {
            kind: "action",
            onPress: () => {
              try {
                log(`jump pill ${agent.id.slice(0, 8)}: ${jumpToPreviousUserMessage(agent.id)}`);
              } catch (error) {
                log(`jump pill ${agent.id.slice(0, 8)}: ${String(error)}`);
              }
            },
          },
        },
      });
      pills.set(agent.id, reg);
    } catch (error) {
      log(`jump pill ${agent.id}: ${String(error)}`);
    }
  };

  return {
    observe,
    remove: drop,
    dispose: () => {
      stopWidth();
      for (const id of [...pills.keys()]) drop(id);
    },
  };
}
