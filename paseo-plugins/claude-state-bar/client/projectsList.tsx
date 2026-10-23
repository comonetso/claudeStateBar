import { isOfflineFallback } from "./uiRole";
import { OFFLINE_NOTICE } from "../shared/offlineProjects";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { ACTIVE_ORDER_KEY, CATEGORY_ORDER_KEY, UNTAGGED_GROUP, type ProjectEntry } from "../shared/projects";
import { fontStep, scaled, useFontScale } from "./fontScale";
import {
  currentProjectKey,
  liveOf,
  moveCategory,
  orderedCategories,
  pinKey,
  reorderKeys,
  serverOf,
  useCurrentWorkspaceDir,
  useGroupOrders,
  usePins,
  type HostIndex,
  type Live,
  type ProjectsData,
} from "./projectsData";
import { countsTotal, useProjectCounts, type ProjectCounts, type ProjectTarget } from "./projectCounts";
import { arrangeRows, mainsOf, placeEntries } from "./projectSubs";
import { mostUrgent, StatusIndicator } from "./statusIndicator";
import { isTeamMember } from "./teamMode";
import { lineColor, UiInput } from "./ui";
import { setContextMenu, setDraggableRow, setHoverTitle, setNoTranslate } from "./web";
import { ProjectMenu, type ProjectMenuAt } from "./projectMenu";

// 프로젝트 목록 — 카테고리 묶음을 접고 편다(리규형님 10-05 결정: 꺼 둔 것은 따로 묶음 · 10-07: tags → category ·
// 10-11: "꺼 둠" → "숨김"으로 용어 통일, 카테고리 번호는 이름에서 떼고 순서대로 붙인다).
// 전체 화면과 왼쪽 목록 칸이 같이 쓴다. 칸(sidebar)은 폭이 좁아 도구 단추를 검색창 아래 줄에 둔다.

const PINNED_GROUP = "고정";
/** 왼쪽 칸 머리줄(워크스페이스·새로고침·A−·A+) — 폰 웹에서 Paseo 닫기 단추와 겹치는지 잴 때 쓴다 */
export const TOOLBAR_ID = "claude-state-bar-projects-toolbar";
const ACTIVE_GROUP = "활성";
const DISABLED_GROUP = "숨김";
// 카테고리 묶음 머리끼리 끌어 옮길 때 쓰는 끌기 묶음 이름(프로젝트 줄 묶음 이름과 겹치지 않게)
const CATEGORY_DRAG = ":category-headers";

// 펼친 묶음 — 화면을 닫았다 열어도 그대로(앱이 켜져 있는 동안, 전체 화면과 칸이 함께). 처음엔 활성만 펼치고 나머지(고정·카테고리·
// 숨김)는 접혀 있다 — "모두 접기"를 누른 모양과 같다(10-15 리규형님 "기본을 접힘으로 — 맨날 접어 놓으면 새로고침하면서 계속 펴져서")
const expanded = new Set<string>([ACTIVE_GROUP]);
// 하위 공간을 접은 메인(키 = pinKey) — 처음엔 펼침(10-24 리규형님 버튼). 묶음이 달라도(고정·활성·카테고리) 같은 메인이면 함께 접힌다.
// 묶음 접기처럼 앱이 켜져 있는 동안만 기억한다
const foldedSubs = new Set<string>();

/** 접힌 메인 줄에 하위 상태를 합친다(10-24 리규형님 버튼 "메인 줄에 합쳐 보이기") — 점은 가장 급한 것, 대화·돌고 있음·질문·압축 수는 더한다 */
function mergeLive(parts: (Live | null)[]): Live | null {
  let out: Live | null = null;
  for (const v of parts) {
    if (!v) continue;
    out = out
      ? { open: out.open + v.open, running: out.running + v.running, asking: out.asking + v.asking, compacting: out.compacting + v.compacting, bucket: mostUrgent(out.bucket, v.bucket) }
      : { open: v.open, running: v.running, asking: v.asking, compacting: v.compacting, bucket: v.bucket };
  }
  return out;
}

/** 작업 현황 숫자(서브에이전트·백그라운드·Codex)도 접힌 메인 줄에 더한다 */
function sumCounts(parts: (ProjectCounts | undefined)[]): ProjectCounts | undefined {
  let out: ProjectCounts | undefined;
  for (const v of parts) {
    if (!v) continue;
    out = out ? { subagents: out.subagents + v.subagents, background: out.background + v.background, codex: out.codex + v.codex } : { ...v };
  }
  return out;
}

