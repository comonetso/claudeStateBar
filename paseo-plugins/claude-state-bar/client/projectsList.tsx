import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { ACTIVE_ORDER_KEY, CATEGORY_ORDER_KEY, type ProjectEntry } from "../shared/projects";
import { fontStep, scaled, useFontScale } from "./fontScale";
import {
  currentProjectKey,
  liveOf,
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
import { StatusIndicator } from "./statusIndicator";
import { setDraggableRow, setHoverTitle, setNoTranslate } from "./web";

// 프로젝트 목록 — 카테고리 묶음을 접고 편다(리규형님 10-05 결정: 꺼 둔 것은 "꺼 둠" 묶음 · 10-07: tags → category).
// 전체 화면과 왼쪽 목록 칸이 같이 쓴다. 칸(sidebar)은 폭이 좁아 도구 단추를 검색창 아래 줄에 둔다.

const PINNED_GROUP = "고정";
const ACTIVE_GROUP = "활성";
const DISABLED_GROUP = "꺼 둠";
const UNTAGGED_GROUP = "카테고리 없음";
// 카테고리 묶음 머리끼리 끌어 옮길 때 쓰는 끌기 묶음 이름(프로젝트 줄 묶음 이름과 겹치지 않게)
const CATEGORY_DRAG = ":category-headers";

// 접은 묶음은 화면을 닫았다 열어도 그대로(앱이 켜져 있는 동안, 전체 화면과 칸이 함께). 꺼 둠은 처음부터 접혀 있다
const collapsed = new Set<string>([DISABLED_GROUP]);

export function ProjectsList(props: {
  theme: PluginTheme;
  variant: "screen" | "sidebar";
  data: ProjectsData | null;
  index: HostIndex;
  live: Map<string, Live>;
  busy: string | null;
  notice: string | null;
  onOpen: (e: ProjectEntry) => void;
  /** 목록 파일 열기(10-08) — 공식 이동을 가진 쪽에 맡긴다. 이유 글을 돌려주면 목록 위에 띄운다 */
  onEditList: (serverId: string | undefined, source: string | null) => Promise<string | null>;
  onReload: () => void;
  /** 칸 위쪽 도구 줄 왼쪽에 끼울 것(워크스페이스 목록으로 넘기는 단추) */
  toolbarStart?: ReactNode;
}) {
  const { theme, variant, data, index, live, busy, notice, onOpen, onEditList, onReload, toolbarStart } = props;
  // 목록 파일 편집 = Paseo 편집기 탭(10-07 — 별도 편집 화면을 없앴다). 못 열면 이유를 목록 위에 보인다
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [, bump] = useState(0);
  const scale = useFontScale();
  const c = theme.colors;
  const entries = data?.entries ?? [];
  const sidebar = variant === "sidebar";

  const { pins, order: pinOrder, toggle: togglePin, reorder: reorderPins } = usePins();
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
  const { orders, setOrder } = useGroupOrders();
  const orderKey = (group: string) => (group === ACTIVE_GROUP ? ACTIVE_ORDER_KEY : group);
  const dropIn = (group: string, visible: string[]) => (from: string, to: string, after: boolean) => {
    const next = reorderKeys(orders[orderKey(group)] ?? [], visible, from, to, after);
    if (next) setOrder(orderKey(group), next);
  };
  // 목록 파일 순서 — 끌어 놓은 적 없는 줄과 묶음의 기본 순서(10-07 리규형님: 초기화하면 목록 파일 순서)
  const categoryGroup = (e: ProjectEntry) => (!e.enabled ? DISABLED_GROUP : e.category || UNTAGGED_GROUP);
  const fileRank = useMemo(() => new Map(entries.map((e, i) => [e, i] as const)), [entries]);
  const firstSeen = useMemo(() => {
    const m = new Map<string, number>();
    entries.forEach((e, i) => {
      const g = categoryGroup(e);
      if (!m.has(g)) m.set(g, i);
    });
    return m;
  }, [entries]);
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, ProjectEntry[]>();
    const add = (g: string, e: ProjectEntry) => map.set(g, [...(map.get(g) ?? []), e]);
    for (const e of entries) {
      if (q && !e.name.toLowerCase().includes(q) && !e.path.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue;
      // 열린 대화가 있는 것(점이 회색·초록)은 고정이든 아니든 "활성"에 모은다 — 활성은 활성끼리 모아 보는 칸이고 고정은
      // 그대로 고정에 남는다(10-07 리규형님: "고정은 고정, 활성은 활성끼리"). 원래 묶음 쪽도 지금처럼(대화를 열고 닫을 때
      // 줄이 들락날락하지 않게)
      if (liveOf(e, serverOf(e, index), live)) add(ACTIVE_GROUP, e);
      // 고정한 것은 맨 위 "고정" 묶음으로 옮기고 원래 묶음에서는 뺀다(10-06 리규형님 결정)
      if (pins.has(pinKey(e))) {
        add(PINNED_GROUP, e);
        continue;
      }
      add(categoryGroup(e), e);
    }
    // 카테고리 묶음 순서: 끌어 놓은 순서(순서 파일 ":categories") 다음에, 끌어 놓은 적 없는 것은 목록 파일에 처음 나오는 순서
    // (10-07 리규형님: 초기화하면 목록 파일 순서). 고정·활성은 맨 위, 꺼 둠은 맨 아래에 그대로
    const special = new Set([PINNED_GROUP, ACTIVE_GROUP, DISABLED_GROUP]);
    const savedCats = orders[CATEGORY_ORDER_KEY] ?? [];
    const catRank = (g: string) => {
      const i = savedCats.indexOf(g);
      return i < 0 ? savedCats.length : i;
    };
    const order = [...map.keys()].filter((g) => !special.has(g)).sort((a, b) => catRank(a) - catRank(b) || (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0));
    if (map.has(ACTIVE_GROUP)) order.unshift(ACTIVE_GROUP);
    if (map.has(PINNED_GROUP)) order.unshift(PINNED_GROUP);
    if (map.has(DISABLED_GROUP)) order.push(DISABLED_GROUP);
    // 고정 묶음은 고정 목록 파일의 순서. 나머지는 끌어 놓은 순서(묶음별 순서 파일) 다음에, 끌어 놓은 적 없는 것을 목록 파일
    // 순서로 뒤에 붙인다 — 활성에 처음 들어온 것은 맨 아래(10-07 리규형님 결정. 처음엔 이름순이었다가 같은 날 목록 파일 순서로)
    const pinRank = (e: ProjectEntry) => pinOrder.indexOf(pinKey(e));
    const sortIn = (g: string, items: ProjectEntry[]) => {
      if (g === PINNED_GROUP) return items.sort((a, b) => pinRank(a) - pinRank(b));
      const saved = orders[orderKey(g)] ?? [];
      const rank = (e: ProjectEntry) => {
        const i = saved.indexOf(pinKey(e));
        return i < 0 ? saved.length : i;
      };
      return items.sort((a, b) => rank(a) - rank(b) || (fileRank.get(a) ?? 0) - (fileRank.get(b) ?? 0));
    };
    return order.map((g) => ({ name: g, items: sortIn(g, map.get(g) ?? []) }));
  }, [entries, filter, pins, pinOrder, live, index, orders, firstSeen, fileRank]);
  // 카테고리 묶음 머리를 끌어 놓은 자리로(고정·활성·꺼 둠은 자리 고정)
  const onDropCategory = (from: string, to: string, after: boolean) => {
    const visible = groups.map((g) => g.name).filter((n) => n !== PINNED_GROUP && n !== ACTIVE_GROUP && n !== DISABLED_GROUP);
    const next = reorderKeys(orders[CATEGORY_ORDER_KEY] ?? [], visible, from, to, after);
    if (next) setOrder(CATEGORY_ORDER_KEY, next);
  };

  // 글자는 기본보다 크게(10-05 "+3px"). 왼쪽 칸만 10-06 리규형님 "폰트 조금 줄이고"로 +1px
  const fs = (px: number) => scaled(px + (sidebar ? 1 : 3), scale);
  const btn = { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, backgroundColor: c.surface2 } as const;
  const search = (
    <TextInput
      value={filter}
      onChangeText={setFilter}
      placeholder="이름·경로·카테고리로 찾기"
      placeholderTextColor={c.foregroundMuted}
      style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: fs(13), paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}
    />
  );
  const editList = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="목록 파일 편집"
      ref={(node: unknown) => setHoverTitle(node, data?.source ? `목록 파일 편집: ${data.source}` : "목록 파일 편집")}
      onPress={() => {
        setEditNotice(null);
        void onEditList(index.byAlias.get("PC"), data?.source ?? null).then(setEditNotice);
      }}
      style={btn}
    >
      <Icon name="FileJson" size={fs(13)} color={c.foreground} />
    </Pressable>
  );
  // 전체 접기·펼치기(10-07 리규형님 결정: 목록 파일 편집 아이콘 왼쪽, 아이콘 하나로 번갈아). 고정·활성은 빼고 그대로 둔다
  // (같은 날 정정 — 처음엔 고정·활성까지 전부였다). 나머지가 다 접혀 있으면 모두 펼치고(꺼 둠 포함), 하나라도 펼쳐져 있으면 모두 접는다
  const foldable = groups.filter((g) => g.name !== PINNED_GROUP && g.name !== ACTIVE_GROUP);
  const allShut = foldable.length > 0 && foldable.every((g) => collapsed.has(g.name));
  const foldTitle = allShut ? "모두 펼치기" : "모두 접기";
  const foldAll = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={foldTitle}
      ref={(node: unknown) => setHoverTitle(node, foldTitle)}
      onPress={() => {
        for (const g of foldable) {
          if (allShut) collapsed.delete(g.name);
          else collapsed.add(g.name);
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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
      {notice ? <Text style={{ color: c.statusWarning, fontSize: fs(12) }}>{notice}</Text> : null}
      {editNotice ? <Text style={{ color: c.statusWarning, fontSize: fs(12) }}>{editNotice}</Text> : null}
      {data?.error ? <Text style={{ color: c.statusDanger, fontSize: fs(12) }}>{data.error}</Text> : null}
      {data && !data.source ? <Text style={{ color: c.foregroundMuted, fontSize: fs(12) }}>프로젝트 목록 파일을 찾지 못했습니다.</Text> : null}
      {groups.map((g) => {
        const shut = collapsed.has(g.name) && !filter.trim();
        const onDrop = g.name === PINNED_GROUP ? dropPin : dropIn(g.name, g.items.map(pinKey));
        // 카테고리 묶음 머리도 끌어 옮긴다(10-07 리규형님) — 고정·활성·꺼 둠 머리는 자리 고정
        const movable = g.name !== PINNED_GROUP && g.name !== ACTIVE_GROUP && g.name !== DISABLED_GROUP;
        return (
          <View key={g.name} style={{ gap: 2 }}>
            <Pressable
              ref={(node: unknown) => {
                if (movable) setDraggableRow(node, g.name, CATEGORY_DRAG, c.accent, onDropCategory);
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded: !shut }}
              onPress={() => {
                if (collapsed.has(g.name)) collapsed.delete(g.name);
                else collapsed.add(g.name);
                bump((n) => n + 1);
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
            >
              <Icon name={shut ? "ChevronRight" : "ChevronDown"} size={fs(14)} color={c.foregroundMuted} />
              <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: fs(13), fontWeight: "600" }} numberOfLines={1}>
                {g.name}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: fs(11) }}>{g.items.length}</Text>
            </Pressable>
            {shut
              ? null
              : g.items.map((e) => {
                  const serverId = serverOf(e, index);
                  const known = !!serverId;
                  const opening = busy === e.path;
                  const alive = liveOf(e, serverId, live);
                  // 살아 있는 세션: Paseo 워크스페이스 목록과 같은 표시(10-07 — 돌고 있음 고리·답 기다림 느낌표·실패·안 본 끝남
                  // 초록 점·끝남 흐린 점, statusIndicator). 대화가 없으면 자리만(이름 줄이 흔들리지 않게)
                  const hostText = opening ? "여는 중…" : e.missing ? "폴더 없음" : !known ? `${e.host} · 연결 없음` : e.host;
                  // 왼쪽 칸은 폭이 좁아 기기 이름이 프로젝트 이름을 "…"로 자른다 → 기기 이름은 마우스를 올리면 뜨는 설명으로만,
                  // 상태(여는 중·폴더 없음·연결 없음)는 그대로 이름 옆에(10-06 리규형님 — 이름에 기기를 대개 적어 둠)
                  // 연결 안 된 기기(방화벽 등)는 글자 대신 이름을 주황(테마 경고 색)으로 — 왼쪽 칸이 좁아 "연결 없음"이 이름을
                  // 자르던 것(10-06 리규형님). 마우스를 올리면 "기기 · 연결 없음"
                  const sideText = sidebar ? (opening ? "여는 중…" : e.missing ? "폴더 없음" : null) : hostText;
                  const nameColor =
                    pinKey(e) === currentKey ? c.statusSuccess : e.missing ? c.foregroundMuted : !known ? c.statusWarning : c.foreground;
                  const key = pinKey(e);
                  const pinned = pins.has(key);
                  return (
                    <Pressable
                      key={`${g.name}|${e.host}|${e.path}`}
                      ref={(node: unknown) => {
                        setHoverTitle(node, !known && !e.missing ? `${e.host} · 연결 없음` : e.host);
                        // 마우스로 끌어 같은 묶음 안 순서를 바꾼다(10-06 고정 → 10-07 모든 묶음, PC·웹 — 폰은 순서 바꾸기 없음)
                        setDraggableRow(node, key, g.name, c.accent, onDrop);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${e.name} 열기${alive ? ` (열린 대화 ${alive.open}개${alive.running ? `, 돌고 있음 ${alive.running}개` : ""})` : ""}`}
                      disabled={!!busy || e.missing}
                      onPress={() => onOpen(e)}
                      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
                        { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: sidebar ? 4 : 6, paddingLeft: sidebar ? 14 : 18, paddingRight: 6, borderRadius: 6 },
                        (hovered || pressed) && { backgroundColor: c.surface2 },
                      ]}
                    >
                      {({ hovered }: { hovered?: boolean; pressed: boolean }) => (
                        <>
                          <StatusIndicator bucket={alive?.bucket ?? null} theme={theme} />
                          <Text style={{ flexShrink: 1, color: nameColor, fontSize: fs(12) }} numberOfLines={1}>
                            {e.name}
                          </Text>
                          {alive && alive.open > 1 ? <Text style={{ flexShrink: 0, color: c.foregroundMuted, fontSize: fs(10) }}>{alive.open}</Text> : null}
                          {sideText ? (
                            <Text style={{ flexShrink: 0, marginLeft: 4, color: c.foregroundMuted, fontSize: fs(11) }} numberOfLines={1}>
                              {sideText}
                            </Text>
                          ) : null}
                          <View style={{ flex: 1 }} />
                          {/* 맨 위 고정 핀(10-06 리규형님): 고정된 것은 항상, 나머지는 마우스를 올릴 때만(폰은 마우스가 없어 항상).
                              자리는 늘 잡아 둬서 나타날 때 이름 줄이 흔들리지 않는다. 활성 묶음 줄에는 핀이 없다 — 고정은 원래 묶음에서,
                              풀기는 고정 묶음에서(10-07 리규형님 "활성에서만 고정 해제 버튼 제거") */}
                          {g.name === ACTIVE_GROUP ? null : (
                            <Pressable
                              accessibilityRole="button"
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
    </View>
  );
}

