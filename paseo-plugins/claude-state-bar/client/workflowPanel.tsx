import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { agentActivity, type AgentRow, type WorkflowCard } from "../shared/activity";
import { fmtDur, fmtElapsed, fmtHM, fmtStamp, fmtTok, RUNNING_COLOR } from "./format";
import { panelStyles, type PanelStyles } from "./ui";
import { useFontScale } from "./fontScale";
import { useActivity } from "./useActivity";

// 확장 작업 현황의 워크플로우 탭(media/workflows.js)과 같은 규칙:
//   · 카드는 모두 접힌 채 시작 · 진행 중이거나 이 탭이 진행 중으로 본 카드는 위에, 나머지는 "끝난 워크플로우 N건" 접힌 묶음
//   · 상태는 에이전트로 정한다(하나라도 돌면 진행 · 하나라도 멈췄으면 중단 · 아니면 완료)
//   · 단계는 둘 이상 선언되고 에이전트 절반 이상이 단계에 들 때만 묶는다(단계 하나에 한 마리, 나머지 아홉이 흩어진 것보다 낫다)
//   · 에이전트는 여러 개 펼칠 수 있고, 펼치면 활동 줄(같은 종류 성공 줄 묶기) + 마지막에 보고
// 휴지통은 아직 없다(리규형님이 워크플로우 휴지통은 "사실 필요없다"고 해 존치를 검토하기로 한 상태).

type WfState = "running" | "stopped" | "done";

const KIND_LABEL: Record<string, string> = {
  command_execution: "명령",
  file_read: "읽기",
  file_change: "수정",
  code_search: "찾기",
  web_search: "웹",
  agent_message: "말",
  tool: "도구",
};
const GROUP_LABEL: Record<string, string> = { command_execution: "명령", file_read: "읽기", code_search: "찾기", web_search: "웹" };

type ActivityItem = { id: string; kind: string; label: string; body?: string; status: "running" | "done" | "failed" | "warn"; durationMs?: number };
type Activity = { items: ActivityItem[]; report?: string };

/** 에이전트가 하나도 없으면 막 띄운 것 — 그 대화가 열려 있으면 진행, 아니면 아무것도 시작되지 않는다(확장 stateOf) */
function stateOf(w: WorkflowCard): WfState {
  if (!w.agents.length) return w.sessionLive ? "running" : "stopped";
  if (w.agents.some((a) => a.status === "running")) return "running";
  if (w.agents.some((a) => a.status === "stopped")) return "stopped";
  return "done";
}

/** 돌고 있는 에이전트의 시계: 첫 기록부터 지금까지. 기록 사이 간격(명령 기다림·생각)에도 멈추지 않게 */
const runningMs = (started: number | undefined, span: number, now: number) => Math.max(span || 0, started ? now - started : 0);

/** "12만 토큰" — 확장 fmtTokTotal(한국어) */
const tokTotal = (n: number) => (n >= 10000 ? `${Math.round(n / 10000).toLocaleString()}만` : n.toLocaleString());

function groupRuns(list: ActivityItem[]) {
  const out: ({ one: ActivityItem } | { group: ActivityItem[]; kind: string })[] = [];
  let bucket: ActivityItem[] | null = null;
  let bucketKind = "";
  for (const it of list) {
    const can = !!GROUP_LABEL[it.kind] && it.status === "done";
    if (can && bucket && it.kind === bucketKind) bucket.push(it);
    else if (can) {
      bucket = [it];
      bucketKind = it.kind;
      out.push({ group: bucket, kind: it.kind });
    } else {
      bucket = null;
      bucketKind = "";
      out.push({ one: it });
    }
  }
  return out;
}

