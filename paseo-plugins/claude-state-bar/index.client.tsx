import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createActivityButtons } from "./client/activityButton";
import { ACTIVITY_PANEL_ID } from "./client/activityKinds";
import { ActivityPanel } from "./client/activityShell";
import { createChimeWatcher } from "./client/chime";
import { createContextPills } from "./client/contextPill";
import { createJudge } from "./client/judge";
import { PROJECTS_SCREEN_ID, ProjectsScreen, ProjectsSidebarRow } from "./client/projectsScreen";
import { createSettingsScreen } from "./client/settingsScreen";
import { UsageFooter } from "./client/usageFooter";
import { currentSettings, registerProvider, soundProvider } from "./client/sounds";
import { playSoundUrl, readAppFontSizes } from "./client/web";
import { clientLog } from "./shared/log";
import { DEFAULT_SETTINGS, settingsSchema, soundSettings, type SoundSettings } from "./shared/settings";
import { hostInfo, soundData, type SoundKind } from "./shared/sound";

const TAG = "[claude-state-bar]";

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let release: (() => void) | undefined;
  const cleanups: (() => void)[] = [];

  const log = (message: string) => {
    console.warn(`${TAG} ${message}`);
    void client.rpc(clientLog, { message }).catch(() => {});
  };

  const play = async (kind: SoundKind, agentId: string) => {
    const provider = soundProvider();
    if (!provider) {
      log(`${kind} ${agentId}: no host can play sounds`);
      return;
    }
    try {
      const played = await playSoundUrl(await provider.sound(kind));
      log(`${kind} ${agentId}: ${played ? "played" : "skipped (not web)"}`);
    } catch (error) {
      log(`${kind} ${agentId}: play failed: ${String(error)}`);
    }
  };

  // 작업 공간 옆 "작업 현황" 패널 하나(안에 탭 넷: 워크플로우 · 백그라운드 · Codex 진행 · Codex 채팅). 호스트마다 자기 데몬이
  // 그 폴더의 기록을 읽는다. 10-05 리규형님: 패널 넷이 따로라 불편 → 확장처럼 한 패널 안 탭으로
  cleanups.push(
    client.addWorkspacePanel({ id: ACTIVITY_PANEL_ID, title: "작업 현황", icon: "Activity", context: "workspace", Component: ActivityPanel }),
  );

  // 작업 공간 머리줄 "작업 현황" 단추: 돌고 있는 것 수(확장 탭 숫자), 누르면 종류별 수와 탭 열기
  cleanups.push(createActivityButtons(client, log));

  const judge = createJudge((kind, agentId) => void play(kind, agentId), log, currentSettings);

  // 따르릉: 워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행이 끝났는지는 데몬이 기록으로 판정한다
  const sessionToAgent = new Map<string, string>();
  const chimeWatcher = createChimeWatcher(
    client,
    (sessionId, count) => {
      const agentId = sessionToAgent.get(sessionId) ?? sessionId;
      if (!currentSettings().workflowBeep) {
        log(`workflow ${agentId}: ${count} finished, sound off in settings`);
        return;
      }
      void play("workflow", agentId);
    },
    log,
  );
  const watchChimes = (agent: { id: string; provider: string; cwd: string; persistence?: { sessionId?: string | null } | null }) => {
    const sessionId = agent.persistence?.sessionId;
    if (agent.provider !== "claude" || !sessionId) return;
    sessionToAgent.set(sessionId, agent.id);
    chimeWatcher.poke(sessionId, agent.cwd);
  };

  // 이 호스트가 소리를 낼 수 있으면(윈도우·맥 데몬) 공급자로 등록하고 설정 화면을 붙인다
  void (async () => {
    try {
      const info = await client.rpc(hostInfo, {});
      if (disposed) return;
      if (!info.canPlay) {
        log(`host ${info.platform}: sounds come from the providing host`);
        return;
      }
      let settings: SoundSettings = DEFAULT_SETTINGS;
      const read = settingsRpc(soundSettings.id).read;
      const refreshSettings = async () => {
        try {
          const result = await client.rpc(read, {});
          settings = result.status === "ready" ? settingsSchema.parse(result.values) : DEFAULT_SETTINGS;
        } catch (error) {
          log(`settings read failed: ${String(error)}`);
        }
      };
      await refreshSettings();
      if (disposed) return;
      const withdraw = registerProvider({
        hostLabel: info.platform,
        sound: async (kind) => (await client.rpc(soundData, { kind })).dataUrl,
        settings: () => settings,
        refreshSettings,
      });
      if (!withdraw) {
        log("another host already provides sounds");
        return;
      }
      cleanups.push(withdraw);
      cleanups.push(
        client.addSettingsScreen({
          id: "sounds",
          title: "Claude 상태 소리",
          icon: "Volume2",
          Component: createSettingsScreen(() => void refreshSettings()),
        }),
        // 왼쪽 목록 칸 맨 아래 사용량 — 호스트가 여럿이어도 한 줄만 보이게 소리 담당 호스트(이 PC)만 붙인다
        client.addSidebarFooterItem({ id: "usage", title: "Claude·Codex 사용량", Component: UsageFooter }),
        // 프로젝트 매니저 묶음 화면 — 목록 파일이 있는 이 PC 데몬이 읽으므로 역시 이 PC 플러그인만 붙인다
        client.addScreen({ id: PROJECTS_SCREEN_ID, title: "프로젝트", Component: ProjectsScreen }),
        client.addSidebarHeaderItem({ id: "projects", title: "프로젝트", Component: ProjectsSidebarRow }),
      );
      log(`providing sounds (${info.platform})`);
      const fonts = readAppFontSizes();
      log(`app font sizes: ui=${fonts.ui ?? "unread"} content=${fonts.content ?? "unread"}`);
    } catch (error) {
      log(`host info failed: ${String(error)}`);
    }
  })();

  // 대화마다 입력창 위 "컨텍스트 N%" 알약
  const pills = createContextPills(client, log);

  void (async () => {
    try {
      const list = await client.paseo.agents.list({ subscribe: {} });
      if (disposed) {
        void list.subscription.release();
        return;
      }
      for (const entry of list.entries) {
        judge.observe(entry.agent, true);
        watchChimes(entry.agent);
        pills.observe(entry.agent);
      }
      const stop = client.paseo.agents.subscribe((update) => {
        if (update.kind === "remove") return pills.remove(update.agentId);
        if (update.kind !== "upsert") return;
        judge.observe(update.agent, false);
        watchChimes(update.agent);
        pills.observe(update.agent);
      });
      // 재연결 때 오는 새 목록은 기준으로만 다시 잡는다(끊긴 사이 바뀐 것으로 소리를 내지 않는다 — Codex 검토 10-05:
      // 첫 목록과 그 뒤 변경만 들어 재연결 목록을 버리던 것)
      const stopSnapshots = list.subscription.subscribe({
        snapshot: (snap) => {
          for (const entry of snap.entries) {
            judge.observe(entry.agent, true);
            watchChimes(entry.agent);
            pills.observe(entry.agent);
          }
        },
        update: () => {},
      });
      release = () => {
        stop();
        stopSnapshots();
        void list.subscription.release();
      };
      log(`watching ${list.entries.length} agents`);
    } catch (error) {
      log(`subscribe failed: ${String(error)}`);
    }
  })();

  return () => {
    disposed = true;
    release?.();
    judge.dispose();
    chimeWatcher.dispose();
    pills.dispose();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
