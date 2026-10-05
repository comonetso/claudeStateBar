import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { bgClear, bgOutput, type BgCard } from "../shared/activity";
import { fmtElapsed, fmtStamp } from "./format";
import { NoticeLine, panelStyles, useNotice, type PanelStyles } from "./ui";
import { useFontScale } from "./fontScale";
import { useActivity } from "./useActivity";

// 확장 작업 현황의 백그라운드 탭(media/bgtasks.js)과 같은 규칙(리규형님 09-22 결정):
//   · 두 묶음 — Claude 가 백그라운드로 돌린 것(명령·모니터) · 오래 걸린 일반 명령. 묶음 머리는 접힌다
//   · 실행 중인 카드(이 탭이 실행 중으로 본 것 포함)는 위에 펼친 채 출력을 바로 보여 주고,
//     끝난 것은 "끝난 작업 N건" 한 줄에 접어 둔다(묶음별 최근 10건)
//   · 출력 상자는 바닥을 보고 있으면 새 줄을 따라가고, 올려 보고 있으면 그 자리에 둔다
//   · 끝난 줄 옆 🗑 은 그 묶음의 끝난 작업을 목록에서만 치운다(파일은 그대로, 묻지 않음 — 데몬이 기억, 10-05 결정)

// 확장 결정(09-22): 끝난 것은 묶음별 10개
const FINISHED_PER_GROUP = 10;
// 확장과 같다: 실행 중인 카드의 출력은 2초마다
const OUTPUT_POLL_MS = 2000;
// 일반 명령 묶음의 기준(데몬 LONG_COMMAND_MS 와 같은 2분)
const LONG_MINUTES = 2;

const STATUS_BADGE = (b: BgCard) =>
  b.status === "running" ? "실행 중" : b.status === "completed" ? "완료" : b.status === "failed" ? (b.exitCode !== undefined ? `실패 · 종료 코드 ${b.exitCode}` : "실패") : "중지됨";

function OutputBox({ cwd, card, styles }: { cwd: string; card: BgCard; styles: PanelStyles }) {
  const fetchOutput = useRpc(bgOutput);
  const [text, setText] = useState<string | undefined>(undefined);
  const [gone, setGone] = useState(false);
  const box = useRef<ScrollView>(null);
  const stick = useRef(true);

  useEffect(() => {
    // 일반 명령은 끝나야 출력이 기록된다
    if (card.kind === "foreground" && card.status === "running") return;
    let alive = true;
    const read = () =>
      void fetchOutput({ cwd, sessionId: card.sessionId, taskId: card.taskId })
        .then((r) => {
          if (!alive) return;
          setGone(r.gone);
          setText(r.text);
        })
        .catch((e) => alive && setText(`읽지 못했습니다: ${String(e)}`));
    read();
    if (card.status !== "running") return () => void (alive = false);
    const timer = setInterval(read, OUTPUT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cwd, card.sessionId, card.taskId, card.kind, card.status, fetchOutput]);

  if (card.kind === "foreground" && card.status === "running") return <Text style={styles.muted}>Claude 가 이 명령이 끝나길 기다리고 있습니다. 출력은 끝나면 기록됩니다.</Text>;
  if (text === undefined) return <Text style={styles.muted}>불러오는 중…</Text>;
  if (gone) return <Text style={styles.muted}>출력 파일이 지워졌습니다 — Claude Code 가 임시 폴더에 두는 파일입니다.</Text>;
  if (!text.trim()) return <Text style={styles.muted}>아직 출력이 없습니다.</Text>;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    stick.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 4;
  };
  return (
    <ScrollView
      ref={box}
      style={[styles.pane, { maxHeight: 320 }]}
      nestedScrollEnabled
      onScroll={onScroll}
      scrollEventThrottle={100}
      onContentSizeChange={() => {
        if (stick.current) box.current?.scrollToEnd({ animated: false });
      }}
    >
      <Text style={styles.mono} selectable>
        {text}
      </Text>
    </ScrollView>
  );
}