function ActivityRows({ act, styles, colors }: { act: Activity; styles: PanelStyles; colors: PanelColors }) {
  const [rowOpen, setRowOpen] = useState<Record<string, boolean>>({});
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const dot = (s: ActivityItem["status"]) => (s === "running" ? colors.accent : s === "failed" ? colors.danger : s === "warn" ? colors.warning : colors.success);
  const row = (it: ActivityItem) => {
    const hasFull = !!it.body && it.body !== it.label;
    const isOpen = !!rowOpen[it.id];
    const dur = fmtDur(it.durationMs);
    const line = (
      <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: dot(it.status) }} />
        <Text style={[styles.muted, { minWidth: 30 }]}>{KIND_LABEL[it.kind] ?? it.kind}</Text>
        <Text style={[styles.small, { flex: 1 }, it.status === "failed" ? { color: colors.danger } : {}]} numberOfLines={isOpen ? undefined : 2}>
          {/* 펼쳐서 아래에 전문이 나오면 잘린 이름표는 숨긴다 — Codex 카드와 같음(확장 hasfull[open] .lbl 숨김, 리규형님 10-09) */}
          {hasFull && isOpen ? "" : it.label}
          {dur ? <Text style={styles.muted}>{`  · ${dur}`}</Text> : null}
        </Text>
      </View>
    );
    return (
      <View key={it.id}>
        {/* 펼칠 본문이 없어도 누르면 잘린 줄이 전부 보인다 — Codex 카드와 같음(리규형님 10-06) */}
        <Pressable onPress={() => setRowOpen({ ...rowOpen, [it.id]: !isOpen })} accessibilityRole="button">
          {line}
        </Pressable>
        {hasFull && isOpen ? (
          <Text style={[styles.small, { marginLeft: 44, marginTop: 2, lineHeight: styles.fs(18) }]} selectable>
            {it.body}
          </Text>
        ) : null}
      </View>
    );
  };
  const reportOpen = !!rowOpen.__report;
  return (
    <View style={{ gap: 4 }}>
      {act.items.length ? null : <Text style={styles.muted}>아직 기록된 활동이 없습니다.</Text>}
      {groupRuns(act.items).map((n) => {
        if ("one" in n) return row(n.one);
        if (n.group.length === 1) return row(n.group[0]);
        const key = n.group[0].id;
        const open = !!groupOpen[key];
        return (
          <View key={`g${key}`} style={{ gap: 4 }}>
            <Pressable style={{ flexDirection: "row", gap: 6, alignItems: "center" }} onPress={() => setGroupOpen({ ...groupOpen, [key]: !open })} accessibilityRole="button">
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success }} />
              <Text style={[styles.muted, { minWidth: 30 }]}>{KIND_LABEL[n.kind]}</Text>
              <Text style={styles.small}>
                {GROUP_LABEL[n.kind]} {n.group.length}건
              </Text>
              <Text style={styles.muted}>{open ? "접기" : "펼치기"}</Text>
            </Pressable>
            {open ? <View style={{ gap: 4, paddingLeft: 14 }}>{n.group.map(row)}</View> : null}
          </View>
        );
      })}
      {/* 에이전트의 최종 보고(확장: Codex 패널의 결과 문서 자리 — 열 문서가 없어 그 자리에 그린다) */}
      {act.report ? (
        <Pressable onPress={() => setRowOpen({ ...rowOpen, __report: !reportOpen })} accessibilityRole="button">
          <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: colors.success }} />
            <Text style={[styles.muted, { minWidth: 30 }]}>보고</Text>
            <Text style={[styles.small, { flex: 1 }]} numberOfLines={reportOpen ? undefined : 2} selectable={reportOpen}>
              {reportOpen ? act.report : act.report.replace(/\s+/g, " ").trim()}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

type PanelColors = { accent: string; danger: string; warning: string; success: string; muted: string };

