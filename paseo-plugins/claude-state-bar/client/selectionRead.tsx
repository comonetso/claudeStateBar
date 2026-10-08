import type { PluginButton, PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Platform, View } from "react-native";
import { translateKo } from "../shared/translate";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { featureSwitches, onSharedSignal } from "./sounds";
import { SpeedSlider, thinkingController as controller } from "./thinking";
import type { ThinkingBoxState } from "./thinkingPlayer";
import { clearSelection, isCompactWidth, readAppFontSizes, selectionParagraphs, startComposerRail, watchCompactWidth, watchSelection, type SelectionSnapshot } from "./web";

// 대화 화면에서 마우스로 선택한 글 읽기(리규형님 10-06). 생각 상자 밖 본문은 플러그인이 버튼을 덧붙일 자리가 없어서
// (본문을 변환하면 Paseo 대신 통째로 다시 그려야 한다) 입력창 위 알약 줄에 둔다. 글을 선택하는 동안 "선택 읽기"가 보이고,
// 누르면 생각 상자와 같은 재생기로 읽는다. 읽는 동안만 이전·일시정지/재생·중지·다음·속도 알약이 보이고 다 읽거나 중지하면 사라진다.
// 웹·데스크톱만 — 폰 앱은 소리를 안 낸다(리규형님 결정).

type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null };
type Look = Partial<PluginButton>;
const CONTENT_DEFAULT_PX = 15;

function SpeedPopover({ theme, layout }: PluginButtonContentProps) {
  const px = readAppFontSizes().content ?? CONTENT_DEFAULT_PX;
  return (
    <View style={{ padding: 10, backgroundColor: theme.colors.surface1 }}>
      <SpeedSlider colors={theme.colors} compact={layout.compact} px={px} />
    </View>
  );
}

