import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { translateKo } from "../shared/translate";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { uiLanguage } from "./appLanguage";
import { featureSwitches, onSharedSignal, speechOptions } from "./sounds";
import { thinkingBoundary } from "../shared/thinkingBoundary";
import { boxPhase, boxText, normalizeRate, saidText, splitParagraphs, ThinkingController, watchThinking, type ThinkingBoxState } from "./thinkingPlayer";
import { onThinkingAllOpen, thinkingAllOpen } from "./thinkingFold";
import { translationCache } from "./translationCache";
import { clearSelection, createThinkingAudio, elementText, readAppFontSizes, readLocal, listenTtsSpeedKeys, setHoverTitle, setNoTranslate, selectionStartIn, themeVar, watchSelection, writeLocal, type SelectionSnapshot } from "./web";

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
let pendingSavedRate: number | undefined;
export const thinkingController = new ThinkingController(createThinkingAudio(), (rate) => { pendingSavedRate = undefined; writeLocal(RATE_KEY, String(rate)); }, Date.now, uiLanguage);
const controller = thinkingController;
// 받은 번역을 이 기기에 7일 담아 두고 번역 전에 먼저 본다(10-10 리규형님 "번역된 것은 다시 번역해서 비용이 나가지 않게")
controller.cache = translationCache;
const savedRate = Number(readLocal(RATE_KEY));
controller.speedStep = speechOptions().speedStep;
controller.rate = normalizeRate(savedRate > 0 ? savedRate : 1, controller.speedStep);
pendingSavedRate = savedRate > 0 ? savedRate : undefined;
function applyReadingSettings(): void {
  const options = speechOptions();
  const value = options.ready && pendingSavedRate !== undefined ? pendingSavedRate : controller.rate;
  if (options.ready) pendingSavedRate = undefined;
  controller.applySpeedStep(options.speedStep, value);
}
applyReadingSettings();
const statuses = new Map<string, Promise<{ translate: boolean; tts: boolean }>>();
// 설정 화면에서 키를 저장·확인하면(10-08) 위 키 확인 기억을 비우고 떠 있는 상자들이 다시 묻게 한다
const keyListeners = new Set<() => void>();
// 화면에서 마지막으로 선택한 글(웹·데스크톱) — 상자의 읽기·번역읽기를 누르는 순간 선택이 풀려도 누름이 먼저 처리돼 이것을 쓴다
// (selectionRead 와 같은 방식, web.ts watchSelection)
let selected: SelectionSnapshot | null = null;
let domSerial = 0;
/** 상자에서 꺼낸 말 읽기(10-09) — 지금 읽는 말의 재생 상자와 그 말이 딸린 생각 상자 키. 재생기가 하나라 화면 전체에 하나 */
const saidReader: { box?: ThinkingBoxState; owner?: string; serial: number } = { serial: 0 };
// 문단 요소 이름 머리 — 호스트마다 이 파일이 따로 올라와 번호가 겹치지 않게 올라올 때마다 다른 글자를 붙인다
const DOM_PREFIX = `csb-think-${Math.random().toString(36).slice(2, 8)}-`;

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
    // 읽기는 화면에 보이는 문단 글을 읽는다(10-09 — 브라우저 번역기가 바꾼 글 그대로). 상자가 접혀 있거나 폰이면 null → 원문·플러그인 번역
    // 원문 보기면 원문 칸 글(10-10)
    box.screenText = web ? (index) => elementText(box.original ? `${domId}-o-${index}` : `${domId}-${index}`) : undefined;
    // SDK의 기존 연결을 관찰한다. 화면 밖에서도 새 문단·생각 완료를 받는다.
    box.watch = (update, error) => watchThinking(
      (handler) => client.paseo.agents.ref(agentId).timeline.subscribe(handler),
      () => box.text, update, error,
    );
    controller.update(box, text, phase);
  }, [box, rpc, text, phase, agentId, client, domId, web]);

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
  // 원문 보기(10-10)는 웹·PC 앱만 — 브라우저 번역기를 막은 원문 칸을 따로 그린다. 폰은 번역 아이콘 끄기가 곧 원문이다
  const original = web && !!box.original;
  const translated = box.translate && !original ? paragraphs.filter((p) => p.done && typeof box.translations.get(p.src) === "string").length : 0;
  const title = box.phase === "streaming" ? "Thinking…" : "Thinking";
  const buttonStyle = (active: boolean) => ({ borderRadius: 5, paddingHorizontal: layout.compact ? 5 : 7, paddingVertical: 4, backgroundColor: active ? c.accent : c.surface2 });
  // 읽는 중 녹색·소리 만드는 중 빙글빙글(10-11) — 답 아래 스피커(web.ts)와 같은 밝은 녹색
  const green = web ? themeVar("--colors-status-dot-success", c.statusSuccess) : c.statusSuccess;
  const spinner = (key: string) => <ActivityIndicator key={key} size={px - 3} color={green} accessibilityLabel="소리 만드는 중" />;
  const labelStyle = (active: boolean) => ({ color: active ? c.accentForeground : c.foregroundMuted, fontSize: px - 3 });
  // reading = 이 단추로 지금 읽는 중 — 강조색 대신 녹색 아이콘·테두리(10-11 리규형님 "TTS 가 시작되면 녹색")
  const button = (label: string, icons: string[], active: boolean, onPress: () => void, reading = false) => (
    <Pressable key={label} ref={(node) => setHoverTitle(node, label)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} onPress={() => {
      if (speechOptions().autoOpen) controller.expand(box);
      onPress();
    }} style={[buttonStyle(active && !reading), { flexDirection: "row", alignItems: "center", gap: 2, borderWidth: 1, borderColor: reading ? green : "transparent" }]}>
      {icons.map((name) => <Icon key={name} name={name} size={px - 1} color={reading ? green : active ? c.accentForeground : c.foregroundMuted} />)}
    </Pressable>
  );

  // 설정 화면 "번역·읽기" 칸에서 끈 기능의 버튼은 숨긴다(리규형님 10-08). 키가 없는 쪽도 지금처럼 숨긴다
  const features = featureSwitches();
  const canTranslate = keys.translate && features.translate;
  const canRead = web && keys.tts && features.tts;
  // 상자 안에서 글을 선택해 두고(한 글자라도) 누르면 그 문단, 그 글자부터 읽는다 — 선택이 없거나 이 상자 밖이면 처음부터(10-08).
  // 선택을 썼으면 푼다: 선택 색이 형광펜을 덮지 않게, 입력창 위 "선택 읽기" 알약도 숨게(selectionRead 와 같이)
  const startReading = (strict: boolean) => {
    const at = web && box.open ? selectionStartIn(selected?.token, paragraphs.map((_, i) => (original ? `${domId}-o-${i}` : `${domId}-${i}`))) : null;
    if (at) {
      selected = null;
      clearSelection();
    }
    controller.start(box, strict, at ?? undefined);
  };

  // 번역·읽기·번역읽기·최대화 — 위 머리줄과 아래 줄이 같이 쓴다(리규형님 10-07: 긴 생각을 펼치면 위로 한참 올라가야 해서 아래에도)
  const actionButtons = () => (
    <>
      {canTranslate ? button("번역", ["Languages"], box.translate, () => controller.toggleTranslation(box)) : null}
      {/* 원문 보기(10-10 리규형님 "번역본이면 원문으로, 원문이면 번역문으로") — 플러그인 번역이든 브라우저 번역이든. 번역 키가 없어도
          브라우저 번역기 글을 원문으로 돌릴 수 있게 웹이면 늘 보인다 */}
      {web ? button("원문 보기", ["FileText"], original, () => controller.toggleOriginal(box)) : null}
      {canRead ? button("읽기", ["Volume2"], playback.active && !playback.strict, () => startReading(false), playback.active && !playback.strict) : null}
      {canRead && playback.active && !playback.strict && playback.status === "loading" ? spinner("spin-read") : null}
      {canRead && canTranslate ? button("번역읽기", ["Languages", "Volume2"], playback.active && playback.strict, () => startReading(true), playback.active && playback.strict) : null}
      {canRead && canTranslate && playback.active && playback.strict && playback.status === "loading" ? spinner("spin-strict") : null}
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
  // 상태 글은 버튼 뒤 별도 영역. 제목 폭과 버튼 자리는 번역 진행에 따라 바뀌지 않는다.
  const actionStatus = () => (
    <View style={{ marginLeft: "auto", flexShrink: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
      {box.error ? <Text accessibilityLiveRegion="polite" numberOfLines={1} style={{ color: c.statusDanger, fontSize: px - 3, flexShrink: 1 }}>{box.error.slice(0, 100)}</Text> : null}
      {web && playback.active ? <Text style={labelStyle(false)}>{playback.paused ? "일시정지" : playback.status === "waiting" ? "다음 문단 대기" : playback.status === "loading" ? "소리 준비" : "읽는 중"}</Text> : null}
      {translated ? <Text style={labelStyle(false)}>{"번역 " + translated + "문단"}</Text> : null}
      {box.translate && box.pending.size ? <Text accessibilityLiveRegion="polite" style={labelStyle(false)}>번역 중</Text> : null}
    </View>
  );
  // 꺼낸 말 읽기 단추·조절 — 배경 없는 아이콘(Paseo 복사 단추·web.ts "이 말 읽기"와 같은 모양: 여백 4, 모서리 5)
  const plainIcon = (icon: string, label: string, onPress: () => void, reading = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ padding: 4, borderRadius: 5, alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={px - 1} color={reading ? green : c.foregroundMuted} />
    </Pressable>
  );
  const saidId = `${domId}-said`;
  const saidState = saidReader.owner === box.key && saidReader.box ? controller.state(saidReader.box) : undefined;
  const saidActive = web && !!saidState?.active;
  // 꺼낸 말 문단 — 생각 상자 본문처럼 문단마다 따로 그려 읽는 문단에 형광펜을 칠한다(10-09 리규형님 "단락별로 형광펜")
  const saidParagraphs = said ? splitParagraphs(said, "complete") : [];
  // 문단마다 그 문단을 읽을 때의 화면 글(브라우저 번역기가 바꾼 글) — 생각 상자 본문과 같은 방식(box.screenText). 재생기 문단 번호가
  // 화면 문단과 하나씩 맞아 형광펜 자리가 된다. 못 읽으면 그 문단 원문
  const readSaid = () => {
    if (!said.trim()) return;
    if (saidReader.box) controller.dispose(new Set([saidReader.box]));
    const next = controller.box(host.id, `said-${++saidReader.serial}`, Date.now(), said, "complete");
    next.screenText = web ? (index) => elementText(`${saidId}-${index}`) : undefined;
    next.rpc = rpc;
    saidReader.box = next;
    saidReader.owner = box.key;
    controller.start(next, false);
  };
  // 읽기 조절(이전·일시정지·중지·다음·속도)은 입력창 위 한 곳(web.ts startReadDock) — 10-11 리규형님 "컨트롤러를 여기로 통일".
  // 예전엔 상자 위·아래 두 곳과 꺼낸 말 밑에 따로 있었다

  return (
    <View style={{ marginVertical: 4 }}>
      <View style={{ borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: box.open }} onPress={() => controller.toggleOpen(box)} style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, gap: 6 }}>
            <Icon name={box.open ? "ChevronDown" : "ChevronRight"} size={px - 1} color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, fontSize: px - 2, flexShrink: 1 }}>{title}</Text>
          </Pressable>
          {actionButtons()}
          {actionStatus()}
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
              const cutSrc = reading && original ? controller.readingFrom(box, i, paragraph.src) : 0;
              const textStyle = { color: c.foreground, fontSize: px - 1, lineHeight: Math.round((px - 1) * 1.45) };
              return (
                <View key={i} style={{ marginBottom: i < paragraphs.length - 1 ? Math.round(px * 0.65) : 0 }}>
                  {/* 원문 보기 중에는 숨기기만 한다(10-10) — 지우면 브라우저 번역기가 바꿔 둔 글이 사라져 원문 보기를 끌 때 다시 번역한다 */}
                  <Text selectable nativeID={`${domId}-${i}`} style={original ? [textStyle, { display: "none" }] : textStyle}>
                    {/* 읽는 문단은 글줄마다 형광펜 — 안쪽 글 조각이라 줄 단위로 칠해진다(리규형님 10-06).
                        안쪽 조각은 늘 두고 색만 바꾼다(10-09) — 읽을 때 조각을 새로 만들면 브라우저 번역기가 바꿔 둔 글이 원문으로
                        돌아갔다가 다시 번역돼, 화면 글을 읽는 재생기가 그 사이 원문을 읽거나 다시 합성한다 */}
                    {cut > 0 ? shown.slice(0, cut) : null}
                    <Text style={reading ? { backgroundColor: READING_HIGHLIGHT } : undefined}>{cut > 0 ? shown.slice(cut) : shown}</Text>
                  </Text>
                  {original ? (
                    // 원문 칸 — 브라우저 번역을 막는다(setNoTranslate, 붙는 순간 표시가 달려 번역기가 손대지 않는다). 읽기·형광펜도 이 칸
                    <Text selectable ref={setNoTranslate} nativeID={`${domId}-o-${i}`} style={textStyle}>
                      {cutSrc > 0 ? paragraph.src.slice(0, cutSrc) : null}
                      <Text style={reading ? { backgroundColor: READING_HIGHLIGHT } : undefined}>{cutSrc > 0 ? paragraph.src.slice(cutSrc) : paragraph.src}</Text>
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        ) : null}
        {/* 펼쳐져 있으면 늘 아래에도 같은 버튼(접기 화살표·제목 없이 — 리규형님 10-07 결정) */}
        {box.open ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
            {actionButtons()}
            {actionStatus()}
          </View>
        ) : null}
      </View>
      {/* 상자에서 꺼낸 Claude 의 말 — 상자를 접어도 보이게 상자 밖에 본문 글 크기·색으로(10-09) */}
      {said ? (
        <View nativeID={saidId} style={{ marginTop: 8 }}>
          {saidParagraphs.map((paragraph, i) => (
            // 문단 사이는 예전 한 덩어리(빈 줄 하나)와 같은 높이. 안쪽 조각은 늘 두고 색만 바꾼다(번역기가 바꾼 글을 지키려고 — 위 본문과 같음)
            <Text key={i} selectable nativeID={`${saidId}-${i}`} style={{ marginTop: i ? Math.round(px * 1.5) : 0, color: c.foreground, fontSize: px, lineHeight: Math.round(px * 1.5) }}>
              <Text style={saidActive && saidState!.index === i ? { backgroundColor: READING_HIGHLIGHT } : undefined}>{paragraph.src}</Text>
            </Text>
          ))}
        </View>
      ) : null}
      {/* 그 말 읽기(10-09 리규형님 "복사 버튼이 없는 경우도 TTS 버튼이 있어야" · 결정 "그 말 하나만") — Paseo 말 블록에 붙는
          "이 말 읽기"(web.ts 턴·말 읽기 단추)와 같은 이름·모양. 읽는 중 녹색·소리 만드는 중 빙글빙글(10-11), 조절은 입력창 위 */}
      {said && canRead ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 2 }}>
          {plainIcon("Volume2", saidActive ? "이 말 읽기(읽는 중)" : "이 말 읽기", readSaid, saidActive)}
          {saidActive && saidState!.status === "loading" ? spinner("spin-said") : null}
        </View>
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
  applyReadingSettings();
  const stopSpeedKeys = listenTtsSpeedKeys(() => ({ active: controller.isReading(), adjust: (direction) => controller.stepSpeed(direction) }));
  controller.setAllOpen(thinkingAllOpen());
  const stopFold = onThinkingAllOpen((open) => controller.setAllOpen(open));
  // 상자 안 선택 자리부터 읽기(10-08) — 마지막 선택을 기억해 둔다(웹·데스크톱만, 폰은 아무것도 안 함)
  const stopSelection = watchSelection((snapshot) => {
    selected = snapshot;
  });
  // 설정 화면 "번역·읽기" 칸(10-08): 끄면 그 기능을 멈추고(버튼은 그릴 때 숨는다), 키를 저장·확인하면 호스트별 키 확인을 다시 한다
  const stopSettings = onSharedSignal("settings", () => {
    const features = featureSwitches();
    applyReadingSettings();
    controller.applyFeatures(features.translate, features.tts);
  });
  const stopKeys = onSharedSignal("googleKeys", () => {
    statuses.clear();
    for (const listener of [...keyListeners]) listener();
  });
  return () => {
    stopSpeedKeys();
    stopKeys();
    stopSettings();
    stopSelection();
    stopFold();
    if (saidReader.box) controller.dispose(new Set([saidReader.box]));
    saidReader.box = undefined;
    saidReader.owner = undefined;
    controller.dispose(owned);
    for (const box of owned) statuses.delete(box.hostId);
    a();
    b();
  };
}
