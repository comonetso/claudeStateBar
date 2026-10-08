import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { codexDoc, codexRunItems, codexRuns, codexTrashRun, codexUsage, type RunCard, type RunItem, type RunPhase } from "../shared/codex";
import { CleanDrawer } from "./codexClean";
import { RunItemsView } from "./codexItems";
import { TrashDrawer } from "./codexTrash";
import { fmtBytes, fmtClock, fmtDur, fmtElapsed, fmtStamp, fmtTok, RUNNING_COLOR } from "./format";
import { NoticeLine, panelStyles, useNotice } from "./ui";
import { useFontScale } from "./fontScale";

// 확장 Codex 진행 패널: 실행 카드 목록 · 묶음 카드 · 끝난 실행 접기 · 활동(턴 머리표·명령 묶기) · 요청서·결과 문서.
// 휴지통: 끝난 카드의 🗑 은 묻지 않고 통째로 옮기고, 묻는 것은 서랍의 완전 삭제·비우기뿐(codexTrash.tsx).
// 용량 줄 옆 [정리]: 항목 고르기 → 미리보기 → [지우기] 한 번 더(codexClean.tsx, 리규형님 10-08 "확장과 같게"). 끼어들기는 아직 없다.

// 클로드가 끼어든 말의 표시색(확장 .now.steer 와 같은 주황)
const STEER_COLOR = "#d98b45";

/** 여러 턴 실행에서 Codex 가 실제로 일한 시간 합계(턴 사이 Claude 가 읽고 되묻던 시간을 뺀다). 확장 workClock 과 같다:
 *  턴 시각이 하나라도 비면 합계를 안 낸다(빠진 합계를 사실처럼 보이지 않게). 진행 중인 마지막 턴은 시작을 넘겨 시계가 돈다. */
function workClock(run: RunCard, over: boolean): { sum: number; live: number } | null {
  const docs = run.turnDocs;
  if (!docs || docs.length < 2) return null;
  let sum = 0;
  let live = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d.startedAt) return null;
    if (d.endedAt) sum += d.endedAt - d.startedAt;
    else if (i === docs.length - 1 && !over) live = d.startedAt;
    else return null;
  }
  return { sum, live };
}

const PHASE_LABEL: Record<RunPhase, string> = {
  starting: "시작 중",
  running: "진행 중",
  finalizing: "마무리 중",
  done: "완료",
  failed: "실패",
  stopped: "중단됨",
  stale: "응답 없음",
};

const USAGE_LABEL = { scratch: "작업폴더", log: "실행 기록", trash: "휴지통", codex: "Codex 대화 기록" } as const;

const isOver = (p: RunPhase) => p === "done" || p === "failed" || p === "stopped";

// 확장과 같은 간격: 실행 중이면 2초, 아니면 상태바 기본 새로 고침 30초
const LIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 30000;
const PAGE = 20;

type Open = { kind: "items" } | { kind: "doc"; path: string };