export function WorkflowsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const { directory, data, error, live } = useActivity(workspaceId, (d) => d.workflows.some((w) => stateOf(w) === "running"));
  // 사용자가 누른 카드만 펼친다(확장: 모두 접힌 채 시작 — 새 카드를 저절로 펼치면 목록이 밀린다)
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [doneOpen, setDoneOpen] = useState(false);
  const [foldedPhase, setFoldedPhase] = useState<Record<string, boolean>>({});
  const [openAgents, setOpenAgents] = useState<Record<string, boolean>>({});
  const [activities, setActivities] = useState<Record<string, Activity>>({});
  const watched = useRef(new Set<string>());
  const fetchActivity = useRpc(agentActivity);
  const [now, setNow] = useState(Date.now());
  const fontScale = useFontScale();
  const styles = useMemo(() => panelStyles(theme, layout.compact, fontScale), [theme, layout.compact, fontScale]);
  const c = theme.colors;
  const colors: PanelColors = { accent: RUNNING_COLOR, danger: c.statusDanger, warning: c.statusWarning, success: c.statusSuccess, muted: c.foregroundMuted };

  const loadActivity = (w: WorkflowCard, a: AgentRow) => {
    if (!directory) return;
    const key = `${w.key}|${a.id}`;
    void fetchActivity({ cwd: directory, sessionId: w.sessionId, wfId: w.wfId, agentId: a.id, status: a.status })
      .then((r) => setActivities((prev) => ({ ...prev, [key]: r })))
      .catch(() => setActivities((prev) => ({ ...prev, [key]: { items: [] } })));
  };

  // 펼친 에이전트가 돌고 있거나 방금 끝났으면(진행 → 완료·중단) 목록이 새로 올 때 활동도 다시 받는다.
  // 끝난 순간 한 번 더 받아야 마지막 줄·끊긴 호출 표시·보고가 들어온다(확장은 상태도 캐시 열쇠에 넣어 다시 읽는다)
  const seenStatus = useRef(new Map<string, AgentRow["status"]>());
  useEffect(() => {
    if (!data) return;
    for (const w of data.workflows)
      for (const a of w.agents) {
        const key = `${w.key}|${a.id}`;
        const before = seenStatus.current.get(key);
        seenStatus.current.set(key, a.status);
        if (openAgents[key] && (a.status === "running" || (before !== undefined && before !== a.status))) loadActivity(w, a);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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

  const stateColor = (s: WfState) => (s === "done" ? c.statusSuccess : s === "stopped" ? c.statusWarning : RUNNING_COLOR);

  const agentRow = (w: WorkflowCard, a: AgentRow, label: string, title: string) => {
    const key = `${w.key}|${a.id}`;
    const isOpen = !!openAgents[key];
    const running = a.status === "running";
    const dur = fmtDur(running ? runningMs(a.startedAt, a.durationMs, now) : a.durationMs);
    const act = activities[key];
    return (
      <View key={a.id} style={{ gap: 3 }}>
        <Pressable
          onPress={() => {
            setOpenAgents({ ...openAgents, [key]: !isOpen });
            if (!isOpen) loadActivity(w, a);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${title} 활동 보기`}
        >
          <View style={[styles.head, { flexWrap: "nowrap" }]}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: running ? RUNNING_COLOR : a.status === "stopped" ? c.statusWarning : c.statusSuccess }} />
            <Text style={[styles.small, { fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
              {label}
            </Text>
            {a.status === "stopped" ? <Text style={[styles.muted, { color: c.statusWarning }]}>중단됨</Text> : null}
            <View style={{ flex: 1 }} />
            {a.model ? <Text style={styles.muted}>{a.model}</Text> : null}
            {a.tokens ? <Text style={styles.muted}>{fmtTok(a.tokens)}</Text> : null}
            {dur ? <Text style={styles.muted}>{running ? `경과 ${dur}` : dur}</Text> : null}
            <Text style={styles.muted}>{isOpen ? "접기" : "펼치기"}</Text>
          </View>
          {/* 요약은 160자에서 잘린 한 줄 — 펼치면 숨기고 아래 활동·보고 전문만 보인다(확장 details.agent[open] .agent-sub 숨김과 같음, 리규형님 10-09) */}
          {a.summary && !isOpen ? (
            <Text style={[styles.muted, { marginLeft: 14 }]} numberOfLines={2}>
              {a.summary}
            </Text>
          ) : null}
        </Pressable>
        {isOpen ? (
          <View style={[styles.pane, { marginLeft: 14 }]}>{act ? <ActivityRows act={act} styles={styles} colors={colors} /> : <Text style={styles.muted}>불러오는 중…</Text>}</View>
        ) : null}
      </View>
    );
  };

  const renderCard = (w: WorkflowCard) => {
    const st = stateOf(w);
    const doneN = w.agents.filter((a) => a.status === "done").length;
    const stopN = w.agents.filter((a) => a.status === "stopped").length;
    const badge = st === "running" ? `${doneN}/${w.agents.length} 진행 중` : st === "stopped" ? `${doneN} 완료 · ${stopN} 중단` : `${doneN}/${w.agents.length} 완료`;
    const finished = st !== "running";
    const doneAt = finished ? w.endedAt : undefined;
    const clock = w.startedAt ? `🕘 ${fmtStamp(w.startedAt)} · ${doneAt ? "소요" : "경과"} ${fmtElapsed((doneAt ?? now) - w.startedAt)}` : "";
    const isOpen = !!open[w.key];
    // 이름이 같은 에이전트(역할 이름이 잘려 같아진 것)는 순번을 붙인다
    const counts = new Map<string, number>();
    for (const a of w.agents) if (a.name.trim()) counts.set(a.name.trim(), (counts.get(a.name.trim()) ?? 0) + 1);
    const labelOf = (a: AgentRow, i: number) => {
      const nm = a.name.trim();
      return nm ? ((counts.get(nm) ?? 0) > 1 ? `${nm} (${i + 1})` : nm) : `에이전트 ${i + 1}`;
    };
    const indexed = w.agents.map((a, i) => ({ a, i }));
    const placed = w.agents.filter((a) => a.phase).length;
    const useGroups = w.phases.length >= 2 && w.agents.length > 0 && placed * 2 >= w.agents.length;
    const tokens = w.agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    // 확장 wf.session / wf.sessionLive: 열려 있음 = 확장 상태바에 보일 대화(데몬이 같은 규칙으로 고른다)
    const meta = [
      w.kind === "workflow" ? w.wfId : "",
      `세션 ${w.sessionId.slice(0, 8)}${w.sessionLive ? " (열려 있음)" : ""}`,
      w.agents.length ? `에이전트 ${w.agents.length}개` : "",
      tokens ? `${tokTotal(tokens)} 토큰` : "",
    ].filter(Boolean);
    // 서브에이전트 묶음 이름은 이 기기 시간대로 만든다(확장 wf.taskBundle)
    const title = w.kind === "tasks" && w.startedAt ? `서브에이전트 ${fmtHM(w.startedAt)} (${w.agents.length}마리)` : w.name;

    let agents: ReactNode;
    if (!w.agents.length) agents = <Text style={styles.muted}>아직 시작된 에이전트가 없습니다.</Text>;
    else if (!useGroups) agents = <View style={{ gap: 8 }}>{indexed.map(({ a, i }) => agentRow(w, a, labelOf(a, i), a.fullName || labelOf(a, i)))}</View>;
    else {
      const groups: { title: string; items: typeof indexed }[] = [];
      for (const p of w.phases) {
        const mem = indexed.filter((x) => x.a.phase === p);
        if (mem.length) groups.push({ title: p, items: mem });
      }
      const rest = indexed.filter((x) => !x.a.phase || !w.phases.includes(x.a.phase));
      if (rest.length) groups.push({ title: "기타", items: rest });
      agents = (
        <View style={{ gap: 8 }}>
          {groups.map((g) => {
            const fkey = `${w.key} ${g.title}`;
            const folded = !!foldedPhase[fkey];
            const gDone = g.items.filter((x) => x.a.status === "done").length;
            return (
              <View key={fkey} style={{ gap: 6 }}>
                <Pressable
                  style={[styles.head, { borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 3 }]}
                  onPress={() => setFoldedPhase({ ...foldedPhase, [fkey]: !folded })}
                  accessibilityRole="button"
                >
                  <Text style={styles.muted}>{folded ? "▸" : "▾"}</Text>
                  <Text style={[styles.small, { fontWeight: "600" }]}>{g.title}</Text>
                  <Text style={styles.muted}>
                    {gDone}/{g.items.length}
                  </Text>
                </Pressable>
                {folded ? null : <View style={{ gap: 8 }}>{g.items.map(({ a, i }) => agentRow(w, a, labelOf(a, i), a.fullName || labelOf(a, i)))}</View>}
              </View>
            );
          })}
        </View>
      );
    }

    return (
      <View key={w.key} style={styles.card}>
        <Pressable style={styles.head} onPress={() => setOpen({ ...open, [w.key]: !isOpen })} accessibilityRole="button">
          <Text style={styles.muted}>{isOpen ? "▾" : "▸"}</Text>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {w.kind === "tasks" ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>에이전트 묶음</Text>
            </View>
          ) : null}
          {clock ? <Text style={styles.muted}>{clock}</Text> : null}
          <View style={{ flex: 1 }} />
          <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: stateColor(st) }}>
            <Text style={{ color: c.accentForeground, fontSize: styles.fs(11) }}>{badge}</Text>
          </View>
        </Pressable>
        {isOpen ? (
          <View style={{ gap: 8 }}>
            {meta.length ? <Text style={styles.muted}>{meta.join(" · ")}</Text> : null}
            {w.description ? <Text style={styles.small}>{w.description}</Text> : null}
            {agents}
          </View>
        ) : null}
      </View>
    );
  };

  const cards = data?.workflows ?? [];
  let nLive = 0;
  let nDone = 0;
  let nStop = 0;
  let gStop = 0;
  const liveCards: WorkflowCard[] = [];
  const overCards: WorkflowCard[] = [];
  for (const w of cards) {
    const st = stateOf(w);
    if (st === "running") nLive++;
    else if (st === "stopped") nStop++;
    else nDone++;
    if (st === "running") watched.current.add(w.key);
    if (st === "running" || watched.current.has(w.key)) liveCards.push(w);
    else {
      overCards.push(w);
      if (st === "stopped") gStop++;
    }
  }
  const summary = [nDone ? `완료 ${nDone}건` : "", nStop ? `중단 ${nStop}건` : "", `진행 중 ${nLive}건`, "자동 갱신"].filter(Boolean).join(" · ");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {error ? <Text style={styles.error}>목록을 읽지 못했습니다: {error}</Text> : null}
      {!data ? <Text style={styles.muted}>불러오는 중…</Text> : null}
      {data && !cards.length ? <Text style={styles.muted}>이 프로젝트에 아직 워크플로우가 없습니다.</Text> : null}
      {cards.length ? <Text style={styles.muted}>{summary}</Text> : null}
      {liveCards.map(renderCard)}
      {overCards.length ? (
        <View style={{ gap: 8 }}>
          <Pressable style={styles.button} onPress={() => setDoneOpen(!doneOpen)} accessibilityRole="button">
            <Text style={styles.buttonText}>
              {doneOpen ? "▾" : "▸"} 끝난 워크플로우 {overCards.length}건{gStop ? ` · 중단 ${gStop}건` : ""}
            </Text>
          </Pressable>
          {doneOpen ? overCards.map(renderCard) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}
