import {
  getPaseoClient,
  useHosts,
  useRpc,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { projectsManager, type ProjectEntry } from "../shared/projects";
import { fontStep, scaled, useFontScale } from "./fontScale";

// 프로젝트 화면 — VS Code 프로젝트 매니저처럼 태그 묶음을 접고 펴며 프로젝트를 고르면 그 호스트의 작업 공간을 연다
// (리규형님 10-05 결정: Paseo 기본 목록 등록 + 이 묶음 화면 둘 다, 꺼 둔 것은 "꺼 둠" 묶음).
// 호스트 짝짓기: 프로젝트 매니저는 Remote-SSH 별칭("Calladmin-Gabia")을, Paseo 는 서버 번호를 쓴다. 각 호스트의 Paseo
// 프로젝트 목록에서 같은 경로를 찾아 그 호스트로 열고, 거기서 "별칭 → 호스트"를 배워 목록에 없는 항목(꺼 둔 것)에도 쓴다.

export const PROJECTS_SCREEN_ID = "projects";
const DISABLED_GROUP = "꺼 둠";
const UNTAGGED_GROUP = "태그 없음";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const byName = (a: string, b: string) => a.localeCompare(b, "ko", { numeric: true });

// 접은 묶음은 화면을 닫았다 열어도 그대로(앱이 켜져 있는 동안). 꺼 둠은 처음부터 접혀 있다
const collapsed = new Set<string>([DISABLED_GROUP]);

type HostIndex = { byPath: Map<string, string>; byAlias: Map<string, string> };

function useHostIndex(entries: ProjectEntry[]): HostIndex {
  const hosts = useHosts();
  const online = useMemo(() => hosts.filter((h) => h.status === "online").map((h) => h.serverId).sort(), [hosts]);
  const [paths, setPaths] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = new Map<string, string>();
      for (const serverId of online) {
        try {
          const { projects } = await getPaseoClient(serverId).projects.list();
          for (const p of projects) next.set(norm(p.projectRootPath), serverId);
        } catch {
          /* 그 호스트는 건너뛴다 */
        }
      }
      if (alive) setPaths(next);
    })();
    return () => {
      alive = false;
    };
  }, [online.join(",")]);
  return useMemo(() => {
    const byAlias = new Map<string, string>();
    for (const e of entries) {
      const serverId = paths.get(norm(e.path));
      if (serverId && !byAlias.has(e.host)) byAlias.set(e.host, serverId);
    }
    return { byPath: paths, byAlias };
  }, [paths, entries]);
}

