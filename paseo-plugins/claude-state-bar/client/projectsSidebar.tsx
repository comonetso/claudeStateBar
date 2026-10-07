import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { ProjectEntry } from "../shared/projects";
import { scaled, useFontScale } from "./fontScale";
import { liveOf, openProjectsFile, serverOf, useHostIndex, useLiveSessions, useProjectsData } from "./projectsData";
import { ProjectsList } from "./projectsList";
import { setProjectsMode, useProjectsMode } from "./projectsMode";
import { PROJECTS_SCREEN_ID } from "./projectsScreen";
import { clearSyncNotice, useSyncNotice } from "./settingsSync";
import { measureRoomAbove } from "./web";

// 왼쪽 목록 칸 맨 위(리규형님 10-06 결정): 프로젝트 목록을 바로 보이고, 보이는 동안 아래 워크스페이스 목록은 가린다(웹·데스크톱).
// 칸 높이는 아래쪽 줄(사용량)까지 남은 높이로 맞춘다. 칸에는 대화로 바로 가는 기능이 주어지지 않아서(플러그인 도구에서
// 전체 화면에만 있음) 누르면 프로젝트 화면에 "이 프로젝트 열기"를 넘기고, 화면이 최근 대화로 넘어간다.

const ROOT_ID = "claude-state-bar-projects-pane";
const FOOTER_TEST_ID = "sidebar-footer"; // Paseo 왼쪽 목록 아래쪽 줄(앱 0.11.0-beta.4)

/** 남은 높이를 1초마다 다시 잰다 — 창 크기·위쪽 메뉴 줄이 바뀌어도 따라가게. 웹이 아니면 null */
function useRoom(enabled: boolean): number | null {
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || Platform.OS !== "web") return;
    const read = () => {
      const next = measureRoomAbove(ROOT_ID, FOOTER_TEST_ID);
      setRoom((prev) => (prev === next ? prev : next));
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return room;
}

/** 설정 맞추기 알림(10-07)을 토스트로 한 번 띄운다 — 이 PC 플러그인이 늘 붙여 두는 이 칸이 맡는다 */
function useSyncNoticeToast(): void {
  const toast = useToast();
  const notice = useSyncNotice();
  useEffect(() => {
    if (!notice) return;
    toast.show(notice.text, { variant: notice.warn ? "warning" : "info" });
    clearSyncNotice();
  }, [notice, toast]);
}

export function ProjectsSidebarItem({ theme, openScreen }: PluginSidebarItemProps) {
  const mode = useProjectsMode();
  useSyncNoticeToast();
  if (mode === "workspaces") {
    return <SidebarRow icon="FolderTree" label="프로젝트" active={false} onPress={() => setProjectsMode("projects")} />;
  }
  return <ProjectsPane theme={theme} openScreen={openScreen} />;
}

function ProjectsPane({ theme, openScreen }: Pick<PluginSidebarItemProps, "theme" | "openScreen">) {
  const { data, load } = useProjectsData();
  const index = useHostIndex(data?.entries ?? []);
  const live = useLiveSessions();
  const [notice, setNotice] = useState<string | null>(null);
  const room = useRoom(true);
  const { height: windowHeight } = useWindowDimensions();
  const scale = useFontScale();
  const c = theme.colors;

  const open = (e: ProjectEntry) => {
    const serverId = serverOf(e, index);
    if (!serverId) {
      setNotice(`${e.host === "PC" ? "이 PC" : e.host} 에 연결된 Paseo 가 없어 열 수 없습니다`);
      return;
    }
    setNotice(null);
    // n: 같은 프로젝트를 다시 눌러도 화면이 새 요청으로 알아보게.
    // agentId: 30초마다 읽어 두는 목록의 가장 최근 대화 — 있으면 화면이 데몬에 묻지 않고 바로 연다(10-06 리규형님 결정,
    // 서버 프로젝트가 1~2초 걸리던 것). 그 뒤 새로 생긴 대화는 다음 읽기 전까지 모른다
    const latest = liveOf(e, serverId, live)?.latest;
    openScreen({ screenId: PROJECTS_SCREEN_ID, params: { openPath: e.path, serverId, n: String(Date.now()), ...(latest ? { agentId: latest.agentId } : {}) } });
  };

  // 목록 JSON은 중간 플러그인 화면 없이 Paseo 편집기 탭으로 바로 간다.
  const editList = openProjectsFile;

  const toWorkspaces = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="워크스페이스 목록 보기 (Ctrl+Alt+Shift+B)"
      onPress={() => setProjectsMode("workspaces")}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 5, borderRadius: 6, backgroundColor: c.surface2 }}
    >
      <Icon name="PanelLeft" size={scaled(14, scale)} color={c.foreground} />
      <Text style={{ color: c.foreground, fontSize: scaled(12, scale) }} numberOfLines={1}>
        워크스페이스
      </Text>
    </Pressable>
  );

  // 웹은 잰 높이로 채우고, 휴대폰은 서랍 안에서 워크스페이스 목록과 나눠 쓰도록 창 높이의 절반까지만(폰 시험 때 조정)
  const height = room ?? undefined;
  const maxHeight = Platform.OS === "web" ? undefined : Math.floor(windowHeight / 2);
  return (
    <View nativeID={ROOT_ID} style={{ height, maxHeight, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 4 }}>
      <ScrollView style={height ? { flex: 1 } : { flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 8 }}>
        <ProjectsList
          theme={theme}
          variant="sidebar"
          data={data}
          index={index}
          live={live}
          busy={null}
          notice={notice}
          onOpen={open}
          onEditList={editList}
          onReload={() => void load()}
          toolbarStart={toWorkspaces}
        />
      </ScrollView>
    </View>
  );
}
