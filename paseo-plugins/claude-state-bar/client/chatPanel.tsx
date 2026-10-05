import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { chatTrashMove, codexChats, type ChatCard } from "../shared/codex";
import { ChatTrashDrawer } from "./chatTrash";
import { fmtClock } from "./format";
import { NoticeLine, panelStyles, StatusChip, useNotice } from "./ui";
import { useFontScale } from "./fontScale";

// 확장 Codex 채팅 탭(media/codexchat.js): codex_rescue 채팅(핑퐁) 대화 카드, 펼치면 턴마다 Claude 말 · Codex 말.
// 턴 펼침 규칙(리규형님 08-23 결정, 다시 정하지 않는다):
//   · 대화마다 펼친 턴은 하나 — 처음 보는 대화는 첫 턴(처음부터 읽는다), 보던 대화에 새 턴이 오면 마지막 턴
//   · 손으로 접거나 편 턴은 그대로 둔다(옛 턴을 읽는 중에 답이 와도 접히지 않는다)
//   · 처음 열면 맨 위. 바닥에 있을 때만 새 답을 따라 내려가고, 아니면 "새 답변 ↓" 버튼
// 휴지통: 대화마다 🗑(묻지 않고 .chat_trash/ 로) · 완전 삭제·비우기만 확인(chatTrash.tsx).
// 지난 대화: 이번 세션(열린 대화 중 가장 이른 시작) 뒤로 턴이 없는 대화는 "지난 대화 N건" 한 줄에 접는다(열 때마다 닫힘, 확장과 같음).

// 확장과 같은 간격: 진행 중인 턴이 있으면 2초, 아니면 30초
const LIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 30000;
// 바닥으로 칠 여유(확장 BOTTOM_SLACK) — 휠 한 칸에 "벗어났다"로 읽지 않게
const BOTTOM_SLACK = 80;

type Entry = ChatCard["entries"][number];

/** 대화의 첫 턴 또는 마지막 턴 번호. 턴이 아직 없으면 null */
function edgeTurnNo(c: ChatCard, wantLast: boolean): number | null {
  let n: number | null = null;
  for (const e of c.entries) {
    if (e.type !== "turn" && e.type !== "pending") continue;
    if (n === null || wantLast) n = e.n;
    if (!wantLast) break;
  }
  return n;
}

function firstLine(s: string): string {
  const v = s.trim();
  const nl = v.indexOf("\n");
  return nl < 0 ? v : v.slice(0, nl);
}

