import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { translateKo } from "../shared/translate";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { splitParagraphs, ThinkingController, watchThinking, type ThinkingBoxState } from "./thinkingPlayer";
import { onThinkingAllOpen, thinkingAllOpen } from "./thinkingFold";
import { createThinkingAudio, readAppFontSizes, readLocal, writeLocal } from "./web";

const KIND = "csb-thinking";
const schema = z.object({ text: z.string(), phase: z.enum(["streaming", "complete"]) });
type Data = z.infer<typeof schema>;
const MAX_BODY_HEIGHT = 240;
// 읽는 문단 형광펜 — 크롬 확장 read-aloud-hrg 의 문단 강조색(js/events.js:374)과 같다
const READING_HIGHLIGHT = "rgba(255, 226, 0, 0.3)";
const CONTENT_DEFAULT_PX = 15;
const RATE_KEY = "claude-state-bar:thinking-rate";

// 컴포넌트 수명과 독립된 상태. 호스트 키 확인도 한 번만 한다.
// 입력창 위 선택 읽기 알약(selectionRead.tsx)도 이 재생기를 같이 쓴다 — 그래서 한 번에 하나만 읽힌다
export const thinkingController = new ThinkingController(createThinkingAudio(), (rate) => writeLocal(RATE_KEY, String(rate)));
const controller = thinkingController;
const savedRate = Number(readLocal(RATE_KEY));
if (Number.isFinite(savedRate) && savedRate >= 0.333 && savedRate <= 3) controller.rate = savedRate;
const statuses = new Map<string, Promise<{ translate: boolean; tts: boolean }>>();

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
  const identity = useRef<ThinkingBoxState | undefined>(undefined);
  const box = controller.box(host.id, agentId, timestamp.getTime(), text, phase, identity.current);
  identity.current = box;
  owned.add(box);
  const scrollRef = useRef<ScrollView>(null);
  const atBottom = useRef(true);
  const c = theme.colors;
  const px = readAppFontSizes().content ?? CONTENT_DEFAULT_PX;
  const web = Platform.OS === "web";

  useEffect(() => controller.subscribe(() => bump((n) => n + 1)), []);
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
  }, [host.id, statusRpc, box]);

  useEffect(() => {
    box.rpc = rpc;
    // SDK의 기존 연결을 관찰한다. 화면 밖에서도 새 문단·생각 완료를 받는다.
    box.watch = (update, error) => watchThinking(
      (handler) => client.paseo.agents.ref(agentId).timeline.subscribe(handler),
      () => box.text, update, error,
    );
    controller.update(box, text, phase);
  }, [box, rpc, text, phase, agentId, client]);

  const paragraphs = splitParagraphs(box.text, box.phase);
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

  // 번역·읽기·번역읽기·최대화 — 위 머리줄과 아래 줄이 같이 쓴다(리규형님 10-07: 긴 생각을 펼치면 위로 한참 올라가야 해서 아래에도)
  const actionButtons = () => (
    <>
      {keys.translate ? button("번역", box.translate, () => controller.toggleTranslation(box)) : null}
      {web && keys.tts ? button("읽기", playback.active && !playback.strict, () => controller.start(box, false)) : null}
      {web && keys.translate && keys.tts ? button("번역읽기", playback.active && playback.strict, () => controller.start(box, true)) : null}
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
            {paragraphs.map((paragraph, i) => (
              <View key={i} style={{ marginBottom: i < paragraphs.length - 1 ? Math.round(px * 0.65) : 0 }}>
                <Text selectable style={{ color: c.foreground, fontSize: px - 1, lineHeight: Math.round((px - 1) * 1.45) }}>
                  {/* 읽는 문단은 글줄마다 형광펜 — 안쪽 글 조각이라 줄 단위로 칠해진다(리규형님 10-06) */}
                  {web && playback.active && playback.index === i ? (
                    <Text style={{ backgroundColor: READING_HIGHLIGHT }}>{controller.shown(box, paragraph)}</Text>
                  ) : (
                    controller.shown(box, paragraph)
                  )}
                </Text>
              </View>
            ))}
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
  return () => {
    stopFold();
    controller.dispose(owned);
    for (const box of owned) statuses.delete(box.hostId);
    a();
    b();
  };
}
