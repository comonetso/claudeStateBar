import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createActivityButtons } from "./client/activityButton";
import { ACTIVITY_PANEL_ID } from "./client/activityKinds";
import { ActivityPanel } from "./client/activityShell";
import { createChimeWatcher } from "./client/chime";
import { createContextPills } from "./client/contextPill";
import { createJudge } from "./client/judge";
import { createThinkingFoldPills } from "./client/thinkingFoldPill";
import { startHeaderTitles } from "./client/headerTitles";
import { startProjectsMode } from "./client/projectsMode";
import { PROJECTS_SCREEN_ID, ProjectsScreen } from "./client/projectsScreen";
import { ProjectsSidebarItem } from "./client/projectsSidebar";
import { createTurnReadButtons } from "./client/selectionRead";
import { createComposerMarkdown } from "./client/composerMarkdown";
import { createSettingsScreen, SETTINGS_TITLE } from "./client/settingsScreen";
import { chainButtons, createSettingsButtons, SETTINGS_SCREEN_ID } from "./client/settingsButton";
import { browserLabel, startScreenRole } from "./client/screenRole";
import { startSettingsSync } from "./client/settingsSync";
import { startLayoutAutoPull, startLayoutSave, syncMenuItem } from "./client/layoutSync";
import { startPaneMaxWatch } from "./client/paneMaxWatch";
import { layoutLoad } from "./shared/layoutSync";
import { registerThinking } from "./client/thinking";
import { hideSubagentsPill } from "./client/hideSubagentsPill";
import { createUsageButtons } from "./client/usageButton";
import { UsageFooter } from "./client/usageFooter";
import { currentSettings, emitSharedSignal, registerProvider, soundProvider } from "./client/sounds";
import { startSoundProjects, registerSoundOrigin, soundOrigin } from "./client/soundScreen";
import { reportSoundEvent, startSoundPlayback } from "./client/soundPlayback";
import type { RoutedSoundEvent } from "./shared/soundClaim";
import { readAppFontSizes } from "./client/web";
import { startDictationInsertOnly } from "./client/dictationInsertOnly";
import { soundOriginObserve, soundOriginPrepare } from "./shared/soundEvents";

import { clientLog } from "./shared/log";
import { DEFAULT_SETTINGS, settingsSchema, soundSettings, type SoundSettings } from "./shared/settings";
import { hostInfo, soundDataV2, type SoundKind } from "./shared/sound";
import { setTeamMember } from "./client/teamMode";

