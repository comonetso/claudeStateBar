import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import type { ProjectEntry } from "../shared/projects";
import { fontStep, scaled, useFontScale } from "./fontScale";
import { liveOf, pinKey, serverOf, usePins, type HostIndex, type Live, type ProjectsData } from "./projectsData";
import { setDraggableRow, setHoverTitle } from "./web";

// 프로젝트 목록 — VS Code 프로젝트 매니저처럼 태그 묶음을 접고 편다(리규형님 10-05 결정: 꺼 둔 것은 "꺼 둠" 묶음).
// 전체 화면과 왼쪽 목록 칸이 같이 쓴다. 칸(sidebar)은 폭이 좁아 도구 단추를 검색창 아래 줄에 둔다.

const PINNED_GROUP = "고정";
const DISABLED_GROUP = "꺼 둠";
const UNTAGGED_GROUP = "태그 없음";
const byName = (a: string, b: string) => a.localeCompare(b, "ko", { numeric: true });

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
  onReload: () => void;
  /** 칸 위쪽 도구 줄 왼쪽에 끼울 것(워크스페이스 목록으로 넘기는 단추) */
  toolbarStart?: ReactNode;
  /** 검색창 오른쪽 "목록 파일 편집" 아이콘(10-06) — 없으면 아이콘을 안 그린다 */
  onEditList?: () => void;
}) {
  const { theme, variant, data, index, live, busy, notice, onOpen, onReload, toolbarStart, onEditList } = props;
  const [filter, setFilter] = useState("");
  const [, bump] = useState(0);
  const scale = useFontScale();
  const c = theme.colors;
  const entries = data?.entries ?? [];
  const sidebar = variant === "sidebar";

  const { pins, order: pinOrder, toggle: togglePin, reorder: reorderPins } = usePins();
  // 고정 줄을 끌어 놓은 자리로 — 놓은 줄의 위(after=false)·아래(after=true)
  const dropPin = (from: string, to: string, after: boolean) => {
    const next = pinOrder.filter((k) => k !== from);
    const at = next.indexOf(to);
    if (at < 0) return;
    next.splice(after ? at + 1 : at, 0, from);
    reorderPins(next);
  };
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, ProjectEntry[]>();
    for (const e of entries) {
      if (q && !e.name.toLowerCase().includes(q) && !e.path.toLowerCase().includes(q) && !e.tags.some((t) => t.toLowerCase().includes(q))) continue;
      // 고정한 것은 맨 위 "고정" 묶음으로 옮기고 원래 묶음에서는 뺀다(10-06 리규형님 결정)
      const names = pins.has(pinKey(e)) ? [PINNED_GROUP] : !e.enabled ? [DISABLED_GROUP] : e.tags.length ? e.tags : [UNTAGGED_GROUP];
      for (const g of names) map.set(g, [...(map.get(g) ?? []), e]);
    }
    const order = [...map.keys()].filter((g) => g !== PINNED_GROUP && g !== DISABLED_GROUP && g !== UNTAGGED_GROUP).sort(byName);
    if (map.has(PINNED_GROUP)) order.unshift(PINNED_GROUP);
    if (map.has(UNTAGGED_GROUP)) order.push(UNTAGGED_GROUP);
    if (map.has(DISABLED_GROUP)) order.push(DISABLED_GROUP);
    // 고정 묶음은 리규형님이 끌어 정한 순서(고정 목록 파일의 순서), 나머지는 이름순
    const rank = (e: ProjectEntry) => pinOrder.indexOf(pinKey(e));
    return order.map((g) => ({
      name: g,
      items: (map.get(g) ?? []).sort(g === PINNED_GROUP ? (a, b) => rank(a) - rank(b) : (a, b) => byName(a.name, b.name)),
    }));
  }, [entries, filter, pins, pinOrder]);

  // 글자는 기본보다 크게(10-05 "+3px"). 왼쪽 칸만 10-06 리규형님 "폰트 조금 줄이고"로 +1px
  const fs = (px: number) => scaled(px + (sidebar ? 1 : 3), scale);
  const btn = { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, backgroundColor: c.surface2 } as const;
  const search = (
    <TextInput
      value={filter}
      onChangeText={setFilter}
      placeholder="이름·경로·태그로 찾기"
      placeholderTextColor={c.foregroundMuted}
      style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: fs(13), paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}
    />
  );
  const editList = onEditList ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="목록 파일 편집"
      ref={(node: unknown) => setHoverTitle(node, data?.source ? `목록 파일 편집: ${data.source}` : "목록 파일 편집")}
      onPress={onEditList}
      style={btn}
    >
      <Icon name="FileJson" size={fs(13)} color={c.foreground} />
    </Pressable>
  ) : null;
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

  return (
    <View style={{ gap: sidebar ? 6 : 10 }}>
      {sidebar ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {toolbarStart}
            <View style={{ flex: 1 }} />
            {tools}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {search}
            {editList}
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {search}
          {editList}
          {tools}
        </View>
      )}
      {notice ? <Text style={{ color: c.statusWarning, fontSize: fs(12) }}>{notice}</Text> : null}
      {data?.error ? <Text style={{ color: c.statusDanger, fontSize: fs(12) }}>{data.error}</Text> : null}
      {data && !data.source ? <Text style={{ color: c.foregroundMuted, fontSize: fs(12) }}>VS Code 프로젝트 매니저 목록 파일을 찾지 못했습니다.</Text> : null}
      {groups.map((g) => {
        const shut = collapsed.has(g.name) && !filter.trim();
        return (
          <View key={g.name} style={{ gap: 2 }}>
            <Pressable
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
              <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: fs(12), fontWeight: "600" }} numberOfLines={1}>
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
                  // 살아 있는 세션: 돌고 있으면 초록 점, 열려만 있으면 흐린 점, 없으면 자리만(이름 줄이 흔들리지 않게)
                  const dot = alive ? (alive.running ? c.statusSuccess : c.foregroundMuted) : "transparent";
                  const hostText = opening ? "여는 중…" : e.missing ? "폴더 없음" : !known ? `${e.host} · 연결 없음` : e.host;
                  // 왼쪽 칸은 폭이 좁아 기기 이름이 프로젝트 이름을 "…"로 자른다 → 기기 이름은 마우스를 올리면 뜨는 설명으로만,
                  // 상태(여는 중·폴더 없음·연결 없음)는 그대로 이름 옆에(10-06 리규형님 — 이름에 기기를 대개 적어 둠)
                  // 연결 안 된 기기(방화벽 등)는 글자 대신 이름을 주황(테마 경고 색)으로 — 왼쪽 칸이 좁아 "연결 없음"이 이름을
                  // 자르던 것(10-06 리규형님). 마우스를 올리면 "기기 · 연결 없음"
                  const sideText = sidebar ? (opening ? "여는 중…" : e.missing ? "폴더 없음" : null) : hostText;
                  const nameColor = e.missing ? c.foregroundMuted : !known ? c.statusWarning : c.foreground;
                  const key = pinKey(e);
                  const pinned = pins.has(key);
                  return (
                    <Pressable
                      key={`${g.name}|${e.host}|${e.path}`}
                      ref={(node: unknown) => {
                        setHoverTitle(node, !known && !e.missing ? `${e.host} · 연결 없음` : e.host);
                        // 고정 묶음 줄만 마우스로 끌어 순서를 바꾼다(10-06, PC·웹 — 폰은 순서 바꾸기 없음)
                        if (g.name === PINNED_GROUP) setDraggableRow(node, key, c.accent, dropPin);
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
                          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />
                          <Text style={{ flexShrink: 1, color: nameColor, fontSize: fs(13) }} numberOfLines={1}>
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
                              자리는 늘 잡아 둬서 나타날 때 이름 줄이 흔들리지 않는다 */}
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
                        </>
                      )}
                    </Pressable>
                  );
                })}
          </View>
        );
      })}
      {data?.source && !sidebar ? <Text style={{ color: c.foregroundMuted, fontSize: fs(11), marginTop: 8 }}>목록 파일: {data.source} (VS Code 프로젝트 매니저와 같은 파일)</Text> : null}
    </View>
  );
}