export function CodexChatPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const fetchChats = useRpc(codexChats);
  const [chats, setChats] = useState<ChatCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 대화 카드 펼침: 처음 볼 때 정해지고(가장 최근 대화만 펼침) 그다음은 누른 대로
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 손으로 정한 턴만 들어 있다(true 접힘 · false 펼침). 없는 턴은 포커스 규칙이 정한다
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const focus = useRef<Record<string, number | null>>({});
  const seenCount = useRef<Record<string, number>>({});
  const lastCount = useRef<number | null>(null);
  const [jump, setJump] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const view = useRef({ y: 0, height: 0, content: 0 });
  const fontScale = useFontScale();
  const styles = useMemo(() => panelStyles(theme, layout.compact, fontScale), [theme, layout.compact, fontScale]);
  const c = theme.colors;
  const moveChat = useRpc(chatTrashMove);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashKey, setTrashKey] = useState(0);
  const { notice, notify } = useNotice();
  const [olderOpen, setOlderOpen] = useState(false);

  const atBottom =(contentHeight: number) => view.current.y + view.current.height >= contentHeight - BOTTOM_SLACK;

  // 마지막에 시작한 읽기의 답만 반영한다 — 늦게 온 옛 답이 새 목록을 덮던 것(Codex 검토 10-05). 폴더가 바뀌면 진행 중인 답도 버린다
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [directory],
  );
  const load = useCallback(async () => {
    if (!directory) return;
    const mine = ++seq.current;
    try {
      const next = (await fetchChats({ cwd: directory })).chats;
      if (mine !== seq.current) return;
      // 포커스는 받은 그대로 옮긴다: 처음 보는 대화는 첫 턴, 항목이 늘어난 대화는 마지막 턴
      let count = 0;
      for (const ch of next) {
        const before = seenCount.current[ch.stamp];
        seenCount.current[ch.stamp] = ch.entries.length;
        if (before === undefined) focus.current[ch.stamp] = edgeTurnNo(ch, false);
        else if (ch.entries.length > before) focus.current[ch.stamp] = edgeTurnNo(ch, true);
        count += ch.entries.length;
      }
      // 기본으로 펼치는 대화는 이번 세션의 최신 것(확장 newestCurrentStamp) — 다시 읽는 것은 거의 늘 방금 한 대화다
      const openStamp = next.find((ch) => ch.current)?.stamp;
      setCollapsed((prev) => {
        const out = { ...prev };
        for (const ch of next) if (out[ch.stamp] === undefined) out[ch.stamp] = ch.stamp !== openStamp;
        return out;
      });
      // 새 턴이 왔는데 바닥에 있지 않으면 버튼만 띄운다(첫 그림과 같은 내용 다시 그리기는 아님)
      const grew = lastCount.current !== null && count > lastCount.current;
      lastCount.current = count;
      if (grew && !atBottom(view.current.content)) setJump(true);
      setChats(next);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    }
  }, [directory, fetchChats]);

  const live = !!chats?.some((ch) => ch.live);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [load, live]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    view.current = { y: contentOffset.y, height: layoutMeasurement.height, content: contentSize.height };
    if (jump && atBottom(contentSize.height)) setJump(false);
  };

  // 내용 높이가 바뀌면: 첫 그림은 맨 위 그대로, 그다음은 바로 전까지 바닥에 있었을 때만 따라 내려간다
  const onContentSizeChange = (_w: number, h: number) => {
    const prev = view.current.content;
    view.current.content = h;
    if (prev > 0 && h > prev && atBottom(prev)) {
      scroll.current?.scrollToEnd({ animated: false });
      setJump(false);
    }
  };

  if (!directory) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.muted}>작업 공간 폴더를 읽는 중입니다</Text>
        </View>
      </View>
    );
  }

  const bubble = (who: "claude" | "codex", text: string, waiting = false) => (
    <View style={{ gap: 2, paddingLeft: who === "codex" ? 12 : 0 }}>
      <Text style={[styles.small, { fontWeight: "600" as const, color: who === "claude" ? c.accent : c.foregroundMuted }]}>
        {who === "claude" ? "✳️ 클로드" : "🔷 코덱스"}
      </Text>
      <Text style={[styles.text, { fontSize: styles.fs(13), lineHeight: styles.fs(19) }, waiting ? { color: c.foregroundMuted } : {}]} selectable={!waiting}>
        {waiting ? "답을 기다리는 중…" : text || "(비어 있음)"}
      </Text>
    </View>
  );

  // 묻지 않고 휴지통으로 — 되돌릴 수 있는 곳이다(확장 onDelete)
  const toTrash = async (ch: ChatCard) => {
    try {
      const { moved } = await moveChat({ cwd: directory, stamp: ch.stamp });
      if (moved) notify("휴지통으로 옮겼습니다. 위 🗑 휴지통에서 다시 꺼낼 수 있습니다.");
    } catch (e) {
      notify(`휴지통으로 옮기지 못했습니다: ${String(e)}`, "warn");
    }
    setTrashKey((k) => k + 1);
    void load();
  };

  const foldedNow = (ch: ChatCard, n: number) => {
    const v = folded[`${ch.stamp}#${n}`];
    if (v === true || v === false) return v;
    return focus.current[ch.stamp] !== n;
  };

  const renderTurn = (ch: ChatCard, e: Extract<Entry, { type: "turn" | "pending" }>, k: number) => {
    // 진행 중인 턴도 끝난 턴과 같은 열쇠 — 답을 기다리는 동안 접어 둔 것이 답이 오자마자 펼쳐지지 않게
    const key = `${ch.stamp}#${e.n}`;
    const isFolded = foldedNow(ch, e.n);
    const peek = isFolded ? firstLine(e.claude) : "";
    return (
      <View key={`${e.type}${e.n}-${k}`} style={{ gap: 6 }}>
        {/* 그려진 상태를 뒤집는다(포커스 규칙이 접은 턴은 저장된 값이 없다) */}
        <Pressable style={styles.head} onPress={() => setFolded({ ...folded, [key]: !isFolded })} accessibilityRole="button">
          <Text style={styles.muted}>{isFolded ? "▸" : "▾"}</Text>
          <Text style={styles.section}>
            {e.n}턴{e.time ? `  ·  ${e.time}` : ""}
          </Text>
          {peek ? (
            <Text style={[styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
              {peek}
            </Text>
          ) : null}
        </Pressable>
        {isFolded ? null : (
          <View style={{ gap: 8 }}>
            {e.claude ? bubble("claude", e.claude) : null}
            {e.type === "pending" ? bubble("codex", "", true) : bubble("codex", e.codex)}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        ref={scroll}
        style={styles.screen}
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onLayout={(e) => (view.current.height = e.nativeEvent.layout.height)}
        onContentSizeChange={onContentSizeChange}
      >
        <NoticeLine notice={notice} theme={theme} />
        <View style={styles.actions}>
          <Pressable style={styles.button} onPress={() => setTrashOpen(!trashOpen)} accessibilityRole="button">
            <Text style={styles.buttonText}>{trashOpen ? "▾" : "▸"} 🗑 휴지통</Text>
          </Pressable>
        </View>
        {trashOpen ? (
          <ChatTrashDrawer cwd={directory} styles={styles} theme={theme} notify={notify} onChanged={() => void load()} reloadKey={trashKey} />
        ) : null}
        {error ? <Text style={styles.error}>목록을 읽지 못했습니다: {error}</Text> : null}
        {!chats ? <Text style={styles.muted}>읽는 중입니다</Text> : null}
        {chats && chats.length === 0 ? <Text style={styles.muted}>이 작업 공간에 아직 Codex 대화가 없습니다</Text> : null}

        {chats?.filter((ch) => ch.current).map(renderChat)}
        {chats && chats.some((ch) => !ch.current) ? (
          <View style={{ gap: 8 }}>
            <Pressable style={styles.button} onPress={() => setOlderOpen(!olderOpen)} accessibilityRole="button">
              <Text style={styles.buttonText}>
                {olderOpen ? "▾" : "▸"} 지난 대화 {chats.filter((ch) => !ch.current).length}건
              </Text>
            </Pressable>
            {olderOpen ? chats.filter((ch) => !ch.current).map(renderChat) : null}
          </View>
        ) : null}
      </ScrollView>
      {jump ? (
        <Pressable
          style={[styles.button, { position: "absolute", right: 16, bottom: 16, backgroundColor: c.accent }]}
          onPress={() => {
            scroll.current?.scrollToEnd({ animated: true });
            setJump(false);
          }}
          accessibilityRole="button"
        >
          <Text style={[styles.buttonText, { color: c.accentForeground }]}>새 답변 ↓</Text>
        </Pressable>
      ) : null}
    </View>
  );

  function renderChat(ch: ChatCard) {
    const turns = ch.entries.filter((e) => e.type === "turn").length;
    const isOpen = collapsed[ch.stamp] === false;
    return (
      <View key={ch.stamp} style={styles.card}>
        <Pressable style={styles.head} onPress={() => setCollapsed({ ...collapsed, [ch.stamp]: isOpen })} accessibilityRole="button">
          <Text style={styles.muted}>{isOpen ? "▾" : "▸"}</Text>
          <Text style={styles.title} numberOfLines={2}>
            {ch.subject || ch.slug}
          </Text>
          <Text style={styles.muted}>{[`${turns}턴`, ch.origin ?? "", fmtClock(ch.lastAtMs)].filter(Boolean).join(" · ")}</Text>
          {ch.live ? (
            <StatusChip label="대화 중" color={c.accent} theme={theme} />
          ) : !ch.threadId ? (
            <StatusChip label="끊김" color={c.statusWarning} theme={theme} />
          ) : null}
          <View style={{ flex: 1 }} />
          <Pressable style={styles.button} onPress={() => void toTrash(ch)} accessibilityRole="button" accessibilityLabel="휴지통으로">
            <Text style={styles.buttonText}>🗑</Text>
          </Pressable>
        </Pressable>
        {isOpen ? (
          <View style={[styles.pane, { gap: 12 }]}>
            {ch.entries.map((e, k) => {
              if (e.type === "break") {
                return (
                  <Text key={`b${k}`} style={[styles.small, { color: c.statusWarning }]}>
                    {e.kind === "broken" ? "⚠️ 스레드 폐기됨" : "⏹ 새 대화로 전환"}
                    {e.time ? `  ·  ${e.time}` : ""}
                    {e.text ? `\n${e.text}` : ""}
                  </Text>
                );
              }
              return renderTurn(ch, e, k);
            })}
          </View>
        ) : null}
      </View>
    );
  }
}
