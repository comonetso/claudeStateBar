import { isOfflineFallback } from "./uiRole";
import { OFFLINE_NOTICE, PC_OFFLINE_NOTICE } from "../shared/offlineProjects";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ProjectEntry } from "../shared/projects";
import { scaled, useFontScale } from "./fontScale";
import { openProjectOn, openProjectsFile, serverOf, useHostIndex, useLiveSessions, useProjectsData } from "./projectsData";
import { ProjectsList } from "./projectsList";
import { ProjectsManage } from "./projectsManage";
import { TeamManage } from "./team/teamManage";
import { setNoTranslate } from "./web";
import { isTeamMember } from "./team/teamMode";

// 화면 안 탭(10-11 리규형님: 목록 → 관리로 가면 돌아올 길이 없었다 — 탭으로 토글). 같은 날 오후 리규형님: 프로젝트 목록 탭은
// 왼쪽 목록과 같아 필요 없다 → 빼고, 그 탭의 "목록 파일 직접 편집"은 "프로젝트 파일 수정"으로 프로젝트 관리 탭 맨 위 오른쪽에.
// 직원 화면은 프로젝트 목록 탭 하나만 보던 화면이라 거기는 그대로 둔다
type Tab = "list" | "manage" | "team";
const ADMIN_TABS: { id: Tab; label: string }[] = [
  { id: "manage", label: "프로젝트 관리" },
  { id: "team", label: "팀원 관리" },
];
const MEMBER_TABS: { id: Tab; label: string }[] = [{ id: "list", label: "프로젝트 목록" }];

// 프로젝트 화면 — VS Code 프로젝트 매니저 묶음 화면(리규형님 10-05 결정: Paseo 기본 목록 등록 + 이 묶음 화면 둘 다).
// 10-06부터 목록은 왼쪽 목록 칸 맨 위에도 있다(projectsSidebar). 칸에는 대화로 가는 기능이 없어서, 칸에서 누르면 이 화면이
// params(openPath·serverId·n)를 받아 그 프로젝트의 최근 대화로 넘긴다.

export const PROJECTS_SCREEN_ID = "projects";

