import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { onThinkingAllOpen, setThinkingAllOpen, thinkingAllOpen } from "./thinkingFold";
import { setStyleSheet } from "./web";

// 입력창 위 "생각 상자 모두 접기·펼치기" 알약(10-08 리규형님: 채팅창 위 오른쪽, 생각 상자의 ↗ 같은 아이콘으로 토글,
// 마우스를 올리면 풍선 도움말). 풍선 도움말은 단추 이름(title)이다 — Paseo 가 알약 이름을 마우스 올림 도움말로 띄운다
// (폰 제외, 0.11.0-beta.5 plugins/buttons/view.tsx ButtonControl). 글자는 안 보이는 한 글자로 줘 아이콘만 보이게 한다.
// 줄 오른쪽 끝으로 미는 것은 웹·PC 앱만 — 알약의 접근성 이름(aria-label = 단추 이름)으로 찾아 왼쪽 여백을 자동으로

type AgentLike = { id: string; workspaceId?: string | null };
const TITLE_PREFIX = "생각 상자 모두";
const STYLE_ID = "claude-state-bar-thinking-fold";

function look(): Pick<PluginButton, "title" | "icon"> {
  const open = thinkingAllOpen();
  return open ? { title: `${TITLE_PREFIX} 접기`, icon: "Minimize2" } : { title: `${TITLE_PREFIX} 펼치기`, icon: "Maximize2" };
}

export function createThinkingFoldPills(client: PluginClientContext, log: (message: string) => void) {
  const pills = new Map<string, PluginButtonRegistration>();
  setStyleSheet(STYLE_ID, `[aria-label^="${TITLE_PREFIX}"]{margin-left:auto}`);
  const stop = onThinkingAllOpen(() => {
    const next = look();
    for (const reg of pills.values()) reg.update(next);
  });

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  return {
    observe(agent: AgentLike) {
      if (!agent.workspaceId || pills.has(agent.id)) return;
      try {
        const reg = client.addComposerPill({
          id: "thinking-fold",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          // 글자는 폭 없는 공백 한 글자 — Paseo 는 알약 글자가 비었거나 공백뿐이면 거절한다("Plugin button needs label",
          // 설치 번들의 label.trim() 검사). U+200B 는 trim 이 지우지 않아 통과하고 화면엔 안 보여 아이콘만 남는다
          button: { ...look(), label: "​", visible: true, behavior: { kind: "action", onPress: () => setThinkingAllOpen(!thinkingAllOpen()) } },
        });
        pills.set(agent.id, reg);
      } catch (error) {
        log(`thinking fold pill ${agent.id.slice(0, 8)}: ${String(error)}`);
      }
    },
    remove,
    // 오른쪽 정렬 스타일은 남긴다 — 기기마다 올라온 플러그인이 같은 스타일을 같이 쓴다(한 기기가 끊겨도 다른 기기 알약은 그대로)
    dispose() {
      stop();
      for (const id of [...pills.keys()]) remove(id);
    },
  };
}
