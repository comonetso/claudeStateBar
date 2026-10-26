import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { confirmItem, type LedgerItem, type LedgerView, saveMemo, viewLedger } from "../shared/ledger";

// 작업 공간 옆 "작업 장부" 탭 — 그 프로젝트의 장부를 날짜별로 보여 준다.
// 확인 대기(끝냄) 항목의 [확인] 은 사람이 "확인됨"을 찍는 유일한 화면 단추다.

type Theme = PluginWorkspacePanelProps["theme"];
type Tone = "accent" | "muted" | "warning" | "success";

const META: Record<string, { icon: string; label: string; tone: Tone }> = {
  "제안": { icon: "◇", label: "제안", tone: "accent" },
  "할 일": { icon: "○", label: "할 일", tone: "muted" },
  "진행 중": { icon: "▶", label: "진행 중", tone: "accent" },
  "끝냄": { icon: "◐", label: "확인 대기", tone: "warning" },
  "확인됨": { icon: "✓", label: "확인됨", tone: "success" },
  "보류": { icon: "‖", label: "보류", tone: "muted" },
  "버림": { icon: "✕", label: "버림", tone: "muted" },
};
const OPEN = new Set(["제안", "할 일", "진행 중", "끝냄", "보류"]);
const DONE = new Set(["끝냄", "확인됨", "버림"]);
const ORDER: Record<string, number> = { "끝냄": 0, "진행 중": 1, "할 일": 2, "제안": 3, "보류": 4, "확인됨": 5, "버림": 6 };
const WEEKDAY = "일월화수목금토";

function toneColor(theme: Theme, tone: Tone): string {
  const c = theme.colors;
  if (tone === "accent") return c.accent;
  if (tone === "warning") return c.statusWarning;
  if (tone === "success") return c.statusSuccess;
  return c.foregroundMuted;
}
function dayLabel(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return `${d.replace(/-/g, ".")} (${WEEKDAY[dt.getDay()] ?? ""})`;
}
function shortDay(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  return `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))} ${WEEKDAY[dt.getDay()] ?? ""}`;
}
function lastNote(it: LedgerItem) {
  // 설명·바뀐 것은 ? 팝업, 내 메모는 노트 아이콘, 묶음 줄은 부모 번호라 — 카드의 마지막 메모 줄에서 뺀다
  for (let i = it.log.length - 1; i >= 0; i--) if (it.log[i].text && !["설명", "묶음", "내 메모", "바뀜"].includes(it.log[i].kind)) return it.log[i];
  return null;
}
/** 정했던 것이 바뀐 기록(전 → 후 — 이유) — ? 팝업 맨 아래 "바뀐 것" 칸에만 보인다(10-26 리규형님) */
function changesOf(it: LedgerItem) {
  return it.log.filter((e) => e.kind === "바뀜" && e.text);
}