export function ProjectsScreen({ theme, navigation, layout, params }: PluginScreenProps) {
  const { data, load } = useProjectsData();
  const readOnly = data?.readOnly === true || isOfflineFallback();
  const index = useHostIndex(data?.entries ?? []);
  const live = useLiveSessions();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  // 탭(10-11) — 왼쪽 칸의 프로젝트 관리 단추는 params.manage 로 "프로젝트 관리" 탭을 연다
  const [tab, setTab] = useState<Tab>("manage");
  useEffect(() => {
    if (params?.manage && !isTeamMember()) setTab("manage");
  }, [params?.manage]);
  const scale = useFontScale();

  const openOn = async (serverId: string, path: string) => {
    if (!navigation) {
      setNotice("이 앱 판에서는 화면에서 작업 공간을 열 수 없습니다");
      return;
    }
    setBusy(path);
    setNotice(null);
    try {
      await openProjectOn(serverId, path, navigation);
    } catch (err) {
      setNotice(`열지 못했습니다: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setBusy(null);
    }
  };

  // 왼쪽 목록 칸에서 넘어온 "이 프로젝트 열기" — 같은 요청(n)은 한 번만.
  // 칸이 미리 골라 둔 대화(agentId)가 있으면 데몬에 묻지 않고 바로 연다(10-06 리규형님 결정 — 서버 프로젝트 1~2초).
  // 처리하는 동안은 목록 대신 "여는 중"만 보인다(목록이 잠깐 비쳤다 넘어가던 것, 10-06 리규형님)
  // 예전 목록 파일 열기 주소(editList)도 처리하지만, 새 사이드바 동작은 이 중간 화면을 거치지 않는다.
  // 폰 알림을 누르면(10-15 pushShell.ts) 경로 없이 대화 번호(agentId)만 온다
  const routeReq =
    params?.serverId && (params.openPath || params.editList || params.agentId)
      ? `${params.serverId}|${params.openPath ?? ""}|${params.editList ?? ""}|${params.agentId ?? ""}|${params.n ?? ""}`
      : null;
  const [routeDone, setRouteDone] = useState<string | null>(null);
  const routing = routeReq !== null && routeDone !== routeReq;
  useEffect(() => {
    if (!routeReq || handled.current === routeReq) return;
    handled.current = routeReq;
    if (readOnly && (params.projectHost === "PC" || params.editList)) {
      setNotice(params.editList ? OFFLINE_NOTICE : PC_OFFLINE_NOTICE); setRouteDone(routeReq); return;
    }
    if (params.editList) {
      void openProjectsFile(params.serverId, params.editList)
        .then((problem) => problem && setNotice(problem))
        .finally(() => setRouteDone(routeReq));
      return;
    }
    if (params.agentId && navigation) {
      navigation.openAgent({ agentId: params.agentId, serverId: params.serverId });
      setRouteDone(routeReq);
      return;
    }
    if (!params.openPath) {
      setNotice("이 앱 판에서는 화면에서 대화를 열 수 없습니다");
      setRouteDone(routeReq);
      return;
    }
    void openOn(params.serverId, params.openPath).finally(() => setRouteDone(routeReq));
  }, [routeReq]);

  const open = (e: ProjectEntry) => {
    if (readOnly && e.host === "PC") { setNotice(PC_OFFLINE_NOTICE); return; }
    const serverId = serverOf(e, index);
    if (!serverId) {
      setNotice(`${e.host === "PC" ? "이 PC" : e.host} 에 연결된 Paseo 가 없어 열 수 없습니다`);
      return;
    }
    void openOn(serverId, e.path);
  };

  const pad = layout.compact ? 12 : 20;
  if (routing) {
    return (
      <View style={{ flex: 1, padding: pad, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>여는 중…</Text>
      </View>
    );
  }
  const c = theme.colors;
  const fs = (px: number) => scaled(px + 3, scale);
  const editFile = () => openProjectsFile(index.byAlias.get("PC"), data?.source ?? null);
  // 직원 화면(10-11 리규형님)은 프로젝트 목록 탭만 — 프로젝트 관리·팀원 관리는 관리자 것
  const tabs = isTeamMember() ? MEMBER_TABS : readOnly ? ADMIN_TABS.filter(t => t.id === "manage") : ADMIN_TABS;
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const tabBar = (
    <View ref={setNoTranslate} style={{ flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap", gap: 2, marginBottom: 14, borderBottomWidth: 1, borderColor: c.border }}>
      {tabs.map((t) => {
        const on = current === t.id;
        return (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => setTab(t.id)}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({
              paddingHorizontal: 14,
              paddingVertical: 8,
              marginBottom: -1,
              borderBottomWidth: 2,
              borderColor: on ? c.accent : "transparent",
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
              backgroundColor: hovered && !on ? c.surface2 : "transparent",
            })}
          >
            <Text style={{ fontSize: fs(13), fontWeight: on ? "600" : "400", color: on ? c.foreground : c.foregroundMuted }}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: pad }}>
      {tabBar}
      {/* 왼쪽 목록에서 열다 못 연 이유 — 목록 탭이 없는 관리자 화면은 여기에(목록 탭은 목록 안에 보인다) */}
      {notice && current !== "list" ? <Text style={{ color: c.statusWarning, fontSize: fs(12), marginBottom: 10 }}>{notice}</Text> : null}
      {current === "list" ? (
        <ProjectsList theme={theme} variant="screen" data={data} index={index} live={live} busy={busy} notice={notice} onOpen={open} onReload={() => void load()} />
      ) : current === "manage" ? (
        <ProjectsManage
          theme={theme}
          data={data}
          index={index}
          live={live}
          readOnly={readOnly}
          onChanged={() => void load()}
          onEditFile={editFile}
          fileTitle={data?.source ? `프로젝트 목록 파일을 편집기로 엽니다: ${data.source}` : "프로젝트 목록 파일을 편집기로 엽니다"}
        />
      ) : (
        <TeamManage theme={theme} data={data} index={index} />
      )}
    </ScrollView>
  );
}
