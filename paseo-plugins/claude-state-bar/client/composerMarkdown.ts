import type { PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { backspaceList, continueList, indentList, outdentList, renumberText, toggleList, type Edit } from "./markdownList";
import { applyComposerEdit, isCompactWidth, listenComposer, watchCompactWidth, type ComposerKey, type ComposerTextArea } from "./web";

// 대화 입력창 마크다운 목록 보조(리규형님 10-07 결정 — 다시 묻지 않는다).
// - Shift+Enter: 목록 줄이면 다음 항목, 빈 항목이면 목록 끝. Enter 는 늘 보내기(Paseo 그대로)
// - Tab: 목록 줄에서만 하위 목록으로. 보통 줄은 Paseo 그대로
// - Backspace: 목록 머리 바로 뒤에서 내어쓰기(맨 바깥 줄은 머리만 지움). Shift+Tab 은 Paseo 의 에이전트 모드 바꾸기라 그대로 둔다
// - 줄을 지우거나 끼우면 번호를 다시 매긴다
// - 입력창 위 "목록" 알약 하나 — 메뉴로 번호 목록·점 목록·들여쓰기·내어쓰기
// 웹·데스크톱만(입력창 화면 요소를 직접 만진다). 폰 공식 앱에는 알약도 달지 않는다.

type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null };

// 앱은 호스트마다 이 플러그인을 따로 띄우지만 실행 공간(globalThis)은 하나다. 키를 네 벌이 다 들으면 Shift+Enter 한 번에
// 네 번 고치므로, 가장 나중에 실린 한 벌만 듣고 그 벌이 내려가면 남은 것 중 가장 나중 것이 이어받는다
// (PC 플러그인을 다시 실으면 새 판이 키를 맡는다). 알약 메뉴가 고칠 입력창도 여기 둔다 — 듣는 벌이 기억하고 모든 벌이 읽는다.
type Owner = { listen(): () => void };
interface Shared {
  owners: Owner[];
  active?: { owner: Owner; stop: () => void };
  target?: ComposerTextArea;
}
const SHARED_KEY = "__claudeStateBar_composerMarkdown_v1";

function shared(): Shared {
  const root = globalThis as unknown as Record<string, Shared | undefined>;
  let value = root[SHARED_KEY];
  if (!value) {
    value = { owners: [] };
    root[SHARED_KEY] = value;
  }
  return value;
}

function activate(s: Shared): void {
  const top = s.owners[s.owners.length - 1];
  if (s.active?.owner === top) return;
  s.active?.stop();
  s.active = top ? { owner: top, stop: top.listen() } : undefined;
}

function onKey(key: ComposerKey, el: ComposerTextArea): Edit | null {
  const { value, selectionStart: start, selectionEnd: end } = el;
  if (key === "shift-enter") return continueList(value, start, end);
  if (key === "tab") return indentList(value, start, end);
  return backspaceList(value, start, end);
}

export function createComposerMarkdown(client: PluginClientContext, log: (message: string) => void) {
  if (Platform.OS !== "web") return { observe: (_agent: AgentLike) => {}, remove: (_agentId: string) => {}, dispose: () => {} };

  const s = shared();
  const owner: Owner = {
    listen: () =>
      listenComposer({
        key: onKey,
        linesChanged: (el) => renumberText(el.value, el.selectionStart, el.selectionEnd),
        pointed: (el) => {
          s.target = el;
        },
      }),
  };
  s.owners.push(owner);
  activate(s);

  // 메뉴는 화면 맨 바깥에 떠서, 고칠 입력창은 알약을 누를 때 기억한 것(그 알약에서 가장 가까운 입력창)이다
  const run = (name: string, fn: (text: string, start: number, end: number) => Edit | null) => () => {
    const el = s.target;
    if (!el?.isConnected) {
      log(`composer list ${name}: no composer`);
      return;
    }
    const edit = fn(el.value, el.selectionStart, el.selectionEnd);
    if (edit) applyComposerEdit(el, edit);
  };
  const items: PluginButtonMenuEntry[] = [
    { kind: "item", id: "number", title: "번호 목록", icon: "ListOrdered", behavior: { kind: "action", onPress: run("number", (t, a, b) => toggleList(t, a, b, "number")) } },
    { kind: "item", id: "bullet", title: "점 목록", icon: "List", behavior: { kind: "action", onPress: run("bullet", (t, a, b) => toggleList(t, a, b, "bullet")) } },
    { kind: "separator", id: "sep" },
    { kind: "item", id: "indent", title: "들여쓰기 (Tab)", icon: "ListIndentIncrease", behavior: { kind: "action", onPress: run("indent", indentList) } },
    { kind: "item", id: "outdent", title: "내어쓰기 (머리 뒤 Backspace)", icon: "ListIndentDecrease", behavior: { kind: "action", onPress: run("outdent", outdentList) } },
  ];

  const pills = new Map<string, PluginButtonRegistration>();
  // 좁은 화면(폰 모양)은 "목록" 글자를 빼고 아이콘만(10-08 리규형님). Paseo 는 알약 글자가 비면 거절해서 안 보이는 한 글자(U+200B)
  const pillLabel = () => (isCompactWidth() ? "​" : "목록");
  const stopWidth = watchCompactWidth(() => {
    const label = pillLabel();
    for (const reg of pills.values()) reg.update({ label });
  });
  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };
  const observe = (agent: AgentLike) => {
    if (agent.archivedAt) return remove(agent.id);
    if (!agent.workspaceId || pills.has(agent.id)) return;
    try {
      pills.set(
        agent.id,
        client.addComposerPill({
          id: "md-list",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: { title: "목록 쓰기", icon: "List", label: pillLabel(), behavior: { kind: "menu", items } },
        }),
      );
    } catch (error) {
      log(`composer list pill ${agent.id.slice(0, 8)}: ${String(error)}`);
    }
  };

  return {
    observe,
    remove,
    dispose: () => {
      stopWidth();
      for (const id of [...pills.keys()]) remove(id);
      s.owners = s.owners.filter((o) => o !== owner);
      if (s.active?.owner === owner) {
        s.active.stop();
        s.active = undefined;
      }
      activate(s);
    },
  };
}
