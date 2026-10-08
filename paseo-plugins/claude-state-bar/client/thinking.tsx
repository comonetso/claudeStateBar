import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { translateKo } from "../shared/translate";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { uiLanguage } from "./appLanguage";
import { featureSwitches, onSharedSignal } from "./sounds";
import { thinkingBoundary } from "../shared/thinkingBoundary";
import { boxPhase, boxText, saidText, splitParagraphs, ThinkingController, watchThinking, type ThinkingBoxState } from "./thinkingPlayer";
import { onThinkingAllOpen, thinkingAllOpen } from "./thinkingFold";
import { clearSelection, createThinkingAudio, readAppFontSizes, readLocal, selectionStartIn, watchSelection, writeLocal, type SelectionSnapshot } from "./web";

const KIND = "csb-thinking";
const schema = z.object({ text: z.string(), phase: z.enum(["streaming", "complete"]) });
type Data = z.infer<typeof schema>;
const MAX_BODY_HEIGHT = 240;
// 읽는 문단 형광펜 — 크롬 확장 read-aloud-hrg 의 문단 강조색(js/events.js:374)과 같다
const READING_HIGHLIGHT = "rgba(255, 226, 0, 0.3)";
const CONTENT_DEFAULT_PX = 15;
const RATE_KEY = "claude-state-bar:thinking-rate";

// 컴포넌트 수명과 독립된 상태. 호스트 키 확인도 한 번만 한다.
// 입력창 위 선택 읽기 알약(selectionRead.tsx)도 이 재생기를 같이 쓴다 — 그래서 한 번에 하나만 읽힌다.
// 번역 대상·읽기 음성 언어는 Paseo 언어 설정(10-08 — 한국어면 한국어로, 그 밖은 영어로). 부를 때마다 다시 읽는다
export const thinkingController = new ThinkingController(createThinkingAudio(), (rate) => writeLocal(RATE_KEY, String(rate)), Date.now, uiLanguage);
const controller = thinkingController;
const savedRate = Number(readLocal(RATE_KEY));
if (Number.isFinite(savedRate) && savedRate >= 0.333 && savedRate <= 3) controller.rate = savedRate;
const statuses = new Map<string, Promise<{ translate: boolean; tts: boolean }>>();
// 설정 화면에서 키를 저장·확인하면(10-08) 위 키 확인 기억을 비우고 떠 있는 상자들이 다시 묻게 한다
const keyListeners = new Set<() => void>();
// 화면에서 마지막으로 선택한 글(웹·데스크톱) — 상자의 읽기·번역읽기를 누르는 순간 선택이 풀려도 누름이 먼저 처리돼 이것을 쓴다
// (selectionRead 와 같은 방식, web.ts watchSelection)
let selected: SelectionSnapshot | null = null;
let domSerial = 0;
// 문단 요소 이름 머리 — 호스트마다 이 파일이 따로 올라와 번호가 겹치지 않게 올라올 때마다 다른 글자를 붙인다
const DOM_PREFIX = `csb-think-${Math.random().toString(36).slice(2, 8)}-`;

/** 읽기 속도 슬라이더(BluemingReadAloud 하단 바 규칙: −1~1, 0.05 눈금, 3^v). 생각 상자 컨트롤러와 입력창 위 속도 알약이 같이 쓴다 */
export function SpeedSlider({ colors: c, compact, px }: { colors: PluginTheme["colors"]; compact: boolean; px: number }) {
  const [, bump] = useState(0);
  const [width, setWidth] = useState(140);
  useEffect(() => controller.subscribe(() => bump((n) => n + 1)), []);
  const value = Math.max(-1, Math.min(1, Math.log(controller.rate) / Math.log(3)));
  const move = (x: number) => controller.setSpeed((x / width) * 2 - 1);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        accessibilityRole="adjustable" accessibilityLabel="TTS 속도" accessibilityValue={{ min: 0.333, max: 3, now: controller.rate, text: `${controller.rate.toFixed(2)}x` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => controller.setSpeed(value + (e.nativeEvent.actionName === "increment" ? 0.05 : -0.05))}
        style={{ width: compact ? 110 : 140, height: 28, justifyContent: "center" }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => move(e.nativeEvent.locationX)}
        onResponderMove={(e) => move(e.nativeEvent.locationX)}
      >
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: c.border }} />
        <View pointerEvents="none" style={{ position: "absolute", height: 4, borderRadius: 2, width: `${(value + 1) * 50}%`, backgroundColor: c.accent }} />
        <View pointerEvents="none" style={{ position: "absolute", width: 12, height: 12, borderRadius: 6, left: `${(value + 1) * 50}%`, marginLeft: -6, backgroundColor: c.accent }} />
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: px - 3 }}>{controller.rate.toFixed(2)}x</Text>
    </View>
  );
}