export function ProjectsScreen({ theme, navigation, layout }: PluginScreenProps) {
  const fetchProjects = useRpc(projectsManager);
  const [data, setData] = useState<{ source: string | null; entries: ProjectEntry[]; error?: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [, bump] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scale = useFontScale();
  const c = theme.colors;

  const load = useCallback(async () => {
    try {
      setData(await fetchProjects({}));
    } catch (e) {
      setData({ source: null, entries: [], error: String(e) });
    }
  }, [fetchProjects]);
  useEffect(() => {
    void load();
  }, [load]);

  const entries = data?.entries ?? [];
  const index = useHostIndex(entries);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, ProjectEntry[]>();
    for (const e of entries) {
      if (q && !e.name.toLowerCase().includes(q) && !e.path.toLowerCase().includes(q) && !e.tags.some((t) => t.toLowerCase().includes(q))) continue;
      const names = !e.enabled ? [DISABLED_GROUP] : e.tags.length ? e.tags : [UNTAGGED_GROUP];
      for (const g of names) map.set(g, [...(map.get(g) ?? []), e]);
    }
    const order = [...map.keys()].filter((g) => g !== DISABLED_GROUP && g !== UNTAGGED_GROUP).sort(byName);
    if (map.has(UNTAGGED_GROUP)) order.push(UNTAGGED_GROUP);
    if (map.has(DISABLED_GROUP)) order.push(DISABLED_GROUP);
    return order.map((g) => ({ name: g, items: (map.get(g) ?? []).sort((a, b) => byName(a.name, b.name)) }));
  }, [entries, filter]);

  const open = async (e: ProjectEntry) => {
    const serverId = index.byPath.get(norm(e.path)) ?? index.byAlias.get(e.host);
    if (!serverId) {
      setNotice(`${e.host === "PC" ? "이 PC" : e.host} 에 연결된 Paseo 가 없어 열 수 없습니다`);
      return;
    }
    if (!navigation) {
      setNotice("이 앱 판에서는 화면에서 작업 공간을 열 수 없습니다");
      return;
    }
    setBusy(e.path);
    setNotice(null);
    try {
      const api = getPaseoClient(serverId);
      const ws = await api.workspaces.open(e.path);
      // 누르면 바로 대화로(리규형님 10-05): 그 작업 공간의 가장 최근 대화를 연다. 대화가 하나도 없으면 작업 공간 첫 화면
      const { entries } = await api.agents.list({ sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 200 } });
      const agent = entries.map((x) => x.agent).find((a) => a.workspaceId === ws.id && !a.archivedAt);
      if (agent) navigation.openAgent({ agentId: agent.id, serverId });
      else navigation.openWorkspace({ workspaceId: ws.id, serverId });
    } catch (err) {
      setNotice(`열지 못했습니다: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setBusy(null);
    }
  };

  const fs = (px: number) => scaled(px + 3, scale);
  const pad = layout.compact ? 12 : 20;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: pad, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="이름·경로·태그로 찾기"
          placeholderTextColor={c.foregroundMuted}
          style={{ flex: 1, color: c.foreground, fontSize: fs(13), paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="목록 다시 읽기" onPress={() => void load()} style={{ padding: 7, borderRadius: 6, backgroundColor: c.surface2 }}>
          <Icon name="RefreshCw" size={fs(11)} color={c.foreground} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="글자 작게" onPress={() => fontStep(-1)} style={{ paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, backgroundColor: c.surface2 }}>
          <Text style={{ color: c.foreground, fontSize: fs(10) }}>A−</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="글자 크게" onPress={() => fontStep(1)} style={{ paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, backgroundColor: c.surface2 }}>
          <Text style={{ color: c.foreground, fontSize: fs(10) }}>A+</Text>
        </Pressable>
      </View>
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
              <Text style={{ color: c.foregroundMuted, fontSize: fs(12), fontWeight: "600" }}>{g.name}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: fs(11) }}>{g.items.length}</Text>
            </Pressable>
            {shut
              ? null
              : g.items.map((e) => {
                  const known = !!(index.byPath.get(norm(e.path)) ?? index.byAlias.get(e.host));
                  const opening = busy === e.path;
                  return (
                    <Pressable
                      key={`${g.name}|${e.host}|${e.path}`}
                      accessibilityRole="button"
                      accessibilityLabel={`${e.name} 열기`}
                      disabled={!!busy || e.missing}
                      onPress={() => void open(e)}
                      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
                        { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 26, paddingRight: 8, borderRadius: 6 },
                        (hovered || pressed) && { backgroundColor: c.surface2 },
                      ]}
                    >
                      <Text style={{ flexShrink: 1, color: e.missing || !known ? c.foregroundMuted : c.foreground, fontSize: fs(13) }} numberOfLines={1}>
                        {e.name}
                      </Text>
                      <Text style={{ flexShrink: 0, marginLeft: 6, color: c.foregroundMuted, fontSize: fs(11) }} numberOfLines={1}>
                        {opening ? "여는 중…" : e.missing ? "폴더 없음" : !known ? `${e.host} · 연결 없음` : e.host}
                      </Text>
                    </Pressable>
                  );
                })}
          </View>
        );
      })}
      {data?.source ? <Text style={{ color: c.foregroundMuted, fontSize: fs(11), marginTop: 8 }}>목록 파일: {data.source} (VS Code 프로젝트 매니저와 같은 파일)</Text> : null}
    </ScrollView>
  );
}

/** 왼쪽 목록 칸 위쪽 "프로젝트" 줄 — 누르면 위 화면을 연다 */
export function ProjectsSidebarRow({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="FolderTree"
      label="프로젝트"
      active={currentScreen?.screenId === PROJECTS_SCREEN_ID}
      onPress={() => openScreen({ screenId: PROJECTS_SCREEN_ID })}
    />
  );
}
