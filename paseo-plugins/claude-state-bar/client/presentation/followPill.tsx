import { type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { FollowControl } from "./selectionRead";
import { themeVar } from "../web";

// 대화마다 입력창 위 "따라 읽기" 알약(10-15 리규형님 "생각 상자를 뺀 Claude 말을 지금 시점부터 계속 읽어 주는 알약 하나").
// 누르면 그 대화를 따라 읽고 다시 누르면 끈다. 켜진 동안 아이콘이 읽기 단추와 같은 녹색이다. 읽을 수 없으면(호스트 확인 전·음성 합성
// 키 없음·설정에서 소리 읽기 끔) 알약을 숨긴다 — 턴 읽기 단추와 같다. 화면 글을 읽으므로 웹·데스크톱 화면에서만

type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null; status?: string | null };

// 폭 없는 공백 한 글자 — Paseo 는 빈 글자 알약을 거절한다(accountPill 과 같다). 화면엔 아이콘만 남는다
const ICON_ONLY = "​";
const TITLE = "따라 읽기";
const title = (on: boolean) => (on ? `${TITLE}(켜짐 — 누르면 끔)` : TITLE);

export function createFollowPills(client: PluginClientContext, log: (message: string) => void, follow: FollowControl) {
  const pills = new Map<string, { reg: PluginButtonRegistration; on: boolean; visible: boolean }>();

  function FollowIcon(props: PluginButtonIconProps) {
    const agentId = props.context === "agent" ? props.agentId : "";
    const on = useSyncExternalStore(follow.subscribe, () => follow.isOn(agentId), () => follow.isOn(agentId));
    const green = themeVar("--colors-status-dot-success", props.theme.colors.statusSuccess);
    return <Icon name="Headphones" size={props.size} color={on ? green : props.color} />;
  }

  // 켜짐·숨김이 바뀌면 알약 이름(마우스 도움말)과 보이기를 맞춘다
  const sync = () => {
    const visible = follow.available();
    for (const [agentId, pill] of pills) {
      const on = follow.isOn(agentId);
      if (pill.on === on && pill.visible === visible) continue;
      pill.on = on;
      pill.visible = visible;
      pill.reg.update({ title: title(on), label: ICON_ONLY, visible });
    }
  };
  const stop = follow.subscribe(sync);

  const drop = (agentId: string) => {
    pills.get(agentId)?.reg.remove();
    pills.delete(agentId);
  };

  const observe = (agent: AgentLike) => {
    follow.observe(agent);
    if (agent.archivedAt) {
      follow.forget(agent.id);
      return drop(agent.id);
    }
    if (Platform.OS !== "web" || !agent.workspaceId || pills.has(agent.id)) return;
    try {
      const on = follow.isOn(agent.id);
      const visible = follow.available();
      const reg = client.addComposerPill({
        id: "follow-read",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: title(on),
          icon: FollowIcon,
          label: ICON_ONLY,
          visible,
          behavior: {
            kind: "action",
            onPress: () => {
              try {
                follow.toggle(agent.id);
              } catch (error) {
                log(`follow pill ${agent.id.slice(0, 8)}: ${String(error)}`);
              }
            },
          },
        },
      });
      pills.set(agent.id, { reg, on, visible });
    } catch (error) {
      log(`follow pill ${agent.id.slice(0, 8)}: ${String(error)}`);
    }
  };

  return {
    observe,
    remove: (agentId: string) => {
      follow.forget(agentId);
      drop(agentId);
    },
    dispose: () => {
      stop();
      for (const id of [...pills.keys()]) drop(id);
    },
  };
}
