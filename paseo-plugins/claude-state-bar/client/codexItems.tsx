import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { RunCard, RunItem, TurnDoc } from "../shared/codex";
import { fmtDur, fmtElapsed, fmtHM, RUNNING_COLOR } from "./format";
import type { PanelStyles } from "./ui";

// Codex 진행 카드를 펼쳤을 때의 활동 목록. 확장 media/codexruns.js 의 규칙을 옮겼다:
//   · 같은 종류의 성공한 명령·검색이 이어지면 "명령 N건" 한 줄로 묶는다. 실패는 묶지 않고, 턴 경계를 넘지 않는다
//   · 두 턴 이상이면 턴마다 머리표(접기 · 그 턴 시각 · 그 턴 결과·요청서)를 단다. 한 턴 실행은 머리표 없이 예전 모양
//   · 줄을 누르면 전문(말·생각의 본문, 명령은 래퍼까지 붙은 실제 명령)

const KIND_LABEL: Record<string, string> = {
  agent_message: "말",
  reasoning: "생각",
  command_execution: "명령",
  file_change: "파일",
  web_search: "검색",
  mcp_tool_call: "MCP",
  collab_tool_call: "협업",
  todo_list: "계획",
  error: "알림",
  // '알림'(Codex CLI 안내)과 반드시 달라야 한다 — 확장에서 실제로 헷갈렸다
  claude_steer: "클로드",
};

const GROUP_LABEL: Record<string, string> = { command_execution: "명령", web_search: "검색" };

// 클로드가 끼어든 줄의 표시색(확장 .steer 와 같은 주황)
const STEER_COLOR = "#d98b45";

type Node = { one: RunItem; turn: number } | { group: RunItem[]; kind: string; turn: number };

function groupRuns(list: RunItem[]): Node[] {
  const out: Node[] = [];
  let bucket: RunItem[] | null = null;
  let bucketKind = "";
  let bucketTurn = 0;
  for (const it of list) {
    const turn = it.turn || 1;
    const can = !!GROUP_LABEL[it.kind] && it.status === "done";
    if (can && bucket && it.kind === bucketKind && turn === bucketTurn) {
      bucket.push(it);
    } else if (can) {
      bucket = [it];
      bucketKind = it.kind;
      bucketTurn = turn;
      out.push({ group: bucket, kind: it.kind, turn });
    } else {
      bucket = null;
      bucketKind = "";
      bucketTurn = 0;
      out.push({ one: it, turn });
    }
  }
  return out;
}

/** 결과 문서에서 그 턴 부분만. 1턴은 처음부터 2턴 표식 전까지. 표식을 못 찾으면 null */
function sliceTurn(text: string, turnDocs: TurnDoc[], turn: number): string | null {
  const own = turnDocs.find((d) => d.turn === turn);
  const next = turnDocs.find((d) => d.turn === turn + 1);
  const at = turn === 1 ? 0 : own?.resultAnchor ? text.indexOf(own.resultAnchor) : -1;
  if (at < 0) return null;
  // 표식 줄 자체(HTML 주석)는 읽을 거리가 아니라 빼고 보여 준다
  const start = turn === 1 ? 0 : at + own!.resultAnchor!.length;
  const end = next?.resultAnchor ? text.indexOf(next.resultAnchor, start) : -1;
  return text.slice(start, end < 0 ? undefined : end).trim();
}

type TurnOpen = { kind: "result" | "request"; path: string };