function ThinkingBox({ theme, item, agentId, timestamp, host, layout, client, owned }: PluginTimelineItemProps<Data> & {
  client: PluginClientContext;
  owned: Set<ThinkingBoxState>;
}) {
  const { text, phase } = item.data;
  const translate = useRpc(translateKo);
  const synthesize = useRpc(ttsSynthesize);
  const statusRpc = useRpc(googleStatus);
  const rpc = useMemo(() => ({ translate, synthesize }), [translate, synthesize]);
  const [, bump] = useState(0);
  const [keys, setKeys] = useState({ translate: false, tts: false });
  const [keysRev, setKeysRev] = useState(0);
  // 문단 요소 이름(웹에서 id) — 선택한 자리가 어느 문단인지 표준 Selection·Range 로 찾는다(10-08)
  const domId = useMemo(() => `${DOM_PREFIX}${++domSerial}`, []);
  const identity = useRef<ThinkingBoxState | undefined>(undefined);
  const box = controller.box(host.id, agentId, timestamp.getTime(), text, phase, identity.current);
  identity.current = box;
  owned.add(box);
  const scrollRef = useRef<ScrollView>(null);
  const atBottom = useRef(true);
  const boundary = useRpc(thinkingBoundary);
  const asking = useRef<{ busy: boolean; again: boolean; alive: boolean }>({ busy: false, again: false, alive: true });
  const c = theme.colors;
  const px = readAppFontSizes().content ?? CONTENT_DEFAULT_PX;
  const web = Platform.OS === "web";

  useEffect(() => controller.subscribe(() => bump((n) => n + 1)), []);
  useEffect(() => {
    const listener = () => setKeysRev((n) => n + 1);
    keyListeners.add(listener);
    return () => { keyListeners.delete(listener); };
  }, []);
  useEffect(() => {
    let live = true;
    let status = statuses.get(host.id);
    if (!status) {
      status = statusRpc({});
      statuses.set(host.id, status);
    }
    void status.then((result) => { if (live) setKeys(result); }, (error: unknown) => {
      if (live) { box.error = `키 확인 실패: ${String(error)}`; bump((n) => n + 1); }
    });
    return () => { live = false; };
  }, [host.id, statusRpc, box, keysRev]);

  useEffect(() => {
    box.rpc = rpc;
    // SDK의 기존 연결을 관찰한다. 화면 밖에서도 새 문단·생각 완료를 받는다.
    box.watch = (update, error) => watchThinking(
      (handler) => client.paseo.agents.ref(agentId).timeline.subscribe(handler),
      () => box.text, update, error,
    );
    controller.update(box, text, phase);
  }, [box, rpc, text, phase, agentId, client]);

  // 상자에 섞인 Claude 의 말(마지막 생각 칸)이 어디서 시작하는지 데몬에 묻는다(10-09, shared/thinkingBoundary.ts).
  // 한 번에 하나만 묻고, 답을 기다리는 사이 글이 늘었으면 답이 온 뒤 최신 글로 다시 묻는다(정해 둔 시간 간격 없음).
  // 데몬이 원본 기록에서 못 찾으면 null — 상자를 통째로 둔다
  useEffect(() => () => { asking.current.alive = false; }, []);
  useEffect(() => {
    const ask = () => {
      const state = asking.current;
      if (box.cut != null || !state.alive) return;
      if (state.busy) {
        state.again = true;
        return;
      }
      state.busy = true;
      state.again = false;
      const sent = box.text.replace(/\r/g, "");
      // 못 찾으면 데몬이 기록에 적힐 때까지 기다렸다 답한다(늘). 10-09: 처음엔 phase === "streaming" 일 때만 기다렸는데 Paseo 는
      // 같은 턴이어도 맨 끝 몇 개가 아닌 항목은 "complete" 로 넘겨 대부분 기다리지 않았고, 기록이 늦게 적힌 상자가 남았다.
      // 지난 대화 상자는 대개 기록에 이미 있어 바로 찾는다. 턴이 끝나면 한 번 더 묻는다(아래 phase)
      void boundary({ agentId, text: sent, wait: true })
        .then((result) => {
          if (state.alive && result.cut != null && box.text.replace(/\r/g, "").startsWith(sent.slice(0, result.cut))) controller.setCut(box, result.cut);
        }, () => {})
        .finally(() => {
          state.busy = false;
          if (state.again) ask();
        });
    };
    ask();
  }, [box, box.text, phase, agentId, boundary]);

  // 상자 글은 들어오는 대로 바로 보인다. 데몬 답이 오면 Claude 의 말 부분만 상자 밖으로 옮긴다.
  // 10-09 04:28 에 "답이 온 글까지만 상자에 보이기"를 넣었다가 걷었다 — 기록은 도구 호출 직전에야 적혀 생각 상자가 실시간으로
  // 흐르지 않고 수십 초 뒤 한꺼번에 나왔다(리규형님 "말이 2초 늦게 나오는 것보다 훨씬 더 심각"). 말이 상자 안에 잠깐
  // 비쳤다가 밖으로 옮겨지는 것은 그대로 둔다
  const paragraphs = splitParagraphs(boxText(box), boxPhase(box));
  const said = saidText(box);
  const playback = controller.state(box);
  const translated = box.translate ? paragraphs.filter((p) => p.done && typeof box.translations.get(p.src) === "string").length : 0;
  const title = `${box.phase === "streaming" ? "Thinking…" : "Thinking"}${translated ? ` · 번역 ${translated}문단` : ""}${box.pending.size ? " · 번역 중" : ""}`;
  const buttonStyle = (active: boolean) => ({ borderRadius: 5, paddingHorizontal: layout.compact ? 5 : 7, paddingVertical: 4, backgroundColor: active ? c.accent : c.surface2 });
  const labelStyle = (active: boolean) => ({ color: active ? c.accentForeground : c.foregroundMuted, fontSize: px - 3 });
  const button = (label: string, active: boolean, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} onPress={onPress} style={buttonStyle(active)}>
      <Text style={labelStyle(active)}>{label}</Text>
    </Pressable>
  );

  // 설정 화면 "번역·읽기" 칸에서 끈 기능의 버튼은 숨긴다(리규형님 10-08). 키가 없는 쪽도 지금처럼 숨긴다
  const features = featureSwitches();
  const canTranslate = keys.translate && features.translate;
  const canRead = web && keys.tts && features.tts;
  // 상자 안에서 글을 선택해 두고(한 글자라도) 누르면 그 문단, 그 글자부터 읽는다 — 선택이 없거나 이 상자 밖이면 처음부터(10-08).
  // 선택을 썼으면 푼다: 선택 색이 형광펜을 덮지 않게, 입력창 위 "선택 읽기" 알약도 숨게(selectionRead 와 같이)
  const startReading = (strict: boolean) => {
    const at = web && box.open ? selectionStartIn(selected?.token, paragraphs.map((_, i) => `${domId}-${i}`)) : null;
    if (at) {
      selected = null;
      clearSelection();
    }
    controller.start(box, strict, at ?? undefined);
  };

  // 번역·읽기·번역읽기·최대화 — 위 머리줄과 아래 줄이 같이 쓴다(리규형님 10-07: 긴 생각을 펼치면 위로 한참 올라가야 해서 아래에도)
  const actionButtons = () => (
    <>
      {canTranslate ? button("번역", box.translate, () => controller.toggleTranslation(box)) : null}
      {canRead ? button("읽기", playback.active && !playback.strict, () => startReading(false)) : null}
      {canRead && canTranslate ? button("번역읽기", playback.active && playback.strict, () => startReading(true)) : null}
      {box.open ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={box.maximized ? "상자 원래 크기로" : "상자 최대화"}
          onPress={() => controller.toggleMaximized(box)}
          style={buttonStyle(false)}
        >
          <Icon name={box.maximized ? "Minimize2" : "Maximize2"} size={px - 3} color={c.foregroundMuted} />
        </Pressable>
      ) : null}
    </>
  );
  // 읽는 동안 늘 보이고 중지·다 읽음이면 사라진다 — 설정 아이콘 없이(리규형님 10-06). 상자 아래와 위 오른쪽(10-07) 두 곳
  const readControls = (top: boolean) =>
    web && playback.active ? (
      <View style={{ alignSelf: "flex-end", maxWidth: "100%", flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 6, ...(top ? { marginBottom: 4 } : { marginTop: 4 }), padding: 6, borderRadius: 6, backgroundColor: c.surface1 }}>
        {button("이전", false, () => controller.previous())}
        {button(playback.paused ? "재생" : "일시정지", false, () => playback.paused ? controller.resume() : controller.pause())}
        {button("중지", false, () => controller.stop())}
        {button("다음", false, () => controller.next())}
        <SpeedSlider colors={c} compact={layout.compact} px={px} />
      </View>
    ) : null;

  return (
    <View style={{ marginVertical: 4 }}>
      {readControls(true)}
      <View style={{ borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: box.open }} onPress={() => controller.toggleOpen(box)} style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, gap: 6 }}>
            <Icon name={box.open ? "ChevronDown" : "ChevronRight"} size={px - 1} color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, fontSize: px - 2, flexShrink: 1 }}>{title}</Text>
          </Pressable>
          {actionButtons()}
          {box.error ? <Text accessibilityLiveRegion="polite" numberOfLines={1} style={{ color: c.statusDanger, fontSize: px - 3, flexShrink: 1 }}>{box.error.slice(0, 100)}</Text> : null}
          {web && playback.active ? <Text style={{ color: c.foregroundMuted, fontSize: px - 3 }}>{playback.paused ? "일시정지" : playback.status === "waiting" ? "다음 문단 대기" : playback.status === "loading" ? "소리 준비" : "읽는 중"}</Text> : null}
        </View>
        {box.open ? (
          <ScrollView
            ref={scrollRef}
            style={box.maximized ? undefined : { maxHeight: MAX_BODY_HEIGHT }}
            contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
            scrollEventThrottle={100}
            onScroll={(e) => {
              const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
              atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
            }}
            onContentSizeChange={() => {
              if (!atBottom.current) return;
              requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
            }}
          >
            {paragraphs.map((paragraph, i) => {
              const shown = controller.shown(box, paragraph);
              const reading = web && playback.active && playback.index === i;
              // 선택한 글자부터 읽는 중이면 그 글자부터만 칠한다(10-08)
              const cut = reading ? controller.readingFrom(box, i, shown) : 0;
              return (
                <View key={i} style={{ marginBottom: i < paragraphs.length - 1 ? Math.round(px * 0.65) : 0 }}>
                  <Text selectable nativeID={`${domId}-${i}`} style={{ color: c.foreground, fontSize: px - 1, lineHeight: Math.round((px - 1) * 1.45) }}>
                    {/* 읽는 문단은 글줄마다 형광펜 — 안쪽 글 조각이라 줄 단위로 칠해진다(리규형님 10-06) */}
                    {reading ? (
                      <>
                        {cut > 0 ? shown.slice(0, cut) : null}
                        <Text style={{ backgroundColor: READING_HIGHLIGHT }}>{cut > 0 ? shown.slice(cut) : shown}</Text>
                      </>
                    ) : (
                      shown
                    )}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        ) : null}
        {/* 펼쳐져 있으면 늘 아래에도 같은 버튼(접기 화살표·제목 없이 — 리규형님 10-07 결정) */}
        {box.open ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
            {actionButtons()}
          </View>
        ) : null}
      </View>
      {readControls(false)}
      {/* 상자에서 꺼낸 Claude 의 말 — 상자를 접어도 보이게 상자 밖에 본문 글 크기·색으로(10-09) */}
      {said ? (
        <Text selectable style={{ marginTop: 8, color: c.foreground, fontSize: px, lineHeight: Math.round(px * 1.5) }}>
          {said}
        </Text>
      ) : null}
    </View>
  );
}

export function registerThinking(client: PluginClientContext): () => void {
  const owned = new Set<ThinkingBoxState>();
  const Component = (props: PluginTimelineItemProps<Data>) => <ThinkingBox {...props} client={client} owned={owned} />;
  const a = client.addTimelineTransformer({
    id: "thinking-ko",
    query: { itemType: "reasoning" },
    transform: ({ item, phase }) => ({ items: [{ type: "plugin", kind: KIND, version: 1, data: { text: item.text, phase } }] }),
  });
  const b = client.addTimelineRenderer({ kind: KIND, version: 1, schema, Component });
  // 입력창 위 "생각 상자 모두 접기·펼치기" 알약의 상태를 따른다(10-08, thinkingFold) — 기억된 상태로 시작하고 바뀌면 전부 따라간다
  controller.setAllOpen(thinkingAllOpen());
  const stopFold = onThinkingAllOpen((open) => controller.setAllOpen(open));
  // 상자 안 선택 자리부터 읽기(10-08) — 마지막 선택을 기억해 둔다(웹·데스크톱만, 폰은 아무것도 안 함)
  const stopSelection = watchSelection((snapshot) => {
    selected = snapshot;
  });
  // 설정 화면 "번역·읽기" 칸(10-08): 끄면 그 기능을 멈추고(버튼은 그릴 때 숨는다), 키를 저장·확인하면 호스트별 키 확인을 다시 한다
  const stopSettings = onSharedSignal("settings", () => {
    const features = featureSwitches();
    controller.applyFeatures(features.translate, features.tts);
  });
  const stopKeys = onSharedSignal("googleKeys", () => {
    statuses.clear();
    for (const listener of [...keyListeners]) listener();
  });
  return () => {
    stopKeys();
    stopSettings();
    stopSelection();
    stopFold();
    controller.dispose(owned);
    for (const box of owned) statuses.delete(box.hostId);
    a();
    b();
  };
}
