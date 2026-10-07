import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { ProjectEntry } from "../shared/projects";
import { openProjectOn, openProjectsFile, serverOf, useHostIndex, useLiveSessions, useProjectsData } from "./projectsData";
import { ProjectsList } from "./projectsList";
import { goBack } from "./web";

// 프로젝트 화면 — VS Code 프로젝트 매니저 묶음 화면(리규형님 10-05 결정: Paseo 기본 목록 등록 + 이 묶음 화면 둘 다).
// 10-06부터 목록은 왼쪽 목록 칸 맨 위에도 있다(projectsSidebar). 칸에는 대화로 가는 기능이 없어서, 칸에서 누르면 이 화면이
// params(openPath·serverId·n)를 받아 그 프로젝트의 최근 대화로 넘긴다.

export const PROJECTS_SCREEN_ID = "projects";

export function ProjectsScreen({ theme, navigation, layout, params }: PluginScreenProps) {
  const { data, load } = useProjectsData();
  const index = useHostIndex(data?.entries ?? []);
  const live = useLiveSessions();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

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
  const routeReq =
    params?.serverId && (params.openPath || params.editList) ? `${params.serverId}|${params.openPath ?? ""}|${params.editList ?? ""}|${params.n ?? ""}` : null;
  const [routeDone, setRouteDone] = useState<string | null>(null);
  const routing = routeReq !== null && routeDone !== routeReq;
  useEffect(() => {
    if (!routeReq || handled.current === routeReq) return;
    handled.current = routeReq;
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
    void openOn(params.serverId, params.openPath).finally(() => setRouteDone(routeReq));
  }, [routeReq]);

  const open = (e: ProjectEntry) => {
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
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad }}>
      <ProjectsList
        theme={theme}
        variant="screen"
        data={data}
        index={index}
        live={live}
        busy={busy}
        notice={notice}
        onOpen={open}
        onEditList={openProjectsFile}
        onReload={() => void load()}
      />
    </ScrollView>
  );
}