export function BackgroundPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const { directory, data, error, live, reload } = useActivity(workspaceId, (d) => d.background.some((b) => b.status === "running"));
  const clearRpc = useRpc(bgClear);
  const { notice, notify } = useNotice();
  // 확장 onClearFinished: 묻지 않는다 — 지우는 것이 없고 목록에서만 빠진다
  const clearGroup = async (group: "background" | "long") => {
    if (!directory) return;
    try {
      const { count } = await clearRpc({ cwd: directory, group });
      notify(`끝난 작업 ${count}건을 목록에서 치웠습니다`);
    } catch (e) {
      notify(`치우지 못했습니다: ${String(e)}`, "warn");
    }
    void reload();
  };
  // 펼침은 패널이 열려 있는 동안만 기억한다: 위 목록은 펼친 채 시작(닫은 것만 기억), 끝난 줄 안은 접힌 채 시작(연 것만 기억)
  const [closedUpper, setClosedUpper] = useState<Record<string, boolean>>({});
  const [openLower, setOpenLower] = useState<Record<string, boolean>>({});
  const [doneOpen, setDoneOpen] = useState<Record<string, boolean>>({});
  const [foldedGroup, setFoldedGroup] = useState<Record<string, boolean>>({});
  // 실행 중으로 본 카드는 끝나도 위에 남긴다(보는 앞에서 접혀 사라지지 않게)
  const watched = useRef(new Set<string>());
  const [now, setNow] = useState(Date.now());
  const fontScale = useFontScale();
  const styles = useMemo(() => panelStyles(theme, layout.compact, fontScale), [theme, layout.compact, fontScale]);
  const c = theme.colors;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!directory) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.muted}>작업 공간 폴더를 읽는 중입니다</Text>
        </View>
      </View>
    );
  }

  const dotColor = (s: BgCard["status"]) => (s === "completed" ? c.statusSuccess : s === "failed" ? c.statusDanger : s === "stopped" ? c.statusWarning : c.accent);

  const renderCard = (b: BgCard, upper: boolean) => {
    const open = upper ? !closedUpper[b.key] : !!openLower[b.key];
    const finished = b.status !== "running";
    const doneAt = finished ? b.endedAt : undefined;
    const name = b.description || b.command;
    const meta = [
      b.kind !== "foreground" ? `작업 ${b.taskId}` : "",
      `세션 ${b.sessionId.slice(0, 8)}`,
      b.kind === "monitor" && b.eventCount ? `이벤트 ${b.eventCount}건` : "",
    ].filter(Boolean);
    return (
      <View key={b.key} style={styles.card}>
        <Pressable
          style={styles.head}
          onPress={() => (upper ? setClosedUpper({ ...closedUpper, [b.key]: open }) : setOpenLower({ ...openLower, [b.key]: !open }))}
          accessibilityRole="button"
        >
          <Text style={styles.muted}>{open ? "▾" : "▸"}</Text>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor(b.status) }} />
          <Text style={styles.title} numberOfLines={2}>
            {name}
          </Text>
          {b.kind !== "foreground" ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{b.kind === "monitor" ? "모니터" : "명령"}</Text>
            </View>
          ) : null}
          <Text style={styles.muted}>{`🕘 ${fmtStamp(b.startedAt)} · ${doneAt ? "소요" : "경과"} ${fmtElapsed((doneAt ?? now) - b.startedAt)}`}</Text>
          <View style={{ flex: 1 }} />
          <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: dotColor(b.status) }}>
            <Text style={{ color: c.accentForeground, fontSize: styles.fs(11) }}>{STATUS_BADGE(b)}</Text>
          </View>
        </Pressable>
        {open ? (
          <View style={{ gap: 6 }}>
            {meta.length ? <Text style={styles.muted}>{meta.join(" · ")}</Text> : null}
            {finished && b.summary ? <Text style={styles.small}>{b.summary}</Text> : null}
            {b.command ? (
              <Text style={[styles.mono, { color: c.foregroundMuted }]} selectable>
                {`$ ${b.command}`}
              </Text>
            ) : null}
            <OutputBox cwd={directory} card={b} styles={styles} />
          </View>
        ) : null}
      </View>
    );
  };

  const renderGroup = (id: string, title: string, list: BgCard[], doneLabel: string) => {
    const running = list.filter((b) => b.status === "running");
    const finishedAll = list.filter((b) => b.status !== "running");
    const finished = finishedAll.slice(0, FINISHED_PER_GROUP);
    for (const b of running) watched.current.add(b.key);
    const upper = [...running, ...finished.filter((b) => watched.current.has(b.key))];
    const lower = finished.filter((b) => !watched.current.has(b.key));
    const folded = !!foldedGroup[id];
    return (
      <View key={id} style={{ gap: 8 }}>
        <Pressable
          style={[styles.head, { borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 3 }]}
          onPress={() => setFoldedGroup({ ...foldedGroup, [id]: !folded })}
          accessibilityRole="button"
        >
          <Text style={styles.muted}>{folded ? "▸" : "▾"}</Text>
          <Text style={[styles.small, { fontWeight: "600" }]}>{title}</Text>
          <Text style={styles.muted}>
            실행 중 {running.length} · 끝난 {finishedAll.length}
          </Text>
        </Pressable>
        {folded ? null : !upper.length && !lower.length ? (
          <Text style={styles.muted}>없음</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {upper.map((b) => renderCard(b, true))}
            {lower.length ? (
              <View style={{ gap: 8 }}>
                <View style={styles.actions}>
                  <Pressable style={[styles.button, { flex: 1 }]} onPress={() => setDoneOpen({ ...doneOpen, [id]: !doneOpen[id] })} accessibilityRole="button">
                    <Text style={styles.buttonText}>
                      {doneOpen[id] ? "▾" : "▸"} {doneLabel} {lower.length}건
                      {finishedAll.length > finished.length ? ` · 전체 ${finishedAll.length}건 중 최근 ${finished.length}건` : ""}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.button}
                    onPress={() => void clearGroup(id as "background" | "long")}
                    accessibilityRole="button"
                    accessibilityLabel="끝난 작업을 목록에서 치웁니다 (파일은 건드리지 않음)"
                  >
                    <Text style={styles.buttonText}>🗑</Text>
                  </Pressable>
                </View>
                {doneOpen[id] ? lower.map((b) => renderCard(b, false)) : null}
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  const all = data?.background ?? [];
  const bg = all.filter((b) => b.kind !== "foreground");
  const lg = all.filter((b) => b.kind === "foreground");
  const nRun = all.filter((b) => b.status === "running").length;
  const nDone = all.length - nRun;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <NoticeLine notice={notice} theme={theme} />
      {error ? <Text style={styles.error}>목록을 읽지 못했습니다: {error}</Text> : null}
      {!data ? <Text style={styles.muted}>불러오는 중…</Text> : null}
      {/* 열린 대화 = VS Code 확장 상태바에 보일 대화(데몬이 같은 규칙으로 고른다, 10-05 결정) */}
      {data ? <Text style={styles.muted}>열려 있는 대화(VS Code 상태바와 같은 기준)에서 Claude 가 백그라운드로 돌린 것과, {LONG_MINUTES}분 넘게 걸린 일반 명령입니다.</Text> : null}
      {data && !all.length ? <Text style={styles.muted}>열려 있는 대화에 백그라운드 작업이 없습니다.</Text> : null}
      {all.length ? <Text style={styles.muted}>{[nDone ? `끝난 작업 ${nDone}건` : "", `실행 중 ${nRun}건`, "자동 갱신"].filter(Boolean).join(" · ")}</Text> : null}
      {all.length ? renderGroup("background", "백그라운드", bg, "끝난 작업") : null}
      {all.length ? renderGroup("long", `오래 걸린 명령 · ${LONG_MINUTES}분 넘게`, lg, "끝난 명령") : null}
    </ScrollView>
  );
}