export function RunItemsView({
  run,
  items,
  now,
  styles,
  theme,
  loadDoc,
}: {
  run: RunCard;
  items: RunItem[] | undefined;
  now: number;
  styles: PanelStyles;
  theme: PluginTheme;
  loadDoc: (path: string) => Promise<string>;
}) {
  const c = theme.colors;
  const [rowOpen, setRowOpen] = useState<Record<string, boolean>>({});
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [folded, setFolded] = useState<Record<number, boolean>>({});
  const [turnOpen, setTurnOpen] = useState<Record<number, TurnOpen | undefined>>({});
  const [docText, setDocText] = useState<Record<string, string>>({});

  if (!items) return <Text style={styles.muted}>읽는 중입니다</Text>;
  if (!items.length) return <Text style={styles.muted}>아직 기록된 활동이 없습니다</Text>;

  const runOver = run.phase === "done" || run.phase === "failed" || run.phase === "stopped";
  const maxTurn = items.reduce((n, i) => Math.max(n, i.turn || 1), 1);
  const turnDocs = run.turnDocs ?? [];
  const turnFinished = (turn: number) => turn < maxTurn || runOver;

  const dotColor = (s: RunItem["status"]) =>
    s === "running" ? RUNNING_COLOR : s === "failed" ? c.statusDanger : s === "warn" ? c.statusWarning : c.statusSuccess;

  // 문서는 열 때마다 새로 받는다(진행 중인 실행은 결과 문서에 턴이 덧붙는다)
  const openTurnDoc = (turn: number, next: TurnOpen) => {
    const cur = turnOpen[turn];
    if (cur && cur.kind === next.kind) {
      setTurnOpen({ ...turnOpen, [turn]: undefined });
      return;
    }
    setTurnOpen({ ...turnOpen, [turn]: next });
    void loadDoc(next.path)
      .then((t) => setDocText((p) => ({ ...p, [next.path]: t })))
      .catch((e) => setDocText((p) => ({ ...p, [next.path]: `읽지 못했습니다: ${String(e)}` })));
  };

  const renderItem = (it: RunItem) => {
    const full = it.body || it.raw || "";
    const hasFull = !!full && full !== it.label;
    const isOpen = !!rowOpen[it.id];
    const steer = it.kind === "claude_steer";
    const dur = fmtDur(it.durationMs);
    const row = (
      <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: dotColor(it.status) }} />
        <Text style={[styles.muted, { minWidth: 30, color: steer ? STEER_COLOR : c.foregroundMuted }]}>{KIND_LABEL[it.kind] ?? it.kind}</Text>
        <Text style={[styles.small, { flex: 1 }, it.status === "failed" ? { color: c.statusDanger } : {}]} numberOfLines={isOpen ? undefined : 2}>
          {/* 펼쳐서 아래에 전문이 나오면 잘린 이름표는 숨긴다 — 같은 말이 두 번 나왔다(확장 details.row.hasfull[open] .lbl 숨김과 같음, 리규형님 10-09) */}
          {hasFull && isOpen ? "" : it.label}
          {dur ? <Text style={styles.muted}>{`  · ${dur}`}</Text> : null}
        </Text>
      </View>
    );
    return (
      <View key={it.id} style={steer ? { borderLeftWidth: 2, borderLeftColor: STEER_COLOR, paddingLeft: 6 } : undefined}>
        {/* 펼칠 본문이 없어도(파일 경로 등) 누르면 잘린 줄이 전부 보인다 — 확장 details.row 와 같음(리규형님 10-06 "펼쳐도 쩜쩜쩜") */}
        <Pressable onPress={() => setRowOpen({ ...rowOpen, [it.id]: !isOpen })} accessibilityRole="button">
          {row}
        </Pressable>
        {hasFull && isOpen ? (
          <Text style={[it.kind === "command_execution" ? styles.mono : styles.small, { marginLeft: 44, marginTop: 2, lineHeight: styles.fs(18) }]} selectable>
            {full}
          </Text>
        ) : null}
      </View>
    );
  };

  const renderNode = (node: Node) => {
    if ("one" in node) return renderItem(node.one);
    if (node.group.length === 1) return renderItem(node.group[0]);
    const key = node.group[0].id;
    const isOpen = !!groupOpen[key];
    return (
      <View key={`g${key}`} style={{ gap: 4 }}>
        <Pressable style={{ flexDirection: "row", gap: 6, alignItems: "center" }} onPress={() => setGroupOpen({ ...groupOpen, [key]: !isOpen })} accessibilityRole="button">
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.statusSuccess }} />
          <Text style={[styles.muted, { minWidth: 30 }]}>{KIND_LABEL[node.kind]}</Text>
          <Text style={styles.small}>
            {GROUP_LABEL[node.kind]} {node.group.length}건
          </Text>
          <Text style={styles.muted}>{isOpen ? "접기" : "펼치기"}</Text>
        </Pressable>
        {isOpen ? <View style={{ gap: 4, paddingLeft: 14 }}>{node.group.map(renderItem)}</View> : null}
      </View>
    );
  };

  const nodes = groupRuns(items);
  if (maxTurn < 2) return <View style={{ gap: 4 }}>{nodes.map(renderNode)}</View>;

  // 턴마다 묶어 그린다
  const byTurn = new Map<number, Node[]>();
  for (const n of nodes) {
    const list = byTurn.get(n.turn) ?? [];
    list.push(n);
    byTurn.set(n.turn, list);
  }

  const turnTime = (turn: number) => {
    const d = turnDocs.find((x) => x.turn === turn);
    if (!d?.startedAt) return "";
    // 끝난 턴인데 끝 시각이 없으면 아무것도 안 쓴다(시작만 있으면 아직 도는 턴처럼 읽힌다)
    if (!d.endedAt && turnFinished(turn)) return "";
    return `${fmtHM(d.startedAt)} · ${d.endedAt ? "소요" : "경과"} ${fmtElapsed((d.endedAt ?? now) - d.startedAt)}`;
  };

  return (
    <View style={{ gap: 4 }}>
      {[...byTurn.keys()]
        .sort((a, b) => a - b)
        .map((turn) => {
          const isFolded = !!folded[turn];
          const d = turnDocs.find((x) => x.turn === turn);
          const to = turnOpen[turn];
          const time = turnTime(turn);
          let shown: string | undefined;
          let note = "";
          if (to) {
            const raw = docText[to.path];
            if (raw !== undefined && to.kind === "result" && !raw.startsWith("읽지 못했습니다")) {
              const part = sliceTurn(raw, turnDocs, turn);
              shown = part ?? raw;
              if (part === null) note = "이 턴 표식을 문서에서 못 찾아 문서 전체를 보여 드립니다";
            } else {
              shown = raw;
            }
          }
          return (
            <View key={`t${turn}`} style={{ gap: 4, marginTop: turn === 1 ? 0 : 8 }}>
              <View style={[styles.head, { borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 3 }]}>
                <Pressable style={styles.head} onPress={() => setFolded({ ...folded, [turn]: !isFolded })} accessibilityRole="button">
                  <Text style={styles.muted}>{isFolded ? "▸" : "▾"}</Text>
                  <Text style={[styles.small, { fontWeight: "600" }]}>{turn}턴</Text>
                  {time ? <Text style={styles.muted}>{time}</Text> : null}
                </Pressable>
                {run.resultPath ? (
                  <Pressable style={styles.button} onPress={() => openTurnDoc(turn, { kind: "result", path: run.resultPath! })} accessibilityRole="button">
                    <Text style={styles.buttonText}>결과</Text>
                  </Pressable>
                ) : null}
                {d?.requestPath ? (
                  <Pressable style={styles.button} onPress={() => openTurnDoc(turn, { kind: "request", path: d.requestPath! })} accessibilityRole="button">
                    <Text style={styles.buttonText}>요청서</Text>
                  </Pressable>
                ) : null}
              </View>
              {to ? (
                <View style={[styles.pane, { backgroundColor: c.surface1 }]}>
                  <Text style={styles.muted}>
                    {to.kind === "result" ? `결과 — ${turn}턴 부분` : `${turn}턴 요청서`}
                  </Text>
                  {note ? <Text style={[styles.muted, { color: c.statusWarning }]}>{note}</Text> : null}
                  <Text style={[styles.small, { fontSize: styles.fs(13), lineHeight: styles.fs(19) }]} selectable>
                    {shown ?? "읽는 중입니다"}
                  </Text>
                </View>
              ) : null}
              {isFolded ? null : <View style={{ gap: 4 }}>{(byTurn.get(turn) ?? []).map(renderNode)}</View>}
            </View>
          );
        })}
    </View>
  );
}