export function ProjectsList(props: {
  theme: PluginTheme;
  variant: "screen" | "sidebar";
  data: ProjectsData | null;
  index: HostIndex;
  live: Map<string, Live>;
  busy: string | null;
  notice: string | null;
  onOpen: (e: ProjectEntry) => void;
  /** 프로젝트 관리 화면 열기(10-10 — 예전 "목록 파일 편집" 단추 자리). 없으면 단추를 숨긴다 — 큰 화면은 위 탭으로 오간다(10-11) */
  onManage?: () => void;
  onReload: () => void;
  /** 칸 위쪽 도구 줄 왼쪽에 끼울 것(워크스페이스 목록으로 넘기는 단추) */
  toolbarStart?: ReactNode;
  /** 왼쪽 칸 머리줄 오른쪽에 비울 폭 — 폰 웹에서 Paseo 닫기 단추가 덮는 만큼(projectsSidebar 가 잰다) */
  toolbarInset?: number;
}) {
  const { theme, variant, data, index, live, busy, notice, onOpen, onManage, onReload, toolbarStart, toolbarInset } = props;
  const [filter, setFilter] = useState("");
  const [, bump] = useState(0);
  // 줄 오른쪽 클릭·길게 누르기 메뉴(10-15) — 이름 복사·이름 바꾸기
  const [menu, setMenu] = useState<ProjectMenuAt | null>(null);
  const scale = useFontScale();
  const c = theme.colors;
  const readOnly = data?.readOnly === true || isOfflineFallback();
  const entries = data?.entries ?? [];
  const sidebar = variant === "sidebar";

  const { pins, order: pinOrder, toggle: togglePin, reorder: reorderPins } = usePins(readOnly);
  // 이 화면(브라우저 탭)이 지금 보고 있는 프로젝트 — 이름을 녹색으로(10-07 리규형님: 탭을 나눠 여러 프로젝트를 볼 때
  // 점·고리만으로는 지금 탭이 어느 프로젝트인지 안 보인다). 고정·활성·원래 묶음 어디서나
  const currentDir = useCurrentWorkspaceDir();
  const currentKey = useMemo(() => currentProjectKey(entries, index, currentDir), [entries, index, currentDir]);
  // 고정 줄을 끌어 놓은 자리로 — 놓은 줄의 위(after=false)·아래(after=true)
  const dropPin = (from: string, to: string, after: boolean) => {
    const next = pinOrder.filter((k) => k !== from);
    const at = next.indexOf(to);
    if (at < 0) return;
    next.splice(after ? at + 1 : at, 0, from);
    reorderPins(next);
  };
  // 고정 아닌 묶음의 순서(10-07) — 활성은 따로 이름 붙인 칸에, 카테고리 묶음은 묶음 이름 그대로
  const { orders, setOrder } = useGroupOrders(readOnly);
  const orderKey = (group: string) => (group === ACTIVE_GROUP ? ACTIVE_ORDER_KEY : group);
  const dropIn = (group: string, visible: string[]) => (from: string, to: string, after: boolean) => {
    const next = reorderKeys(orders[orderKey(group)] ?? [], visible, from, to, after);
    if (next) setOrder(orderKey(group), next);
  };
  // 목록 파일 순서 — 끌어 놓은 적 없는 줄과 묶음의 기본 순서(10-07 리규형님: 초기화하면 목록 파일 순서)
  const categoryGroup = (e: ProjectEntry) => (!e.enabled ? DISABLED_GROUP : e.category || UNTAGGED_GROUP);
  const fileRank = useMemo(() => new Map(entries.map((e, i) => [e, i] as const)), [entries]);
  // 카테고리 번호(10-11 리규형님) — 끌어 놓은 순서(순서 파일 ":categories") 다음에 목록 파일에 처음 나오는 순서. 숨긴 프로젝트만
  // 있는 카테고리도 번호를 받는다(프로젝트 관리 탭과 같은 번호). 카테고리 없음은 번호가 없다
  const categories = useMemo(() => orderedCategories(entries, orders[CATEGORY_ORDER_KEY] ?? []), [entries, orders]);
  const catNumber = useMemo(() => new Map(categories.map((name, i) => [name, i + 1] as const)), [categories]);
  const member = isTeamMember();
  // 이름 옆 작업 현황 숫자(10-14 리규형님) — 활성(열린 대화가 있는) 프로젝트만 그 기기에 묻는다. 같은 프로젝트가 고정·활성·원래
  // 묶음에 여러 줄로 나와도 한 번만 읽는다
  const countTargets = useMemo(() => {
    const out: ProjectTarget[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if ((member && !e.enabled) || e.missing) continue;
      const serverId = serverOf(e, index);
      if (!serverId || !liveOf(e, serverId, live)) continue;
      const key = pinKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, serverId, directory: e.path });
    }
    return out;
  }, [entries, index, live, member]);
  const projectCounts = useProjectCounts(countTargets);
  // 하위 공간 → 메인(10-24) — 메인 아래에 묶어 접고 펴며, 고정·활성·카테고리 어디서나 메인과 몰려 다닌다
  const mains = useMemo(() => mainsOf(entries), [entries]);
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // 어느 묶음에 넣는지는 projectSubs.placeEntries — 아래 규칙에 "하위가 든 묶음엔 메인도"·"고정은 메인 핀으로"를 더했다.
    // 팀원 화면은 메인이 숨긴 프로젝트를 아예 안 보인다(10-12 리규형님 "팀원은 숨김 카테를 히든 처리" — 숨김 묶음을 펼쳐
    // 눌러 들어가던 것). 활성·고정·찾기에도 안 나온다. 서버의 읽기 권한은 그대로라 팀원 Claude 의 분석은 된다.
    // 열린 대화가 있는 것(점이 회색·초록)은 고정이든 아니든 "활성"에 모은다 — 활성은 활성끼리 모아 보는 칸이고 고정은
    // 그대로 고정에 남는다(10-07 리규형님: "고정은 고정, 활성은 활성끼리"). 원래 묶음 쪽도 지금처럼(대화를 열고 닫을 때
    // 줄이 들락날락하지 않게). 고정한 것은 맨 위 "고정" 묶음에도 넣고 원래 묶음에도 그대로 둔다 — 원래 묶음에서 빠지면 지워진
    // 줄로 착각한다(10-06 처음엔 원래 묶음에서 뺐다 → 10-13 리규형님 "핀으로 고정을 해도 원래 카테에 남도록")
    const placed = placeEntries(entries, mains, {
      show: (e) => !(member && !e.enabled),
      matches: (e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.category.toLowerCase().includes(q),
      live: (e) => !!liveOf(e, serverOf(e, index), live),
      pinned: (e) => pins.has(pinKey(e)),
      category: categoryGroup,
      activeGroup: ACTIVE_GROUP,
      pinnedGroup: PINNED_GROUP,
    });
    // 묶음 순서: 고정·활성은 맨 위, 카테고리는 번호 순서, 그다음 카테고리 없음, 숨김은 맨 아래(10-11 리규형님 "숨김은 이동에서 제외,
    // 항상 맨 끝" — 카테고리 없음도 번호가 없어 자리 고정)
    const order = categories.filter((g) => placed.has(g));
    if (placed.has(ACTIVE_GROUP)) order.unshift(ACTIVE_GROUP);
    if (placed.has(PINNED_GROUP)) order.unshift(PINNED_GROUP);
    if (placed.has(UNTAGGED_GROUP)) order.push(UNTAGGED_GROUP);
    if (placed.has(DISABLED_GROUP)) order.push(DISABLED_GROUP);
    // 고정 묶음은 고정 목록 파일의 순서. 나머지는 끌어 놓은 순서(묶음별 순서 파일) 다음에, 끌어 놓은 적 없는 것을 목록 파일
    // 순서로 뒤에 붙인다 — 활성에 처음 들어온 것은 맨 아래(10-07 리규형님 결정. 처음엔 이름순이었다가 같은 날 목록 파일 순서로).
    // 고정 여부·순서는 하위면 메인 것을 본다 — 하위는 메인 바로 아래에 붙는다(arrangeRows)
    const pinOwner = (e: ProjectEntry) => mains.get(e) ?? e;
    const pinRank = (e: ProjectEntry) => pinOrder.indexOf(pinKey(pinOwner(e)));
    const sortIn = (g: string, items: ProjectEntry[]) => {
      if (g === PINNED_GROUP) return items.sort((a, b) => pinRank(a) - pinRank(b));
      const saved = orders[orderKey(g)] ?? [];
      const rank = (e: ProjectEntry) => {
        const i = saved.indexOf(pinKey(e));
        return i < 0 ? saved.length : i;
      };
      // 고정한 것은 원래 카테고리 안에서도 끌어 놓은 순서와 상관없이 맨 위, 고정 순서대로(10-13 리규형님 "즐겨찾기를 하면
      // 순서와 상관없이 해당 카테에서 최상단"). 활성 묶음은 대화를 열고 닫는 순서를 지키려고 그대로 둔다
      const pinFirst = g !== ACTIVE_GROUP;
      return items.sort((a, b) => {
        if (pinFirst) {
          const pa = pins.has(pinKey(pinOwner(a)));
          const pb = pins.has(pinKey(pinOwner(b)));
          if (pa !== pb) return pa ? -1 : 1;
          if (pa && pb) return pinRank(a) - pinRank(b);
        }
        return rank(a) - rank(b) || (fileRank.get(a) ?? 0) - (fileRank.get(b) ?? 0);
      });
    };
    return order.map((g) => {
      const { items, dragged } = placed.get(g) ?? { items: [], dragged: new Set<ProjectEntry>() };
      // 머리 숫자는 그 묶음 소속만 — 하위를 따라 끌려온 메인(활성 칸에서 메인 대화가 닫힌 것 등)은 빼고 센다
      return { name: g, rows: arrangeRows(sortIn(g, items), mains), count: items.length - dragged.size };
    });
  }, [entries, filter, pins, pinOrder, live, index, orders, categories, fileRank, member, mains]);
  // 카테고리 묶음 머리를 끌어 놓은 자리로(고정·활성·카테고리 없음·숨김은 자리 고정). 화면에 안 보이는 카테고리(찾기로 걸러진 것 등)도
  // 전체 순서에 남겨 번호가 흔들리지 않게 한다
  const onDropCategory = (from: string, to: string, after: boolean) => {
    const next = moveCategory(categories, from, to, after);
    if (next) setOrder(CATEGORY_ORDER_KEY, next);
  };

  // 글자는 기본보다 크게(10-05 "+3px"). 왼쪽 칸만 10-06 리규형님 "폰트 조금 줄이고"로 +1px
  const fs = (px: number) => scaled(px + (sidebar ? 1 : 3), scale);
  const btn = { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: lineColor(theme), backgroundColor: c.surface2 } as const;
  const search = (
    <UiInput theme={theme} fontSize={fs(13)} value={filter} onChangeText={setFilter} placeholder="이름·경로·카테고리로 찾기" style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 6 }} />
  );
  // 프로젝트 관리(10-10 리규형님: "사용자들이 json 을 건드는 건 좀 그래서") — 이름·카테고리·추가·삭제·켜고 끄기를 화면에서
  const editList = onManage ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="프로젝트 관리"
      ref={(node: unknown) => setHoverTitle(node, "프로젝트 관리 — 이름·카테고리 바꾸기, 추가·삭제, 켜고 끄기")}
      onPress={onManage}
      style={btn}
    >
      <Icon name="Folder" size={fs(13)} color={c.foreground} />
    </Pressable>
  ) : null;
  // 전체 접기·펼치기(10-07 리규형님 결정: 목록 파일 편집 아이콘 왼쪽, 아이콘 하나로 번갈아). 활성만 빼고 그대로 둔다
  // (10-07 처음엔 전부 → 같은 날 고정·활성 빼고 → 10-12 리규형님 "작업할 때 제일 중요한 건 활성" — 고정도 접는다).
  // 나머지가 다 접혀 있으면 모두 펼치고(숨김 포함), 하나라도 펼쳐져 있으면 모두 접는다
  const foldable = groups.filter((g) => g.name !== ACTIVE_GROUP);
  const allShut = foldable.length > 0 && foldable.every((g) => !expanded.has(g.name));
  const foldTitle = allShut ? "모두 펼치기" : "모두 접기";
  const foldAll = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={foldTitle}
      ref={(node: unknown) => setHoverTitle(node, foldTitle)}
      onPress={() => {
        for (const g of foldable) {
          if (allShut) expanded.add(g.name);
          else expanded.delete(g.name);
        }
        bump((n) => n + 1);
      }}
      style={btn}
    >
      <Icon name={allShut ? "ChevronsUpDown" : "ChevronsDownUp"} size={fs(13)} color={c.foreground} />
    </Pressable>
  );
  const tools = (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="목록 다시 읽기" onPress={onReload} style={btn}>
        <Icon name="RefreshCw" size={fs(11)} color={c.foreground} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="글자 작게" onPress={() => fontStep(-1)} style={btn}>
        <Text style={{ color: c.foreground, fontSize: fs(10) }}>A−</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="글자 크게" onPress={() => fontStep(1)} style={btn}>
        <Text style={{ color: c.foreground, fontSize: fs(10) }}>A+</Text>
      </Pressable>
    </>
  );

  // 브라우저 페이지 번역이 프로젝트·카테고리 이름을 바꾸지 않게(10-09 리규형님 화면: "Claude State Bar" → "클로드 주 변호사 협회") — 왼쪽 칸·묶음 화면 둘 다
  return (
    <View ref={setNoTranslate} style={{ gap: sidebar ? 6 : 10 }}>
      {sidebar ? (
        <>
          <View nativeID={TOOLBAR_ID} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: toolbarInset ?? 0 }}>
            {toolbarStart}
            <View style={{ flex: 1 }} />
            {tools}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {search}
            {foldAll}
            {editList}
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {search}
          {foldAll}
          {editList}
          {tools}
        </View>
      )}
      {readOnly ? <Text style={{ color: c.statusWarning, fontSize: fs(12) }}>{OFFLINE_NOTICE}</Text> : null}
      {notice ? <Text style={{ color: c.statusWarning, fontSize: fs(12) }}>{notice}</Text> : null}
      {data?.error ? <Text style={{ color: c.statusDanger, fontSize: fs(12) }}>{data.error}</Text> : null}
      {data && !data.source ? <Text style={{ color: c.foregroundMuted, fontSize: fs(12) }}>프로젝트 목록 파일을 찾지 못했습니다.</Text> : null}
      {groups.map((g) => {
        const shut = !expanded.has(g.name) && !filter.trim();
        // 하위 줄은 끌지 않는다 — 메인을 끌면 하위가 따라온다(메인 바로 아래에 붙으므로)
        const onDrop = g.name === PINNED_GROUP ? dropPin : dropIn(g.name, g.rows.filter((r) => !r.sub).map((r) => pinKey(r.e)));
        // 카테고리 묶음 머리도 끌어 옮긴다(10-07 리규형님) — 고정·활성·카테고리 없음·숨김 머리는 자리 고정
        const movable = catNumber.has(g.name);
        return (
          <View key={g.name} style={{ gap: 2 }}>
            <Pressable
              ref={(node: unknown) => {
                if (movable && !readOnly) setDraggableRow(node, g.name, CATEGORY_DRAG, c.accent, onDropCategory);
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded: !shut }}
              onPress={() => {
                if (expanded.has(g.name)) expanded.delete(g.name);
                else expanded.add(g.name);
                bump((n) => n + 1);
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
            >
              <Icon name={shut ? "ChevronRight" : "ChevronDown"} size={fs(14)} color={c.foregroundMuted} />
              <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: fs(13), fontWeight: "600" }} numberOfLines={1}>
                {catNumber.has(g.name) ? `${catNumber.get(g.name)}. ${g.name}` : g.name}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: fs(11) }}>{g.count}</Text>
            </Pressable>
            {shut
              ? null
              : g.rows.map(({ e, sub, subs }) => {
                  // 하위 줄은 메인을 접으면 숨긴다. 접힌 메인 줄은 하위 상태를 합쳐 보인다(10-24 리규형님 버튼)
                  const main = sub ? mains.get(e) : undefined;
                  if (main && foldedSubs.has(pinKey(main))) return null;
                  const folded = subs.length > 0 && foldedSubs.has(pinKey(e));
                  const serverId = serverOf(e, index);
                  const known = !!serverId;
                  const opening = busy === e.path;
                  const own = liveOf(e, serverId, live);
                  const alive = folded ? mergeLive([own, ...subs.map((s) => liveOf(s, serverOf(s, index), live))]) : own;
                  // 살아 있는 세션: Paseo 워크스페이스 목록과 같은 표시(10-07 — 돌고 있음 고리·답 기다림 느낌표·실패·안 본 끝남
                  // 초록 점·끝남 흐린 점, statusIndicator). 대화가 없으면 자리만(이름 줄이 흔들리지 않게)
                  const hostText = opening ? "여는 중…" : e.missing ? "폴더 없음" : !known ? `${e.host} · 연결 없음` : e.host;
                  // 왼쪽 칸은 폭이 좁아 기기 이름이 프로젝트 이름을 "…"로 자른다 → 기기 이름은 마우스를 올리면 뜨는 설명으로만,
                  // 상태(여는 중·폴더 없음·연결 없음)는 그대로 이름 옆에(10-06 리규형님 — 이름에 기기를 대개 적어 둠)
                  // 연결 안 된 기기(방화벽 등)는 글자 대신 이름을 주황(테마 경고 색)으로 — 왼쪽 칸이 좁아 "연결 없음"이 이름을
                  // 자르던 것(10-06 리규형님). 마우스를 올리면 "기기 · 연결 없음"
                  const sideText = sidebar ? (opening ? "여는 중…" : e.missing ? "폴더 없음" : null) : hostText;
                  // 접힌 메인 줄은 지금 탭이 하위여도 초록(하위 줄이 안 보이므로)
                  const current = pinKey(e) === currentKey || (folded && subs.some((s) => pinKey(s) === currentKey));
                  const nameColor = current ? c.statusSuccess : e.missing ? c.foregroundMuted : !known ? c.statusWarning : c.foreground;
                  const key = pinKey(e);
                  const pinned = pins.has(key);
                  // 셋 다 0 이면 숨긴다(10-14 리규형님). Codex = 실행 + 핑퐁 채팅. 접힌 메인 줄은 하위 것까지 더한다
                  const countsOf = (x: ProjectEntry) => (liveOf(x, serverOf(x, index), live) ? projectCounts.get(pinKey(x)) : undefined);
                  const work = folded ? sumCounts([e, ...subs].map(countsOf)) : alive ? projectCounts.get(key) : undefined;
                  const workText = work && countsTotal(work) > 0 ? `(${work.subagents}, ${work.background}, ${work.codex})` : null;
                  // 고정·활성은 여러 카테고리가 섞여 소속이 안 보인다 → 카테고리 번호를 이름 앞 작은 배지로(10-09 리규형님 결정 —
                  // 카테고리 이름을 통째로 붙이면 좁은 칸에서 프로젝트 이름이 잘린다). 10-11부터 번호는 카테고리 순서(끌어 옮긴 순서)이고
                  // 카테고리 없음은 배지 없음. 마우스를 올리면 카테고리 이름도 뜬다. 원래 카테고리 묶음 안 줄은 그대로
                  const mixed = g.name === PINNED_GROUP || g.name === ACTIVE_GROUP;
                  // 하위 줄은 메인과 같은 카테고리면 배지를 뺀다(바로 위 메인 줄에 있다)
                  const sameAsMain = !!main && main.category === e.category;
                  const badge = mixed && !sameAsMain && catNumber.has(e.category) ? String(catNumber.get(e.category)) : null;
                  // 하위 줄의 점은 메인 줄 번호 칸 자리에 둔다 — 이름 앞머리가 메인 이름과 맞게(10-24 리규형님 "앞대가리가 정렬되도록,
                  // 똥글뺑이를 좀 밀어 넣으면"). 번호 칸이 없는 카테고리 묶음에선 점이 메인 이름 첫 글자 아래에 온다
                  const mainBadge = main && mixed && catNumber.has(main.category) ? String(catNumber.get(main.category)) : null;
                  const badgeBox = { flexShrink: 0, minWidth: fs(15), paddingHorizontal: 3, borderRadius: 4, borderWidth: 1, borderColor: c.border, alignItems: "center" } as const;
                  const hoverHost = !known && !e.missing ? `${e.host} · 연결 없음` : e.host;
                  return (
                    <Pressable
                      key={`${g.name}|${e.host}|${e.path}|${e.name}`}
                      ref={(node: unknown) => {
                        setHoverTitle(node, mixed && badge ? `${badge}. ${e.category} · ${hoverHost}` : hoverHost);
                        // 마우스로 끌어 같은 묶음 안 순서를 바꾼다(10-06 고정 → 10-07 모든 묶음, PC·웹 — 폰은 순서 바꾸기 없음)
                        if (!readOnly && !sub) setDraggableRow(node, key, g.name, c.accent, onDrop);
                        setContextMenu(node, (x, y) => setMenu({ entry: e, x, y }));
                      }}
                      // 폰은 길게 누르기(껍데기 앱 웹뷰가 contextmenu 를 안 낼 수도 있어 둘 다 단다 — 같은 메뉴를 다시 여는 것뿐)
                      onLongPress={(ev: { nativeEvent?: { pageX?: number; pageY?: number } }) =>
                        setMenu({ entry: e, x: ev?.nativeEvent?.pageX ?? 40, y: ev?.nativeEvent?.pageY ?? 80 })}
                      accessibilityRole="button"
                      // 폰 앱에서 고를 때 진동하는 자리 표시(client/haptics.ts HAPTIC_TARGETS)
                      testID="csb-project-open"
                      accessibilityLabel={`${e.name}${mixed && e.category ? ` (${e.category})` : ""} 열기${alive ? ` (열린 대화 ${alive.open}개${alive.running ? `, 돌고 있음 ${alive.running}개` : ""}${alive.asking ? `, 질문 대기 ${alive.asking}개` : ""})` : ""}`}
                      disabled={!!busy || (e.missing && !(readOnly && e.host === "PC"))}
                      onPress={() => onOpen(e)}
                      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
                        { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: sidebar ? 4 : 6, paddingLeft: sidebar ? 14 : 18, paddingRight: 6, borderRadius: 6 },
                        (hovered || pressed) && { backgroundColor: c.surface2 },
                      ]}
                    >
                      {({ hovered }: { hovered?: boolean; pressed: boolean }) => (
                        <>
                          {/* 하위 줄: 메인 점 자리를 비우고(같은 크기 빈 칸) 다음 칸에 점 */}
                          {sub ? <StatusIndicator bucket={null} theme={theme} /> : null}
                          {sub && mainBadge ? (
                            // 메인 번호를 안 보이게 넣어 번호 칸과 같은 폭을 잡고 점을 그 가운데에
                            <View style={{ flexShrink: 0, justifyContent: "center" }}>
                              <View style={[badgeBox, { opacity: 0 }]}>
                                <Text style={{ fontSize: fs(10) }}>{mainBadge}</Text>
                              </View>
                              <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" }}>
                                <StatusIndicator bucket={alive?.bucket ?? null} theme={theme} />
                              </View>
                            </View>
                          ) : (
                            <StatusIndicator bucket={alive?.bucket ?? null} theme={theme} />
                          )}
                          {badge ? (
                            <View style={badgeBox}>
                              <Text style={{ color: c.foregroundMuted, fontSize: fs(10) }}>{badge}</Text>
                            </View>
                          ) : null}
                          <Text style={{ flexShrink: 1, color: nameColor, fontSize: fs(12) }} numberOfLines={1}>
                            {e.name}
                          </Text>
                          {alive && alive.open > 1 ? <Text style={{ flexShrink: 0, color: c.foregroundMuted, fontSize: fs(10) }}>{alive.open}</Text> : null}
                          {workText && work ? (
                            <Text
                              ref={(node: unknown) => setHoverTitle(node, `서브에이전트 ${work.subagents} · 백그라운드 ${work.background} · Codex ${work.codex}`)}
                              accessibilityLabel={`작업 현황: 서브에이전트 ${work.subagents}개, 백그라운드 ${work.background}개, Codex ${work.codex}개`}
                              style={{ flexShrink: 0, color: c.foregroundMuted, fontSize: fs(10) }}
                            >
                              {workText}
                            </Text>
                          ) : null}
                          {/* 하위 공간 접기·펼치기(10-24 리규형님 그림 — 이름·숫자 바로 뒤). 누르면 줄 열기는 하지 않는다 */}
                          {subs.length > 0 ? (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`${e.name} 하위 ${subs.length}개 ${folded ? "펼치기" : "접기"}`}
                              ref={(node: unknown) => setHoverTitle(node, `하위 ${subs.length}개 ${folded ? "펼치기" : "접기"}`)}
                              hitSlop={6}
                              onPress={(ev) => {
                                ev?.stopPropagation?.();
                                if (!foldedSubs.delete(key)) foldedSubs.add(key);
                                bump((n) => n + 1);
                              }}
                              style={{ flexShrink: 0 }}
                            >
                              <Icon name={folded ? "ChevronRight" : "ChevronDown"} size={fs(12)} color={c.foregroundMuted} />
                            </Pressable>
                          ) : null}
                          {sideText ? (
                            <Text style={{ flexShrink: 0, marginLeft: 4, color: c.foregroundMuted, fontSize: fs(11) }} numberOfLines={1}>
                              {sideText}
                            </Text>
                          ) : null}
                          <View style={{ flex: 1 }} />
                          {/* 맨 위 고정 핀(10-06 리규형님): 고정된 것은 항상, 나머지는 마우스를 올릴 때만(폰은 마우스가 없어 항상).
                              자리는 늘 잡아 둬서 나타날 때 이름 줄이 흔들리지 않는다. 활성 묶음 줄에는 핀이 없다 — 고정·풀기는 원래 묶음과
                              고정 묶음에서(10-07 리규형님 "활성에서만 고정 해제 버튼 제거" · 10-13부터 고정한 줄도 원래 묶음에 남는다) */}
                          {/* 활성 줄 오른쪽 빈자리(핀이 없는 자리): Claude 가 질문을 올려 답을 기다리면 물음표(10-09 리규형님 "질문이
                              올라온 세션 표시, 활성 탭만"). 색은 Paseo "답을 기다림" 색(왼쪽 점 느낌표와 같은 주황) */}
                          {/* 그 옆에 압축 명령어를 기다리는 대화가 있으면 안으로 모이는 화살표(10-15 리규형님 "질문지 올라올 때 ? 넣듯이"),
                              같은 주황 — 데몬 푸시 판정(compactReady.ts)을 읽는다 */}
                          {g.name === ACTIVE_GROUP ? (
                            alive && (alive.asking > 0 || alive.compacting > 0) ? (
                              <View style={{ flexShrink: 0, flexDirection: "row", gap: 4 }}>
                                {alive.asking > 0 ? (
                                  <View accessibilityLabel={`질문 대기 ${alive.asking}개`}>
                                    <Icon name="MessageCircleQuestionMark" size={fs(13)} color={c.statusWarning} />
                                  </View>
                                ) : null}
                                {alive.compacting > 0 ? (
                                  <View accessibilityLabel={`압축 준비 ${alive.compacting}개`}>
                                    <Icon name="Shrink" size={fs(13)} color={c.statusWarning} />
                                  </View>
                                ) : null}
                              </View>
                            ) : null
                          ) : sub ? (
                            // 하위 줄엔 핀이 없다 — 고정은 메인 핀 하나로 묶음 전체(10-24 리규형님 버튼). 자리만 잡아 이름 줄을 맞춘다
                            <View style={{ flexShrink: 0, width: fs(11) }} />
                          ) : (
                            <Pressable
                              accessibilityRole="button"
                              disabled={readOnly}
                              accessibilityLabel={pinned ? `${e.name} 고정 풀기` : `${e.name} 맨 위에 고정`}
                              hitSlop={6}
                              onPress={(ev) => {
                                ev?.stopPropagation?.();
                                togglePin(key);
                              }}
                              style={{ flexShrink: 0, opacity: pinned || hovered || Platform.OS !== "web" ? 1 : 0 }}
                            >
                              <Icon name="Pin" size={fs(11)} color={pinned ? c.accent : c.foregroundMuted} />
                            </Pressable>
                          )}
                        </>
                      )}
                    </Pressable>
                  );
                })}
          </View>
        );
      })}
      {data?.source && !sidebar ? <Text style={{ color: c.foregroundMuted, fontSize: fs(11), marginTop: 8 }}>목록 파일: {data.source}</Text> : null}
      {menu ? <ProjectMenu theme={theme} at={menu} readOnly={readOnly} fontSize={fs(12)} onClose={() => setMenu(null)} onChanged={onReload} /> : null}
    </View>
  );
}

