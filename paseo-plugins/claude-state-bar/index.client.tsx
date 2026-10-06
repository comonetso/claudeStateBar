import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createActivityButtons } from "./client/activityButton";
import { ACTIVITY_PANEL_ID } from "./client/activityKinds";
import { ActivityPanel } from "./client/activityShell";
import { createChimeWatcher } from "./client/chime";
import { createContextPills } from "./client/contextPill";
import { createJudge } from "./client/judge";
import { startProjectsMode } from "./client/projectsMode";
import { PROJECTS_SCREEN_ID, ProjectsScreen } from "./client/projectsScreen";
import { ProjectsSidebarItem } from "./client/projectsSidebar";
import { createSelectionPills } from "./client/selectionRead";
import { createComposerMarkdown } from "./client/composerMarkdown";
import { createSettingsScreen, SETTINGS_TITLE } from "./client/settingsScreen";
import { chainButtons, createSettingsButtons, SETTINGS_SCREEN_ID } from "./client/settingsButton";
import { startSettingsSync } from "./client/settingsSync";
import { createSyncButtons, startLayoutAutoPull, startLayoutSave } from "./client/layoutSync";
import { layoutLoad } from "./shared/layoutSync";
import { registerThinking } from "./client/thinking";
import { createUsageButtons } from "./client/usageButton";
import { UsageFooter } from "./client/usageFooter";
import { currentSettings, registerProvider, soundProvider } from "./client/sounds";
import { playSoundUrl, readAppFontSizes } from "./client/web";
import { lastTurnCheck } from "./shared/chime";
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

  // 작업 공간 머리줄 "작업 현황" 단추: 돌고 있는 것 수(확장 탭 숫자), 누르면 종류별 수와 탭 열기.
  // 그 왼쪽에 "사용량" 단추(10-06 — 지금 웹(안정판)에도 있는 머리줄 단추라 웹·폰에서도 사용량이 보인다)
  // 그 왼쪽 끝에 톱니(10-07 — 누르면 Paseo 설정 안 Claude State Bar 화면: 웹 로그인·소리)
  cleanups.push(createActivityButtons(client, log, chainButtons(createSyncButtons(client), createSettingsButtons(client), createUsageButtons(client))));

  // 생각 상자: 영어 → 한국어(끝난 문장부터) + 맨 아래로 따라가기(10-06). 호스트마다 그 호스트 대화의 생각을 그린다
  cleanups.push(registerThinking(client));

  // 끝남 소리 직전에 데몬에 묻는다 — 방금 차례가 슬래시 명령만으로 끝났으면(모델 답 없음) 울리지 않는다(리규형님 10-06 결정).
  // rcSync 가 Claude 를 다시 띄우며 보내는 /cost 와 직접 친 /cost·/context 등. 못 물으면 지금처럼 울린다
  const agentToSession = new Map<string, string>();
  const playJudged = async (kind: SoundKind, agentId: string) => {
    const sessionId = agentToSession.get(agentId);
    if (kind === "completion" && sessionId) {
      try {
        if ((await client.rpc(lastTurnCheck, { sessionId })).commandOnly) {
          log(`completion ${agentId}: skipped (command-only turn)`);
          return;
        }
      } catch (error) {
        log(`completion ${agentId}: last turn check failed: ${String(error)}`);
      }
    }
    await play(kind, agentId);
  };
  const judge = createJudge((kind, agentId) => void playJudged(kind, agentId), log, currentSettings);

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
    agentToSession.set(agent.id, sessionId);
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
      /** 읽었으면 true — 실패면 앞서 읽은 값(처음엔 기본값)을 그대로 쓴다 */
      const refreshSettings = async () => {
        try {
          const result = await client.rpc(read, {});
          settings = result.status === "ready" ? settingsSchema.parse(result.values) : DEFAULT_SETTINGS;
          return true;
        } catch (error) {
          log(`settings read failed: ${String(error)}`);
          return false;
        }
      };
      const settingsRead = await refreshSettings();
      if (disposed) return;
      const withdraw = registerProvider({
        hostLabel: info.platform,
        sound: async (kind) => (await client.rpc(soundData, { kind })).dataUrl,
        settings: () => settings,
        refreshSettings: async () => {
          await refreshSettings();
        },
        usage: () => client.paseo.providers.listUsage(),
        openSettings: () => client.openSettings(SETTINGS_SCREEN_ID),
        loadLayout: (slot) => client.rpc(layoutLoad, { slot }),
      });
      if (!withdraw) {
        log("another host already provides sounds");
        return;
      }
      cleanups.push(withdraw);
      cleanups.push(
        client.addSettingsScreen({
          id: SETTINGS_SCREEN_ID,
          title: SETTINGS_TITLE,
          icon: "Settings",
          Component: createSettingsScreen(() => void refreshSettings()),
        }),
        // 왼쪽 목록 칸 맨 아래 사용량 — 호스트가 여럿이어도 한 줄만 보이게 소리 담당 호스트(이 PC)만 붙인다
        client.addSidebarFooterItem({ id: "usage", title: "Claude·Codex 사용량", Component: UsageFooter }),
        // 프로젝트 매니저 묶음 화면 — 목록 파일이 있는 이 PC 데몬이 읽으므로 역시 이 PC 플러그인만 붙인다
        client.addScreen({ id: PROJECTS_SCREEN_ID, title: "프로젝트", Component: ProjectsScreen }),
        // 왼쪽 목록 칸 맨 위 프로젝트 목록 + 워크스페이스 목록 가리기 + Ctrl+Alt+Shift+B 전환(10-06). 호스트마다 플러그인이 따로
        // 올라오므로 단축키도 한 곳(이 PC)에서만 단다 — 여러 곳에서 달면 한 번 누를 때 여러 번 넘어가 제자리가 된다
        client.addSidebarHeaderItem({ id: "projects", title: "프로젝트", Component: ProjectsSidebarItem }),
        startProjectsMode(),
      );
      // PC 앱·웹·폰 웹 감싸기 앱의 Paseo 설정을 이 PC 데몬의 정본에 맞춘다(10-07). 정본이 하나여야 해서 역시 이 PC 플러그인만.
      // 왼쪽 칸 기여 뒤에 둬서, 그게 없는 옛 판 화면(공식 웹 0.10.3)에서는 시작하지 않는다
      cleanups.push(startSettingsSync(client, log));
      // PC 앱의 작업 공간 순서·화면 구성을 바뀔 때마다 이 PC 데몬에 맡긴다 — 웹·폰의 머리줄 동기화 단추가 가져간다(10-07)
      cleanups.push(startLayoutSave(client, log));
      // 웹·폰 화면은 열 때마다 PC 저장본을 가져온다(10-07). 설정을 못 읽었으면 꺼 둔 항목을 몰라 가져오지 않는다
      cleanups.push(startLayoutAutoPull(client, log, info, settingsRead ? () => settings : null));
      log(`providing sounds (${info.platform})`);
      const fonts = readAppFontSizes();
      log(`app font sizes: ui=${fonts.ui ?? "unread"} content=${fonts.content ?? "unread"}`);
    } catch (error) {
      log(`host info failed: ${String(error)}`);
    }
  })();

  // 대화마다 입력창 위 "컨텍스트 N%" 알약
  const pills = createContextPills(client, log);
  // 대화마다 입력창 위 "선택 읽기" 알약 — 화면에서 선택한 글을 소리로 읽는다(웹·데스크톱, 10-06)
  const selectionPills = createSelectionPills(client, log);
  // 대화마다 입력창 위 "목록" 알약 + 입력창 목록 이어쓰기·들여쓰기·내어쓰기 키(웹·데스크톱, 10-07)
  const listPills = createComposerMarkdown(client, log);

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
        selectionPills.observe(entry.agent);
        listPills.observe(entry.agent);
      }
      const stop = client.paseo.agents.subscribe((update) => {
        if (update.kind === "remove") {
          pills.remove(update.agentId);
          selectionPills.remove(update.agentId);
          listPills.remove(update.agentId);
          return;
        }
        if (update.kind !== "upsert") return;
        judge.observe(update.agent, false);
        watchChimes(update.agent);
        pills.observe(update.agent);
        selectionPills.observe(update.agent);
        listPills.observe(update.agent);
      });
      // 재연결 때 오는 새 목록은 기준으로만 다시 잡는다(끊긴 사이 바뀐 것으로 소리를 내지 않는다 — Codex 검토 10-05:
      // 첫 목록과 그 뒤 변경만 들어 재연결 목록을 버리던 것)
      const stopSnapshots = list.subscription.subscribe({
        snapshot: (snap) => {
          for (const entry of snap.entries) {
            judge.observe(entry.agent, true);
            watchChimes(entry.agent);
            pills.observe(entry.agent);
            selectionPills.observe(entry.agent);
            listPills.observe(entry.agent);
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
    selectionPills.dispose();
    listPills.dispose();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