const TAG = "[claude-state-bar]";

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let release: (() => void) | undefined;
  const cleanups: (() => void)[] = [];

  const log = (message: string) => {
    console.warn(`${TAG} ${message}`);
    void client.rpc(clientLog, { message }).catch(() => {});
  };

  const report = async (kind: SoundKind, agentId: string, nativeId: string) => {
    try {
      const cfg = currentSettings();
      const { event } = await client.rpc(soundOriginPrepare, { kind, agentId, nativeId, warningPercent: cfg.warningPercent, dangerPercent: cfg.dangerPercent });
      if (disposed || !event || (kind !== "workflow" && !judge.isCurrent(kind, agentId, nativeId))) return;
      if (soundOrigin(event.originHostId) !== client) cleanups.push(registerSoundOrigin(event.originHostId, client));
      await reportSoundEvent(event as RoutedSoundEvent, log);
    } catch (error) { log(kind + " " + agentId + ": skipped (source identity failed): " + String(error)); }
  };

  // 작업 공간 옆 "작업 현황" 패널 하나(안에 탭 다섯: 워크플로우 · 백그라운드 · Codex 진행 · Codex 채팅 · 통계(10-08)). 호스트마다 자기 데몬이
  // 그 폴더의 기록을 읽는다. 10-05 리규형님: 패널 넷이 따로라 불편 → 확장처럼 한 패널 안 탭으로
  cleanups.push(
    client.addWorkspacePanel({ id: ACTIVITY_PANEL_ID, title: "작업 현황", icon: "Activity", context: "workspace", Component: ActivityPanel }),
  );

  // 작업 공간 머리줄 "작업 현황" 단추: 돌고 있는 것 수(확장 탭 숫자), 누르면 종류별 수와 탭 열기.
  // 그 왼쪽에 "사용량" 단추(10-06 — 지금 웹(안정판)에도 있는 머리줄 단추라 웹·폰에서도 사용량이 보인다)
  // 그 왼쪽 끝에 톱니(10-07 — 누르면 Paseo 설정 안 Claude State Bar 화면: 웹 로그인·소리). 웹·폰은 톱니가 메뉴가 되어
  // "PC 에서 가져오기"도 함께 든다 — Paseo 는 플러그인 단추를 셋까지만 머리줄에 내놓는다
  cleanups.push(createActivityButtons(client, log, chainButtons(createSettingsButtons(client, syncMenuItem()), createUsageButtons(client))));

  // 생각 상자: 영어 → 한국어(끝난 문장부터) + 맨 아래로 따라가기(10-06). 호스트마다 그 호스트 대화의 생각을 그린다
  cleanups.push(registerThinking(client));
  // Paseo "하위 에이전트 N개" 알약 숨기기(10-09 리규형님 — 워크플로우·백그라운드는 우리 작업 현황 패널에서 본다)
  cleanups.push(hideSubagentsPill());

  // 완료/질문 정착은 기존 화면 판정기로, 안정 번호·명령만인 차례는 발생 데몬 원본으로 확인한다.
  const judge = createJudge((kind, agentId, nativeId) => void report(kind, agentId, nativeId), log, currentSettings);
  const observeSound = (agent: Parameters<typeof judge.observe>[0], initial: boolean) => {
    const cfg = currentSettings();
    // 낮아진 사용량도 발생 정본에 관측시켜 다음 경고 세대를 화면 카운터로 만들지 않는다.
    void client.rpc(soundOriginObserve, { agentId: agent.id, warningPercent: cfg.warningPercent, dangerPercent: cfg.dangerPercent }).catch((e) => log("sound context sample skipped: " + String(e)));
    judge.observe(agent, initial);
  };

  // 따르릉: 워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행이 끝났는지는 데몬이 기록으로 판정한다
  const sessionToAgent = new Map<string, string>();
  const chimeWatcher = createChimeWatcher(
    client,
    (sessionId, events) => {
      const agentId = sessionToAgent.get(sessionId) ?? sessionId;
      if (!currentSettings().workflowBeep) {
        log(`workflow ${agentId}: ${events.length} finished, sound off in settings`);
        return;
      }
      for (const nativeId of events) void report("workflow", agentId, nativeId);
    },
    log,
  );
  const watchChimes = (agent: { id: string; provider: string; cwd: string; workspaceId?: string | null; persistence?: { sessionId?: string | null } | null }, initial = false) => {

    const sessionId = agent.persistence?.sessionId;
    if (agent.provider !== "claude" || !sessionId) return;
    sessionToAgent.set(sessionId, agent.id);

    chimeWatcher.poke(sessionId, agent.cwd, initial);
  };

  // 이 호스트가 소리를 낼 수 있으면(윈도우·맥 데몬) 공급자로 등록하고 설정 화면을 붙인다
  void (async () => {
    try {
      const info = await client.rpc(hostInfo, {});
      if (disposed) return;
      if (info.serverId) cleanups.push(registerSoundOrigin(info.serverId, client));
      // 직원용 Paseo(10-11)는 그 화면의 유일한 호스트라 PC 처럼 설정·사용량·프로젝트 목록을 붙인다(관리 탭은 projectsScreen 이 숨김)
      setTeamMember(info.team === true);
      if (!info.serverId || (info.team !== true && (!info.canPlay || info.platform !== "win32"))) {
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
          // 번역·읽기 켜기가 바뀌었을 수 있다 — 모든 호스트의 생각 상자·턴·말 읽기 단추가 다시 그려진다(10-08)
          emitSharedSignal("settings");
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
        soundRouter: { coordinatorId: info.serverId, rpc: client.rpc.bind(client) },
        sound: async (kind) => (await client.rpc(soundDataV2, { kind })).dataUrl,
        settings: () => settings,
        refreshSettings: async () => {
          await refreshSettings();
        },
        usage: () => client.paseo.providers.listUsage(),
        openSettings: () => client.openSettings(SETTINGS_SCREEN_ID),
        loadLayout: (slot) => client.rpc(layoutLoad, { slot }),
        claimSound: async () => false, // 같은 화면 안 옛 호스트 인스턴스도 무음으로 닫는다.
      });
      if (!withdraw) {
        log("another host already provides sounds");
        return;
      }
      // 공급자가 생기거나 물러나면 모든 호스트 화면이 그 설정(번역·읽기 켜기 등)으로 다시 그린다(10-08)
      emitSharedSignal("settings");
      cleanups.push(() => {
        withdraw();
        emitSharedSignal("settings");
      });
      const provider = soundProvider();
      if (provider) cleanups.push(startSoundProjects(client, log), startSoundPlayback(provider, log));
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
        client.addScreen({ id: PROJECTS_SCREEN_ID, title: "프로젝트 관리", Component: ProjectsScreen }),
        // 왼쪽 목록 칸 맨 위 프로젝트 목록 + 워크스페이스 목록 가리기 + Ctrl+Alt+Shift+B 전환(10-06). 호스트마다 플러그인이 따로
        // 올라오므로 단축키도 한 곳(이 PC)에서만 단다 — 여러 곳에서 달면 한 번 누를 때 여러 번 넘어가 제자리가 된다
        client.addSidebarHeaderItem({ id: "projects", title: "프로젝트", Component: ProjectsSidebarItem }),
        startProjectsMode(),
      );
      // PC 앱·웹·폰 웹 감싸기 앱의 Paseo 설정을 이 PC 데몬의 정본에 맞춘다(10-07). 정본이 하나여야 해서 역시 이 PC 플러그인만.
      // 왼쪽 칸 기여 뒤에 둬서, 그게 없는 옛 판 화면(공식 웹 0.10.3)에서는 시작하지 않는다
      // 기준 화면(10-08 대표 PC 웹) — 설정 맞추기·화면 구성 저장이 이 PC 데몬의 대표 정보를 본다. 그 둘보다 먼저 묻기 시작한다
      cleanups.push(startScreenRole(client, log));
      cleanups.push(startSettingsSync(client, log));
      // PC 앱의 작업 공간 순서·화면 구성을 바뀔 때마다 이 PC 데몬에 맡긴다 — 웹·폰이 열 때와 톱니 메뉴 "PC 에서 가져오기"로 가져간다(10-07)
      cleanups.push(startLayoutSave(client, log));
      // 웹·폰 화면은 열 때마다 PC 저장본을 가져온다(10-07). 설정을 못 읽었으면 꺼 둔 항목을 몰라 가져오지 않는다
      cleanups.push(startLayoutAutoPull(client, log, info, settingsRead ? () => settings : null));
      // 칸 최대화가 저절로 풀리는 원인 기록(10-09 "원인부터 기록") — 호스트마다 돌면 같은 줄이 여러 번 남아 이 PC 플러그인만
      cleanups.push(startPaneMaxWatch(log, browserLabel));
      // 받아쓰기는 늘 입력창에만 넣고 보내기는 직접(10-10) — 같은 화면 입력창 모듈 하나를 감싸므로 한 곳(이 PC 플러그인)만
      cleanups.push(startDictationInsertOnly(log));
      log(`providing sounds (${info.platform})`);
      const fonts = readAppFontSizes();
      log(`app font sizes: ui=${fonts.ui ?? "unread"} content=${fonts.content ?? "unread"}`);
    } catch (error) {
      log(`host info failed: ${String(error)}`);
    }
  })();

  // 위쪽 제목 "카테고리 - 이름"(10-08) — 기기마다 자기 기기 작업 공간 제목·프로젝트 이름을 이름표에 맞춘다
  cleanups.push(startHeaderTitles(client, log));

  // 대화마다 입력창 위 "컨텍스트 N%" 알약
  const pills = createContextPills(client, log);
  // 턴 복사 옆·진행 중 말 아래 읽기 단추(웹·데스크톱, 10-09)
  cleanups.push(createTurnReadButtons(client, log));
  // 대화마다 입력창 위 "목록" 알약 + 입력창 목록 이어쓰기·들여쓰기·내어쓰기 키(웹·데스크톱, 10-07)
  const listPills = createComposerMarkdown(client, log);
  // 대화마다 입력창 위 오른쪽 "생각 상자 모두 접기·펼치기" 알약(10-08)
  const foldPills = createThinkingFoldPills(client, log);

  void (async () => {
    try {
      const list = await client.paseo.agents.list({ subscribe: {} });
      if (disposed) {
        void list.subscription.release();
        return;
      }
      for (const entry of list.entries) {
        observeSound(entry.agent, true);
        watchChimes(entry.agent, true);
        pills.observe(entry.agent);
        listPills.observe(entry.agent);
        foldPills.observe(entry.agent);
      }
      const stop = client.paseo.agents.subscribe((update) => {
        if (update.kind === "remove") {
          judge.remove(update.agentId);
          for (const [sessionId, agentId] of sessionToAgent) if (agentId === update.agentId) { chimeWatcher.remove(sessionId); sessionToAgent.delete(sessionId); }
          pills.remove(update.agentId);
          listPills.remove(update.agentId);
          foldPills.remove(update.agentId);
          return;
        }
        if (update.kind !== "upsert") return;
        observeSound(update.agent, false);
        watchChimes(update.agent);
        pills.observe(update.agent);
        listPills.observe(update.agent);
        foldPills.observe(update.agent);
      });
      // 재연결 때 오는 새 목록은 기준으로만 다시 잡는다(끊긴 사이 바뀐 것으로 소리를 내지 않는다 — Codex 검토 10-05:
      // 첫 목록과 그 뒤 변경만 들어 재연결 목록을 버리던 것)
      const stopSnapshots = list.subscription.subscribe({
        snapshot: (snap) => {
          judge.dispose(); // 재연결 기준 목록 전에 소리 타이머/기억을 정리한다.
          const ids = new Set(snap.entries.map((e) => e.agent.id));
          for (const [sessionId, agentId] of sessionToAgent) if (!ids.has(agentId)) { chimeWatcher.remove(sessionId); sessionToAgent.delete(sessionId); }
          for (const entry of snap.entries) {
            observeSound(entry.agent, true);
            watchChimes(entry.agent, true);
            pills.observe(entry.agent);
            listPills.observe(entry.agent);
            foldPills.observe(entry.agent);
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
    listPills.dispose();
    foldPills.dispose();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