export function CodexRunsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const fetchRuns = useRpc(codexRuns);
  const fetchItems = useRpc(codexRunItems);
  const fetchDoc = useRpc(codexDoc);
  const [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState<{ logDir: string | null; runs: RunCard[]; older: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, Open | undefined>>({});
  const [items, setItems] = useState<Record<string, RunItem[]>>({});
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  // 끝난 실행 묶음은 패널을 열 때마다 닫힌 채로(확장 09-19 결정) · 묶음 카드는 누른 상태를 기억
  const [doneOpen, setDoneOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  // 이 패널이 진행 중으로 본 실행은 끝나도 위에 남긴다
  const watched = useRef(new Set<string>());
  const trashRun = useRpc(codexTrashRun);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashKey, setTrashKey] = useState(0);
  const { notice, notify } = useNotice();
  const fetchUsage = useRpc(codexUsage);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof fetchUsage>> | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);

  const live = !!data?.runs.some((r) => !isOver(r.phase));

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
      const next = await fetchRuns({ cwd: directory, limit });
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
      // 용량 줄은 실패해도 목록을 막지 않는다
      fetchUsage({ cwd: directory }).then(setUsage, () => setUsage({ ok: false }));
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    }
  }, [directory, limit, fetchRuns, fetchUsage]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [load, live]);

  // 실행 중인 카드의 시계는 1초마다
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // 펼친 활동 목록은 실행 중이면 같이 새로 받는다
  useEffect(() => {
    if (!directory || !data) return;
    for (const run of data.runs) {
      const o = open[run.stamp];
      if (o?.kind !== "items") continue;
      if (items[run.stamp] && isOver(run.phase)) continue;
      void fetchItems({ cwd: directory, stamp: run.stamp })
        .then((r) => setItems((prev) => ({ ...prev, [run.stamp]: r.items })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, open, directory]);

  const toggle = (stamp: string, next: Open) => {
    const cur = open[stamp];
    const same = cur && cur.kind === next.kind && (cur.kind !== "doc" || (next.kind === "doc" && cur.path === next.path));
    setOpen({ ...open, [stamp]: same ? undefined : next });
    // 열 때마다 새로 받는다(진행 중인 실행은 결과 문서가 늘어난다)
    if (!same && next.kind === "doc" && directory) {
      void fetchDoc({ cwd: directory, path: next.path })
        .then((r) => setDocs((prev) => ({ ...prev, [next.path]: r.text })))
        .catch((e) => setDocs((prev) => ({ ...prev, [next.path]: `읽지 못했습니다: ${String(e)}` })));
    }
  };

  const c = theme.colors;
  const fontScale = useFontScale();
  const styles = useMemo(() => {
    const base = panelStyles(theme, layout.compact, fontScale);
    return { ...base, doc: { color: theme.colors.foreground, fontSize: base.fs(13), lineHeight: base.fs(19) } };
  }, [theme, layout.compact, fontScale]);
  const loadDoc = useCallback(
    async (path: string) => (directory ? (await fetchDoc({ cwd: directory, path })).text : ""),
    [directory, fetchDoc],
  );

  // 묻지 않고 기록+문서를 통째로 휴지통에 — 되돌릴 수 있는 곳이라 확인은 과잉이다(확장 onDelete, 08-21 결정)
  const moveToTrash = async (run: RunCard) => {
    if (!directory) return;
    try {
      const { moved } = await trashRun({
        cwd: directory,
        stamp: run.stamp,
        slug: run.slug,
        ...(run.subject ? { subject: run.subject } : {}),
        ...(run.mode ? { mode: run.mode } : {}),
      });
      if (moved) {
        watched.current.delete(run.stamp);
        notify("휴지통으로 옮겼습니다. 위 🗑 휴지통에서 다시 꺼낼 수 있습니다.");
      } else {
        // lock 이 남았거나 이미 파일이 없다. 손쓸 수 있는 lock 쪽을 말한다
        notify("아직 lock이 남아 있는 실행입니다 — 기록 중일 수 있어 아무것도 삭제하지 않았습니다.", "warn");
      }
    } catch (e) {
      notify(`휴지통으로 옮기지 못했습니다: ${String(e)}`, "warn");
    }
    setTrashKey((k) => k + 1);
    void load();
  };

  const phaseColor = (p: RunPhase) =>
    p === "done" ? c.statusSuccess : p === "failed" ? c.statusDanger : p === "stale" || p === "stopped" ? c.statusWarning : RUNNING_COLOR;

  if (!directory) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.muted}>작업 공간 폴더를 읽는 중입니다</Text>
        </View>
      </View>
    );
  }

  const renderCard = (run: RunCard) => {
    const over = isOver(run.phase);
    // 확장 카드 시계: "🕘 10/05 04:12 · 소요 01:20" — 끝났는데 끝 시각이 없으면 경과로 계속 센다(확장과 같음)
    const doneAt = over ? run.endedAt : undefined;
    const wc = workClock(run, over);
    const clock = run.startedAt
      ? `🕘 ${fmtStamp(run.startedAt)} · ${doneAt ? "소요" : "경과"} ${fmtElapsed((doneAt ?? now) - run.startedAt)}` +
        (wc ? ` (작업 ${fmtElapsed(wc.sum + (wc.live ? now - wc.live : 0))})` : "")
      : "";
    const multiTurn = !!run.turnDocs;
    const sub = [run.model ? run.model + (run.effort ? ` - ${run.effort}` : "") : "", fmtTok(run.totalTokens)].filter(Boolean).join(" · ");
    const o = open[run.stamp];
    const todoDone = run.todo?.filter((t) => t.done).length ?? 0;
    return (
      <View key={run.stamp} style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={2}>
            {run.subject || run.slug}
          </Text>
          {run.mode ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{run.mode.toUpperCase()}</Text>
            </View>
          ) : null}
          {run.turns >= 2 ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{run.turns}턴</Text>
            </View>
          ) : null}
          {run.docsOnly ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>문서만</Text>
            </View>
          ) : null}
          <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {/* 확장처럼 휴지통 다음 상태 칩. 끝난 실행만 삭제한다 — 쓰는 중에 지우면 send.sh 와 엇갈린다 */}
            {over ? (
              <Pressable style={styles.button} onPress={() => void moveToTrash(run)} accessibilityRole="button" accessibilityLabel="휴지통으로">
                <Text style={styles.buttonText}>🗑</Text>
              </Pressable>
            ) : null}
            <View style={[styles.chip, { backgroundColor: phaseColor(run.phase) }]}>
              <Text style={[styles.chipText, { color: c.accentForeground }]}>{PHASE_LABEL[run.phase]}</Text>
            </View>
          </View>
        </View>
        {sub ? <Text style={styles.muted}>{sub}</Text> : null}
        <Text style={styles.muted}>
          {clock}
          {run.phase === "stale" && run.staleForMs ? ` · ${Math.round(run.staleForMs / 1000)}초째 소식 없음` : ""}
          {run.todo?.length ? ` · 할 일 ${todoDone}/${run.todo.length}` : ""}
        </Text>
        {!over && run.latest ? (
          <View style={{ borderLeftWidth: 2, borderLeftColor: run.latestSteer ? STEER_COLOR : c.accent, paddingLeft: 8 }}>
            {/* 줄 수 제한 없이 패널 폭에 맞춰 줄바꿈 — 확장 .now(pre-wrap)와 같음(리규형님 10-06 "다 나와야 한다") */}
            <Text style={styles.text}>{run.latest}</Text>
          </View>
        ) : null}
        {run.phase === "failed" && run.failureMessage ? (
          <Text style={styles.error}>
            {run.failureMessage}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {run.itemCount > 0 ? (
            <Pressable style={styles.button} onPress={() => toggle(run.stamp, { kind: "items" })} accessibilityRole="button">
              <Text style={styles.buttonText}>{multiTurn ? `턴별 활동·문서 (활동 ${run.itemCount}개)` : `활동 ${run.itemCount}개`}</Text>
            </Pressable>
          ) : null}
          {/* 여러 턴 실행은 요청서·결과를 턴 머리표 옆으로 옮긴다(확장과 같음 — 위의 한 쌍은 문서 전체만 가리킨다) */}
          {!multiTurn && run.requestPath ? (
            <Pressable style={styles.button} onPress={() => toggle(run.stamp, { kind: "doc", path: run.requestPath! })} accessibilityRole="button">
              <Text style={styles.buttonText}>요청서</Text>
            </Pressable>
          ) : null}
          {!multiTurn && run.resultPath ? (
            <Pressable style={styles.button} onPress={() => toggle(run.stamp, { kind: "doc", path: run.resultPath! })} accessibilityRole="button">
              <Text style={styles.buttonText}>결과</Text>
            </Pressable>
          ) : null}
        </View>
        {o?.kind === "items" ? (
          <View style={styles.pane}>
            <RunItemsView key={run.stamp} run={run} items={items[run.stamp]} now={now} styles={styles} theme={theme} loadDoc={loadDoc} />
          </View>
        ) : null}
        {o?.kind === "doc" ? (
          <View style={styles.pane}>
            <Text style={styles.muted}>{o.path}</Text>
            <Text style={styles.doc} selectable>
              {docs[o.path] ?? "읽는 중입니다"}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  // 확장과 같은 배치: 묶음 이름과 띄운 대화가 같은 실행이 둘 이상이면 묶음 카드 하나로(10-01 결정).
  // 진행 중이거나 이 패널이 진행 중으로 본 것은 위에, 나머지는 "끝난 실행" 접힌 묶음 안에(열 때마다 닫힘).
  const runs = data?.runs ?? [];
  for (const r of runs) if (!isOver(r.phase)) watched.current.add(r.stamp);
  const keyCount = new Map<string, number>();
  for (const r of runs) if (r.groupKey) keyCount.set(r.groupKey, (keyCount.get(r.groupKey) ?? 0) + 1);
  const units: { key: string | null; runs: RunCard[] }[] = [];
  const unitAt = new Map<string, number>();
  for (const r of runs) {
    const k = r.groupKey && (keyCount.get(r.groupKey) ?? 0) >= 2 ? r.groupKey : null;
    if (!k) {
      units.push({ key: null, runs: [r] });
      continue;
    }
    if (!unitAt.has(k)) {
      unitAt.set(k, units.length);
      units.push({ key: k, runs: [] });
    }
    units[unitAt.get(k)!].runs.push(r);
  }
  const stayUp = (u: { runs: RunCard[] }) => u.runs.some((r) => !isOver(r.phase) || watched.current.has(r.stamp));
  const liveUnits = units.filter(stayUp);
  const overUnits = units.filter((u) => !stayUp(u));
  const overRuns = overUnits.flatMap((u) => u.runs);
  const overRunCount = overRuns.length;
  const overFail = overRuns.filter((r) => r.phase === "failed").length;
  const overStop = overRuns.filter((r) => r.phase === "stopped").length;

  const renderGroup = (key: string, rs: RunCard[]) => {
    const live = rs.filter((r) => r.phase === "running" || r.phase === "starting" || r.phase === "finalizing").length;
    const stale = rs.filter((r) => r.phase === "stale").length;
    const done = rs.filter((r) => r.phase === "done").length;
    const failed = rs.filter((r) => r.phase === "failed").length;
    const stopped = rs.filter((r) => r.phase === "stopped").length;
    const allOver = rs.every((r) => isOver(r.phase));
    const isOpen = groupOpen[key] ?? !allOver;
    // 안에서 가장 나쁜 상태가 칩이 된다(접혀 있어도 실패가 보이게)
    const state: RunPhase = live ? "running" : stale ? "stale" : failed ? "failed" : stopped ? "stopped" : "done";
    const counts = [`완료 ${done}/${rs.length}`, failed ? `실패 ${failed}건` : "", stopped ? `중단 ${stopped}건` : ""].filter(Boolean);
    const starts = rs.map((r) => r.startedAt ?? 0).filter(Boolean);
    const ends = rs.map((r) => r.endedAt ?? 0).filter(Boolean);
    const first = starts.length ? Math.min(...starts) : 0;
    const span = first && (!allOver || ends.length === rs.length) ? (allOver ? Math.max(...ends) : now) - first : 0;
    const tokens = rs.reduce((n, r) => n + (r.totalTokens ?? 0), 0);
    return (
      <View key={`g:${key}`} style={[styles.card, { gap: 8 }]}>
        <Pressable style={styles.head} onPress={() => setGroupOpen({ ...groupOpen, [key]: !isOpen })} accessibilityRole="button">
          <Text style={styles.muted}>{isOpen ? "▾" : "▸"}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {rs[0].group}
          </Text>
          <Text style={styles.muted}>{[...counts, span > 0 ? fmtDur(span) : ""].filter(Boolean).join(" · ")}</Text>
          <View style={[styles.chip, { backgroundColor: phaseColor(state), marginLeft: "auto", flexShrink: 0 }]}>
            <Text style={[styles.chipText, { color: c.accentForeground }]}>{PHASE_LABEL[state]}</Text>
          </View>
        </Pressable>
        {tokens ? <Text style={styles.muted}>{fmtTok(tokens)}</Text> : null}
        {isOpen ? rs.map(renderCard) : null}
      </View>
    );
  };

  const renderUnit = (u: { key: string | null; runs: RunCard[] }) => (u.key ? renderGroup(u.key, u.runs) : renderCard(u.runs[0]));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <NoticeLine notice={notice} theme={theme} />
      {data?.logDir ? (
        <View style={styles.actions}>
          <Pressable style={styles.button} onPress={() => setTrashOpen(!trashOpen)} accessibilityRole="button">
            <Text style={styles.buttonText}>{trashOpen ? "▾" : "▸"} 🗑 휴지통</Text>
          </Pressable>
          {/* 확장 renderUsage: codex_rescue 가 마지막으로 잰 값. [정리]는 값이 있을 때만(확장과 같음) */}
          {usage ? (
            <Text style={[styles.muted, { flexShrink: 1, alignSelf: "center" }]}>
              {usage.ok && usage.items && usage.computedAt
                ? `이 프로젝트의 Codex 기록 ${fmtBytes(usage.items.reduce((a, i) => a + i.bytes, 0))} — ` +
                  usage.items.map((i) => `${USAGE_LABEL[i.key]} ${fmtBytes(i.bytes)}`).join(" · ") +
                  ` · ${fmtClock(usage.computedAt)} 계산`
                : "이 프로젝트의 기록 용량은 다음에 Codex 를 실행할 때 계산됩니다."}
            </Text>
          ) : null}
          {usage?.ok && usage.items ? (
            <Pressable
              style={styles.button}
              onPress={() => setCleanOpen(!cleanOpen)}
              accessibilityRole="button"
              accessibilityLabel="정리"
              accessibilityHint="이 프로젝트에서 지금 지울 항목을 고릅니다. 지우기 전에 한 번 더 확인합니다."
            >
              <Text style={styles.buttonText}>정리</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {/* 용량 값이 사라져도 도는 정리를 가리지 않게 열린 동안은 그대로 둔다 */}
      {cleanOpen && directory ? (
        <CleanDrawer
          cwd={directory}
          styles={styles}
          theme={theme}
          notify={notify}
          onDone={() => {
            setTrashKey((k) => k + 1);
            void load();
          }}
          onClose={() => setCleanOpen(false)}
        />
      ) : null}
      {trashOpen && directory ? (
        <TrashDrawer cwd={directory} styles={styles} theme={theme} notify={notify} onChanged={() => void load()} reloadKey={trashKey} />
      ) : null}
      {error ? <Text style={styles.error}>목록을 읽지 못했습니다: {error}</Text> : null}
      {!data ? <Text style={styles.muted}>읽는 중입니다</Text> : null}
      {data && !data.logDir ? <Text style={styles.muted}>이 저장소에는 codex_rescue 실행 기록이 없습니다</Text> : null}
      {data?.logDir && data.runs.length === 0 ? <Text style={styles.muted}>아직 실행이 없습니다</Text> : null}

      {liveUnits.map(renderUnit)}
      {overUnits.length ? (
        <View style={{ gap: 8 }}>
          <Pressable style={styles.button} onPress={() => setDoneOpen(!doneOpen)} accessibilityRole="button">
            <Text style={styles.buttonText}>
              {doneOpen ? "▾" : "▸"} 끝난 실행 {overRunCount}건{overFail ? ` · 실패 ${overFail}건` : ""}{overStop ? ` · 중단 ${overStop}건` : ""}
            </Text>
          </Pressable>
          {doneOpen ? overUnits.map(renderUnit) : null}
        </View>
      ) : null}

      {data && data.older > 0 ? (
        <Pressable style={styles.button} onPress={() => setLimit(limit + PAGE)} accessibilityRole="button">
          <Text style={styles.buttonText}>이전 실행 {data.older}개 더 보기</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