export function createSelectionPills(client: PluginClientContext, log: (message: string) => void) {
  if (Platform.OS !== "web") return { observe: (_agent: AgentLike) => {}, remove: (_agentId: string) => {}, dispose: () => {} };

  let selected: SelectionSnapshot | null = null;
  let canSpeak = false;
  let box: ThinkingBoxState | undefined; // 지금 읽는 선택 글(재생기의 상자 하나로 넘긴다)
  let reading: ReturnType<typeof selectionParagraphs> = null; // 그 글의 화면 문단 — 읽는 문단에 형광펜
  let lit = -1;
  let serial = 0;
  const made = new Set<ThinkingBoxState>();
  const pills = new Map<string, Map<string, { reg: PluginButtonRegistration; last: string }>>();

  const playing = () => (box ? controller.state(box) : undefined);
  // 누르는 순간 선택이 풀려도 마지막 선택을 읽는다(watchSelection 이 풀림을 누름 뒤에 알린다)
  // 화면 문단마다 나눠 빈 줄로 이어 넘긴다 — 재생기의 문단 번호가 화면 문단과 맞아 이전·다음·형광펜이 먹는다
  const start = () => {
    const snapshot = selected;
    if (!snapshot) return;
    reading?.highlight(null);
    reading = selectionParagraphs(snapshot.token);
    lit = -1;
    // 범위는 위에서 따로 잡아 뒀으니 선택은 푼다 — 선택 색이 형광펜을 덮지 않게, "선택 읽기" 알약도 숨게
    clearSelection();
    selected = null;
    const text = reading ? reading.texts.join("\n\n") : snapshot.text;
    const next = controller.box("selection", `selection-${++serial}`, Date.now(), text, "complete");
    next.rpc = { translate: (input) => client.rpc(translateKo, input), synthesize: (input) => client.rpc(ttsSynthesize, input) };
    made.add(next);
    box = next;
    controller.start(next, false);
  };

  const buttons: Record<string, PluginButton> = {
    read: { title: "선택한 글 읽기", icon: "Volume2", label: "선택 읽기", visible: false, behavior: { kind: "action", onPress: start } },
    prev: { title: "이전 문단", icon: "SkipBack", label: "이전", visible: false, behavior: { kind: "action", onPress: () => controller.previous() } },
    toggle: {
      title: "일시정지", icon: "Pause", label: "일시정지", visible: false,
      behavior: { kind: "action", onPress: () => (playing()?.paused ? controller.resume() : controller.pause()) },
    },
    stop: { title: "읽기 중지", icon: "Square", label: "중지", visible: false, behavior: { kind: "action", onPress: () => controller.stop() } },
    next: { title: "다음 문단", icon: "SkipForward", label: "다음", visible: false, behavior: { kind: "action", onPress: () => controller.next() } },
    speed: { title: "읽기 속도", icon: "Gauge", label: "1.00x", visible: false, behavior: { kind: "popover", Content: SpeedPopover } },
  };

  const lookOf = (id: string): Look => {
    const st = playing();
    const active = !!st?.active;
    // 설정 화면 "번역·읽기" 칸에서 읽기를 끄면 숨는다(리규형님 10-08)
    if (id === "read") return { visible: canSpeak && featureSwitches().tts && !!selected };
    if (id === "toggle") return { visible: active, label: st?.paused ? "재생" : "일시정지", title: st?.paused ? "이어서 읽기" : "일시정지", icon: st?.paused ? "Play" : "Pause" };
    if (id === "speed") return { visible: active, label: `${controller.rate.toFixed(2)}x` };
    return { visible: active };
  };

  // 좁은 화면(폰 모양)은 아이콘만(10-08 리규형님 "모바일에는 아이콘만") — 글자 칸은 늘 채워 보내고 좁으면 안 보이는 한 글자
  // (Paseo 는 알약 글자가 비면 거절한다). 넓은 화면은 지금 글자 그대로
  const shownLook = (id: string): Look => {
    const look: Look = { label: buttons[id].label, ...lookOf(id) };
    return isCompactWidth() ? { ...look, label: "​" } : look;
  };

  const refresh = () => {
    const st = playing();
    if (box && !st?.active) {
      // 다 읽었거나 중지했거나 생각 상자 읽기가 시작됐다 → 형광펜도 지운다
      box = undefined;
      reading?.highlight(null);
      reading = null;
      lit = -1;
    } else if (st?.active && reading && st.index !== lit) {
      lit = st.index;
      reading.highlight(st.index);
    }
    for (const set of pills.values()) {
      for (const [id, pill] of set) {
        const look = shownLook(id);
        const key = JSON.stringify(look);
        if (key === pill.last) continue;
        pill.last = key;
        pill.reg.update(look);
      }
    }
  };

  const remove = (agentId: string) => {
    const set = pills.get(agentId);
    if (!set) return;
    for (const pill of set.values()) pill.reg.remove();
    pills.delete(agentId);
  };

  const observe = (agent: AgentLike) => {
    if (agent.archivedAt) return remove(agent.id);
    if (!agent.workspaceId || pills.has(agent.id)) return;
    const set = new Map<string, { reg: PluginButtonRegistration; last: string }>();
    for (const [id, button] of Object.entries(buttons)) {
      try {
        const look = shownLook(id);
        const reg = client.addComposerPill({ id: `sel-${id}`, workspaceId: agent.workspaceId, agentId: agent.id, button: { ...button, ...look } });
        set.set(id, { reg, last: JSON.stringify(look) });
      } catch (error) {
        log(`selection pill ${agent.id.slice(0, 8)} ${id}: ${String(error)}`);
      }
    }
    pills.set(agent.id, set);
  };

  // 이 호스트에 읽기 키가 있는가 — 설정 화면에서 키를 저장·확인하면 다시 묻는다(10-08)
  let keyCheck = 0;
  const checkKeys = () => {
    const mine = ++keyCheck;
    void client.rpc(googleStatus, {}).then(
      (status) => {
        if (mine !== keyCheck) return;
        canSpeak = status.tts;
        refresh();
      },
      (error: unknown) => log(`selection read: key check failed ${String(error)}`),
    );
  };
  checkKeys();
  const stopKeys = onSharedSignal("googleKeys", checkKeys);
  // 켜기·끄기가 바뀌면 알약을 다시 그린다(끈 기능 멈추기는 생각 상자 쪽 thinking.tsx 가 재생기에 한다)
  const stopSettings = onSharedSignal("settings", refresh);
  const stopWatch = watchSelection((snapshot) => {
    const changed = (snapshot?.text ?? "") !== (selected?.text ?? "");
    selected = snapshot; // 같은 글이어도 범위는 최신으로
    if (changed) refresh();
  });
  const stopController = controller.subscribe(refresh);
  // 화면 폭이 좁은 화면 ↔ 넓은 화면으로 바뀌면 글자를 다시 그린다
  // 좁은 화면에서 읽기 조절 단추를 알약 줄 둘째 줄로(10-08) — web.ts startComposerRail
  const stopRail = startComposerRail();
  const stopWidth = watchCompactWidth(() => {
    for (const set of pills.values()) for (const pill of set.values()) pill.last = "";
    refresh();
  });

  return {
    observe,
    remove,
    dispose: () => {
      stopKeys();
      stopSettings();
      stopWatch();
      stopController();
      stopWidth();
      stopRail();
      reading?.highlight(null);
      controller.dispose(made);
      for (const id of [...pills.keys()]) remove(id);
    },
  };
}