export function LedgerPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const view = useRpc(viewLedger);
  const confirm = useRpc(confirmItem);
  const [data, setData] = useState<LedgerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  // 위 숫자 칸(확인 대기·진행 중·할 일)과 날짜 단추 — 누르면 그것만, 다시 누르면 풀림(10-26 리규형님)
  const [stateOnly, setStateOnly] = useState<string | null>(null);
  const [dayOnly, setDayOnly] = useState<string | null>(null);
  // ? 로 연 설명 팝업의 항목 번호(10-26 리규형님 — 이름만으론 맥락뿐이라, 무엇을 왜 했는지는 팝업으로)
  const [helpId, setHelpId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 내 메모 팝업 — id = 큰 작업 번호, null = 프로젝트 메모. 메모가 있으면 보기 → 수정 누르면 입력칸(10-26 리규형님)
  const [memoFor, setMemoFor] = useState<{ id: string | null; title: string; text: string } | null>(null);
  const [memoEdit, setMemoEdit] = useState(false);
  const [memoDraft, setMemoDraft] = useState("");
  const [memoBusy, setMemoBusy] = useState(false);
  // 끝나지 않은 세부가 있는 큰 작업을 확인하려 할 때의 경고
  const [confirmWarn, setConfirmWarn] = useState<{ it: LedgerItem; left: LedgerItem[] } | null>(null);
  const memoRpc = useRpc(saveMemo);
  const compact = layout.compact;
  const c = theme.colors;

  const load = useCallback(async () => {
    if (!directory) return;
    setLoading(true);
    try {
      setData(await view({ directory }));
    } catch (e) {
      setData({ project: "", enabled: false, owner: "", behind: 0, builtAt: "", error: String(e), items: [] });
    } finally {
      setLoading(false);
    }
  }, [directory, view]);
  useEffect(() => {
    void load();
  }, [load]);

  const openMemo = (id: string | null, title: string, text: string) => {
    setMemoFor({ id, title, text });
    setMemoDraft(text);
    setMemoEdit(!text);
  };
  const doSaveMemo = async () => {
    if (!memoFor || !directory) return;
    setMemoBusy(true);
    try {
      const r = await memoRpc({ directory, id: memoFor.id, text: memoDraft });
      if (r.ok) {
        setMemoFor({ ...memoFor, text: memoDraft.trim() });
        setMemoEdit(!memoDraft.trim());
        setNotice(memoDraft.trim() ? "메모를 저장했습니다." : "메모를 지웠습니다.");
        void load();
      } else setNotice(r.message || "메모를 저장하지 못했습니다.");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setMemoBusy(false);
    }
  };
  // 끝나지 않은 세부가 있으면 바로 확인하지 않고 경고부터(10-26 리규형님)
  const askConfirm = (it: LedgerItem) => {
    const left = (data?.items ?? []).filter((x) => x.parent === it.id && !DONE.has(x.state));
    if (left.length) setConfirmWarn({ it, left });
    else void doConfirm(it.id);
  };
  const doConfirm = async (id: string) => {
    setNotice(null);
    setConfirmWarn(null);
    try {
      const r = await confirm({ id });
      setNotice(r.ok ? "확인됨으로 바꿨습니다." : r.message || "바꾸지 못했습니다.");
    } catch (e) {
      setNotice(String(e));
    }
    void load();
  };

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: compact ? 12 : 20, gap: 10, paddingBottom: 40 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      title: { color: c.foreground, fontSize: compact ? 17 : 19, fontWeight: "700" as const, flex: 1 },
      sub: { color: c.foregroundMuted, fontSize: 12 },
      chips: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      chip: { borderWidth: 1, borderColor: c.border, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 4 },
      chipOn: { borderColor: c.foreground },
      chipText: { color: c.foregroundMuted, fontSize: 13 },
      chipTextOn: { color: c.foreground },
      count: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: c.surface2, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 5 },
      dayRow: { flexDirection: "row" as const, gap: 6 },
      pillRow: { flexDirection: "row" as const, alignItems: "center" as const, alignSelf: "stretch" as const, gap: 8 },
      // 상태 표시(pill)와 같은 높이 — 위아래 2 · 글자 12 · 둥근 끝
      confirm: { backgroundColor: c.accent, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 2, borderWidth: 1, borderColor: c.accent },
      confirmText: { color: c.accentForeground, fontSize: 12, fontWeight: "700" as const },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexShrink: 1, flexWrap: "wrap" as const },
      help: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: c.foregroundMuted, alignItems: "center" as const, justifyContent: "center" as const },
      helpText: { color: c.foregroundMuted, fontSize: 12, fontWeight: "700" as const, lineHeight: 14 },
      kids: { marginTop: 6, gap: 8, borderLeftWidth: 2, borderColor: c.border, paddingLeft: 10 },
      kidRow: { flexDirection: "row" as const, gap: 8, alignItems: "flex-start" as const },
      kidState: { fontSize: 12, fontWeight: "600" as const, minWidth: 66, paddingTop: 2 },
      kidTitle: { color: c.foreground, fontSize: 14, flexShrink: 1 },
      // 설명 팝업 — PC 는 가운데 조금 큰 창, 폰은 좌우 여백을 조금 둔 큰 창
      overlay: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center" as const, justifyContent: "center" as const, padding: compact ? 12 : 32 },
      pop: { backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 14, width: compact ? ("100%" as const) : ("90%" as const), maxWidth: compact ? undefined : 780, maxHeight: compact ? ("88%" as const) : ("80%" as const), overflow: "hidden" as const },
      popHead: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10, padding: compact ? 14 : 18, borderBottomWidth: 1, borderColor: c.border },
      popTitle: { color: c.foreground, fontSize: compact ? 16 : 18, fontWeight: "700" as const, flex: 1 },
      popBody: { padding: compact ? 14 : 18, gap: 10 },
      popText: { color: c.foreground, fontSize: compact ? 14 : 15, lineHeight: compact ? 22 : 24 },
      popSub: { color: c.foregroundMuted, fontSize: 13, fontWeight: "700" as const, marginTop: 6 },
      noteBtn: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: c.foregroundMuted, alignItems: "center" as const, justifyContent: "center" as const, alignSelf: "center" as const },
      noteBtnOn: { borderColor: c.statusSuccess, backgroundColor: c.surface2 },
      noteText: { color: c.foregroundMuted, fontSize: 13, lineHeight: 15 },
      noteTextOn: { color: c.statusSuccess, fontWeight: "700" as const },
      input: { color: c.foreground, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, minHeight: compact ? 220 : 280, fontSize: compact ? 14 : 15, lineHeight: compact ? 22 : 24, textAlignVertical: "top" as const },
      actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8, padding: compact ? 12 : 16, borderTopWidth: 1, borderColor: c.border },
      primary: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
      primaryText: { color: c.accentForeground, fontSize: 14, fontWeight: "700" as const },
      danger: { backgroundColor: c.statusWarning, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 7 },
      countNum: { fontSize: 17, fontWeight: "700" as const },
      day: { color: c.foregroundMuted, fontSize: 12, fontWeight: "700" as const, marginTop: 12 },
      row: { backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: compact ? 10 : 12, gap: 4 },
      top: { flexDirection: compact ? ("column" as const) : ("row" as const), alignItems: compact ? ("flex-start" as const) : ("center" as const), gap: compact ? 4 : 10 },
      pill: { borderRadius: 99, paddingHorizontal: 9, paddingVertical: 2, backgroundColor: c.surface2, borderWidth: 1 },
      pillText: { fontSize: 12, fontWeight: "600" as const },
      itemTitle: { color: c.foreground, fontSize: 15, fontWeight: "600" as const, flexShrink: 1 },
      itemTitleClosed: { color: c.foregroundMuted },
      meta: { color: c.foregroundMuted, fontSize: 12 },
      note: { color: c.foregroundMuted, fontSize: 13 },
      hist: { borderTopWidth: 1, borderColor: c.border, marginTop: 6, paddingTop: 6, gap: 3 },
      histLine: { color: c.foregroundMuted, fontSize: 12 },
      ghost: { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
      ghostText: { color: c.foreground, fontSize: 13 },
      empty: { color: c.foregroundMuted, fontSize: 14, textAlign: "center" as const, paddingVertical: 30 },
      warn: { color: c.statusWarning, fontSize: 12 },
      err: { color: c.statusDanger, fontSize: 13 },
    }),
    [c, compact],
  );

  const items = data?.items ?? [];
  // 날짜 단추 = 기록이 남은 날(그날 한 일) · 최근 날부터
  const touched = (it: LedgerItem, d: string) => it.created.slice(0, 10) === d || it.log.some((e) => e.at.slice(0, 10) === d);
  const allDays = [...new Set(items.flatMap((it) => [it.created.slice(0, 10), ...it.log.map((e) => e.at.slice(0, 10))]))]
    .filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).sort().reverse();
  // 목록·숫자 칸은 큰 작업 기준 — 세부는 카드를 눌러 펼쳐 본다(10-26 리규형님). 부모가 사라진 세부는 큰 작업으로 본다
  const ids = new Set(items.map((it) => it.id));
  const tops = items.filter((it) => !it.parent || !ids.has(it.parent));
  const kidsOf = (id: string) => items.filter((x) => x.parent === id);
  const fits = (it: LedgerItem) =>
    (stateOnly ? it.state === stateOnly : filter === "all" || OPEN.has(it.state)) && (!dayOnly || touched(it, dayOnly));
  const openCount = tops.filter((t) => OPEN.has(t.state) || kidsOf(t.id).some((k) => OPEN.has(k.state))).length;
  // 숫자 칸(상태)을 고르면 큰 작업 자신의 상태로만 거른다 — 세부 상태로 섞어 보이던 것 고침(10-26 리규형님)
  const dayFits = (t: LedgerItem) => !dayOnly || touched(t, dayOnly) || kidsOf(t.id).some((k) => touched(k, dayOnly));
  const shown = stateOnly
    ? tops.filter((t) => t.state === stateOnly && dayFits(t))
    : tops.filter((t) => fits(t) || kidsOf(t.id).some(fits));
  const counts: Record<string, number> = {};
  for (const it of tops) counts[it.state] = (counts[it.state] ?? 0) + 1;
  const days = new Map<string, LedgerItem[]>();
  for (const it of shown) {
    const d = dayOnly ?? it.created.slice(0, 10);
    days.set(d, [...(days.get(d) ?? []), it]);
  }
  const dayKeys = [...days.keys()].sort().reverse();

  const pill = (state: string) => {
    const m = META[state] ?? { icon: "·", label: state, tone: "muted" as Tone };
    const col = toneColor(theme, m.tone);
    return (
      <View style={[styles.pill, { borderColor: col }]}>
        <Text style={[styles.pillText, { color: col }]}>{`${m.icon} ${m.label}`}</Text>
      </View>
    );
  };

  const confirmBtn = (it: LedgerItem) => (
    <Pressable style={styles.confirm} onPress={() => askConfirm(it)} accessibilityRole="button" accessibilityLabel={`${it.title} 확인`}>
      <Text style={styles.confirmText}>✓ 확인</Text>
    </Pressable>
  );

  const helpBtn = (it: LedgerItem) => (
    <Pressable style={styles.help} onPress={() => setHelpId(it.id)} accessibilityRole="button" accessibilityLabel={`${it.title} 자세한 설명`} hitSlop={8}>
      <Text style={styles.helpText}>?</Text>
    </Pressable>
  );
  // 노트 단추 — 내 메모가 있으면 초록(큰 작업 · 프로젝트)
  const noteBtn = (id: string | null, title: string, memo: string, label: string) => {
    const has = !!memo.trim();
    return (
      <Pressable style={[styles.noteBtn, has ? styles.noteBtnOn : null]} onPress={() => openMemo(id, title, memo)}
        accessibilityRole="button" accessibilityLabel={`${label} ${has ? "보기" : "쓰기"}`} hitSlop={8}>
        <Text style={[styles.noteText, has ? styles.noteTextOn : null]}>✎</Text>
      </Pressable>
    );
  };
  // 세부는 확인을 큰 작업에서 하므로 "확인 대기" 대신 "끝"(10-26 리규형님 — 큰 작업 진행 중·세부 확인 대기가 어색)
  const kidMeta = (state: string) => (state === "끝냄" ? { icon: "●", label: "끝", tone: "success" as Tone } : META[state] ?? { icon: "·", label: state, tone: "muted" as Tone });
  const helpItem = helpId ? items.find((x) => x.id === helpId) ?? null : null;
  const helpKids = helpItem ? kidsOf(helpItem.id) : [];

  return (
    <View style={styles.root}>
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>{`📒 ${data?.project || "작업 장부"}`}</Text>
        <Pressable style={styles.ghost} onPress={() => void load()} accessibilityRole="button" accessibilityLabel="장부 새로 읽기">
          <Text style={styles.ghostText}>{loading ? "읽는 중…" : "↻ 새로 읽기"}</Text>
        </Pressable>
      </View>
      {data?.builtAt ? <Text style={styles.sub}>{`${data.builtAt} 기준`}</Text> : null}
      {data && data.behind > 0 ? <Text style={styles.warn}>{`GitHub 에 아직 못 올린 기록 ${data.behind}개`}</Text> : null}
      {data?.error ? <Text style={styles.err}>{data.error}</Text> : null}
      {notice ? <Text style={styles.sub}>{notice}</Text> : null}

      <View style={styles.chips}>
        {(["끝냄", "진행 중", "할 일", "제안", "보류"] as const).filter((k) => counts[k]).map((k) => {
          const col = toneColor(theme, META[k].tone);
          const on = stateOnly === k;
          return (
            <Pressable key={k} style={[styles.count, { borderColor: on ? col : "transparent" }]} onPress={() => setStateOnly(on ? null : k)}
              accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${META[k].label}만 보기`}>
              <Text style={[styles.countNum, { color: col }]}>{counts[k]}</Text>
              <Text style={[styles.sub, { color: col }]}>{META[k].label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.chips}>
        {(["open", "all"] as const).map((f) => {
          const on = !stateOnly && filter === f;
          return (
            <Pressable key={f} style={[styles.chip, on ? styles.chipOn : null]} onPress={() => { setStateOnly(null); setFilter(f); }} accessibilityRole="button">
              <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{`${f === "open" ? "남은 일" : "전체"} ${f === "open" ? openCount : tops.length}`}</Text>
            </Pressable>
          );
        })}
        {/* 프로젝트 메모 — 전체 단추 옆(10-26 리규형님) */}
        {data && !data.error ? noteBtn(null, `${data.project} — 프로젝트 메모`, data.projectMemo ?? "", "프로젝트 메모") : null}
      </View>

      {allDays.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayRow}>
          {allDays.map((d) => {
            const on = dayOnly === d;
            return (
              <Pressable key={d} style={[styles.chip, on ? styles.chipOn : null]} onPress={() => setDayOnly(on ? null : d)}
                accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${dayLabel(d)} 한 일만 보기`}>
                <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{shortDay(d)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {data && !shown.length ? (
        <Text style={styles.empty}>{stateOnly || dayOnly ? "고른 조건에 맞는 항목이 없습니다." : filter === "open" ? "남은 일이 없습니다." : "이 프로젝트 장부가 비어 있습니다."}</Text>
      ) : null}

      {dayKeys.map((d) => (
        <View key={d} style={{ gap: 8 }}>
          <Text style={styles.day}>{dayLabel(d)}</Text>
          {(days.get(d) ?? [])
            .sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (a.updated < b.updated ? 1 : -1))
            .map((it) => {
              const ln = lastNote(it);
              const isOpen = openId === it.id;
              const closed = !OPEN.has(it.state);
              const kids = kidsOf(it.id).sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (a.created < b.created ? -1 : 1));
              const done = kids.filter((k) => DONE.has(k.state)).length;
              const meta = `${kids.length ? `${isOpen ? "▾" : "▸"} 세부 ${done}/${kids.length} · ` : ""}${it.id.slice(-4)} · ${it.updated.slice(5, 16)}`;
              const title = (
                <View style={[styles.titleRow, compact ? null : { flex: 1 }]}>
                  <Text style={[styles.itemTitle, closed ? styles.itemTitleClosed : null]}>{it.title}</Text>
                  {it.desc || changesOf(it).length ? helpBtn(it) : null}
                  {noteBtn(it.id, it.title, it.memo ?? "", "내 메모")}
                </View>
              );
              return (
                <Pressable key={it.id} style={styles.row} onPress={() => setOpenId(isOpen ? null : it.id)} accessibilityRole="button" accessibilityLabel={it.title}>
                  {/* 확인 단추는 첫 줄 상태 표시 바로 옆 — PC·폰 같게(높이도 그 표시와 같게) · 세로 공간 절약(10-26 리규형님) */}
                  {compact ? (
                    <View style={styles.top}>
                      <View style={styles.pillRow}>
                        {pill(it.state)}
                        {it.state === "끝냄" ? confirmBtn(it) : null}
                      </View>
                      {title}
                      <Text style={styles.meta}>{meta}</Text>
                    </View>
                  ) : (
                    <View style={styles.top}>
                      {pill(it.state)}
                      {it.state === "끝냄" ? confirmBtn(it) : null}
                      {title}
                      <Text style={styles.meta}>{meta}</Text>
                    </View>
                  )}
                  {ln ? <Text style={styles.note} numberOfLines={isOpen ? undefined : 2}>{`${ln.who}: ${ln.text}`}</Text> : null}
                  {isOpen && kids.length ? (
                    <View style={styles.kids}>
                      {kids.map((k) => {
                        const km = kidMeta(k.state);
                        const kl = lastNote(k);
                        return (
                          <View key={k.id} style={styles.kidRow}>
                            <Text style={[styles.kidState, { color: toneColor(theme, km.tone) }]}>{`${km.icon} ${km.label}`}</Text>
                            <View style={{ flex: 1, gap: 2 }}>
                              <View style={styles.titleRow}>
                                <Text style={[styles.kidTitle, OPEN.has(k.state) ? null : styles.itemTitleClosed]}>{k.title}</Text>
                                {k.desc || changesOf(k).length ? helpBtn(k) : null}
                              </View>
                              {kl ? <Text style={styles.histLine}>{`${kl.who}: ${kl.text}`}</Text> : null}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ) : null}
                  {isOpen ? (
                    <View style={styles.hist}>
                      {it.log.map((e, i) => (
                        <Text key={i} style={styles.histLine}>{`${e.at.slice(5, 16)} · ${e.who} · ${META[e.kind]?.label ?? e.kind}${e.text && e.kind !== "설명" ? ` · ${e.text}` : ""}`}</Text>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
        </View>
      ))}
    </ScrollView>
    {helpItem ? (
      <Pressable style={styles.overlay} onPress={() => setHelpId(null)} accessibilityRole="button" accessibilityLabel="설명 닫기">
        {/* 안쪽을 눌러도 닫히지 않게 — 바깥 어두운 곳이나 ✕ 로만 닫는다 */}
        <Pressable style={styles.pop} onPress={() => {}} accessibilityRole="none">
          <View style={styles.popHead}>
            {pill(helpItem.state)}
            <Text style={styles.popTitle}>{helpItem.title}</Text>
            <Pressable style={styles.ghost} onPress={() => setHelpId(null)} accessibilityRole="button" accessibilityLabel="설명 닫기">
              <Text style={styles.ghostText}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.popBody}>
            <Text style={styles.popText} selectable>{helpItem.desc || "설명이 아직 없습니다."}</Text>
            {helpKids.length ? <Text style={styles.popSub}>{`세부 ${helpKids.filter((k) => DONE.has(k.state)).length}/${helpKids.length}`}</Text> : null}
            {helpKids.map((k) => (
              <Text key={k.id} style={styles.popText}>{`${kidMeta(k.state).icon} ${k.title}  (${kidMeta(k.state).label})`}</Text>
            ))}
            {changesOf(helpItem).length ? <Text style={styles.popSub}>바뀐 것</Text> : null}
            {changesOf(helpItem).map((e, i) => (
              <Text key={`ch${i}`} style={styles.popText} selectable>{`${e.at.slice(5, 16)} · ${e.text}`}</Text>
            ))}
            <Text style={styles.meta}>{`${helpItem.id.slice(-4)} · 만든 때 ${helpItem.created.slice(5, 16)} · 마지막 ${helpItem.updated.slice(5, 16)}`}</Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    ) : null}
    {memoFor ? (
      <Pressable style={styles.overlay} onPress={() => !memoBusy && setMemoFor(null)} accessibilityRole="button" accessibilityLabel="메모 닫기">
        <Pressable style={styles.pop} onPress={() => {}} accessibilityRole="none">
          <View style={styles.popHead}>
            <Text style={styles.popTitle}>{`✎ ${memoFor.title}`}</Text>
            <Pressable style={styles.ghost} onPress={() => setMemoFor(null)} accessibilityRole="button" accessibilityLabel="메모 닫기">
              <Text style={styles.ghostText}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.popBody}>
            {memoEdit ? (
              <TextInput style={styles.input} multiline value={memoDraft} onChangeText={setMemoDraft} autoFocus
                placeholder={memoFor.id ? "이 작업에 남길 내 메모" : "이 프로젝트에 남길 내 메모"} placeholderTextColor={c.foregroundMuted} />
            ) : (
              <Text style={styles.popText} selectable>{memoFor.text}</Text>
            )}
          </ScrollView>
          <View style={styles.actions}>
            {memoEdit ? (
              <>
                {memoFor.text ? (
                  <Pressable style={styles.ghost} onPress={() => { setMemoDraft(memoFor.text); setMemoEdit(false); }} accessibilityRole="button">
                    <Text style={styles.ghostText}>취소</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.primary} onPress={() => void doSaveMemo()} disabled={memoBusy} accessibilityRole="button" accessibilityLabel="메모 저장">
                  <Text style={styles.primaryText}>{memoBusy ? "저장 중…" : "저장"}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable style={styles.primary} onPress={() => { setMemoDraft(memoFor.text); setMemoEdit(true); }} accessibilityRole="button" accessibilityLabel="메모 수정">
                <Text style={styles.primaryText}>수정</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>
    ) : null}
    {confirmWarn ? (
      <Pressable style={styles.overlay} onPress={() => setConfirmWarn(null)} accessibilityRole="button" accessibilityLabel="경고 닫기">
        <Pressable style={styles.pop} onPress={() => {}} accessibilityRole="none">
          <View style={styles.popHead}>
            <Text style={[styles.popTitle, { color: c.statusWarning }]}>{`⚠ 끝나지 않은 세부가 ${confirmWarn.left.length}개 있습니다`}</Text>
          </View>
          <ScrollView contentContainerStyle={styles.popBody}>
            <Text style={styles.popText}>{`"${confirmWarn.it.title}" 을 확인하면 이 세부들은 그대로 남습니다.`}</Text>
            {confirmWarn.left.map((k) => (
              <Text key={k.id} style={styles.popText}>{`${kidMeta(k.state).icon} ${k.title}  (${kidMeta(k.state).label})`}</Text>
            ))}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable style={styles.ghost} onPress={() => setConfirmWarn(null)} accessibilityRole="button">
              <Text style={styles.ghostText}>취소</Text>
            </Pressable>
            <Pressable style={styles.danger} onPress={() => void doConfirm(confirmWarn.it.id)} accessibilityRole="button" accessibilityLabel="그래도 확인">
              <Text style={styles.primaryText}>그래도 확인</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    ) : null}
    </View>
  );
}
