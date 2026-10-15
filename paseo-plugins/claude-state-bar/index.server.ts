import { offlineProjectsStatus } from "./shared/offlineProjects";
import { assertProjectsWritable, copiedProjects, readOfflineCopy, startOfflineProjectsCopy, stopOfflineCopyWatch, usesOfflineCopy, waitOfflineCopy } from "./server/offlineProjects";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clearFinishedBg, countRunning, listActivity, readAgentActivity, readBgOutput } from "./server/activity/workflows";
import { checkSession, checkSessionV2, forgetClient } from "./server/chime/tracker";
import { lastTurnCommandOnly } from "./server/chime/lastTurn";
import { countLiveChats, listChats } from "./server/codex/chats";
import { isTerminal, listRuns, readDoc, runItems } from "./server/codex/runs";
import { emptyTrash, listTrash, purgeTrashed, restoreTrashed, trashRun } from "./server/codex/trash";
import { emptyChatTrash, listChatTrash, purgeChat, restoreChat, trashChat } from "./server/codex/chatTrash";
import { readUsage } from "./server/codex/usage";
import { cleanCheck, cleanStart, cleanWait } from "./server/codex/clean";
import { listProjects, waitProjectsChange } from "./server/projects";
import { startProjectLabels } from "./server/projectLabels";
import { applyHeaderTitle, waitHeaderTitles } from "./server/headerTitles";
import { headerTitleApply, headerTitlesWait } from "./shared/headerTitles";
import { claimSound, markScreenUsed, createSoundRouter } from "./server/soundClaim";
import { soundClaim, soundScreenUsed, soundPresence, soundReport, soundWait, soundTake, soundCancel, soundDropScreen, soundResult } from "./shared/soundClaim";
import { createSoundOrigins } from "./server/soundEvents";
import { soundOriginObserve, soundOriginPrepare, soundOriginValidate, soundOriginDrop } from "./shared/soundEvents";
import { translateTexts } from "./server/translate";
import { checkGoogleKeys, googleKeysState as readGoogleKeysState, saveGoogleKeys, speechKeysState as readSpeechKeysState, saveSpeechKeys, checkSpeechKeys } from "./server/googleCheck";
import { googleKeysCheck, googleKeysSave, googleKeysState } from "./shared/googleKeys";
import { synthesizeText, previewVoice } from "./server/tts";
import { readSpeechSettings, saveSpeechSettings } from "./server/speech";
import { speechGet, speechSave, speechPreview, speechKeysState, speechKeysSave, speechKeysCheck } from "./shared/speech";
import { readGoogleKeys } from "./server/googleKeys";
import { translateKo } from "./shared/translate";
import { googleStatus, ttsSynthesize } from "./shared/tts";
import { startSttServer } from "./server/sttServer";
import { startTeamKeySync } from "./server/teamKeySync";
import { readSttHints, saveSttHints } from "./server/sttHints";
import { sttHintsGet, sttHintsSave } from "./shared/stt";
import { canPlayHere, canCoordinateSound, isTeamDaemon, createSoundReader, LEGACY_SILENT_WAV, listSystemSounds, saveUploadedSound } from "./server/sound";
import { activityCounts, activityList, agentActivity, bgClear, bgOutput } from "./shared/activity";
import { chimeCheck, chimeCheckV2, chimeForget, lastTurnCheck } from "./shared/chime";
import {
  chatTrashEmpty,
  chatTrashList,
  chatTrashMove,
  chatTrashPurge,
  chatTrashRestore,
  codexChats,
  codexDoc,
  codexRunItems,
  codexRuns,
  codexTrashEmpty,
  codexTrashList,
  codexTrashPurge,
  codexTrashRestore,
  codexTrashRun,
  codexUsage,
} from "./shared/codex";
import { codexCleanCheck, codexCleanStart, codexCleanWait } from "./shared/codexClean";
import { clientLog } from "./shared/log";
import { thinkingBoundary } from "./shared/thinkingBoundary";
import { thinkingCut } from "./server/thinkingBoundary";
import { projectsEdit, projectsHosts, projectsManager, projectsWait, projectsOrder, projectsOrderSet, projectsPinOrder, projectsPinSet, projectsPins, projectsResetOrder } from "./shared/projects";
import { editProjects, projectHosts } from "./server/projectsEdit";
import { teamCategoryOrder, teamJobStart, teamJobWait, teamMemberRemove, teamMemberSave, teamProjectEdit, teamServerSkills, teamSkills, teamState } from "./shared/team";
import { startTeamJob, waitTeamJob } from "./server/teamApply";
import { editMemberProjects, removeMember, saveMember, setMemberCategoryOrder, teamStateRead } from "./server/team";
import { listGlobalSkills, listServerSkills } from "./server/teamSkills";
import { clearProjectOrders, projectOrders, setProjectOrder } from "./server/projectsOrder";
import { clearProjectPins, projectPins, setProjectPin, setProjectPinOrder } from "./server/projectsPins";
import { DEFAULT_SETTINGS, soundSettings } from "./shared/settings";
import { syncPut, syncWait } from "./shared/settingsSync";
import { layoutLoad, layoutOwnerGet, layoutOwnerSet, layoutSave } from "./shared/layoutSync";
import { putSettings, waitSettings } from "./server/settingsSync";
import { hostIdentity, layoutOwner, loadLayout, saveLayout, setLayoutOwner } from "./server/layoutSync";
import { hostInfo, soundData, soundDataV2, soundList, soundUpload } from "./shared/sound";
import { importExtSettings } from "./server/extSettings";
import { extSettingsImport } from "./shared/extSettings";
import { collectClaudeStats } from "./server/stats/claudeStats";
import { claudeStats } from "./shared/stats";
import { forgetAccount, providerFromDisk, stopAccounts, switchAccount, waitAccounts } from "./server/account";
import { accountSwitch, accountsWait } from "./shared/account";
import { cancelLogin, forgetLogin, onTurnEnded, startLogin, stopLogin, submitCode, waitLogin } from "./server/claudeLogin";
import { loginCancel, loginCode, loginStart, loginWait } from "./shared/claudeLogin";
import { teamUsageSources } from "./server/teamUsage";
import { createPush, registerPushToken } from "./server/push";
import { pushCompactWait, pushRegister } from "./shared/push";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(soundSettings);
  const readSettings = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : DEFAULT_SETTINGS;
  };

  // 팀 공급자 한도를 사용량 목록에 늘 올린다(10-15 — server/teamUsage). 이 기능이 없는 옛 데몬에선 건너뛴다
  if (typeof (server as { registerUsageSource?: unknown }).registerUsageSource === "function") {
    try {
      for (const source of teamUsageSources()) server.registerUsageSource(source);
    } catch (error) {
      console.log(`[team-usage] register failed: ${String(error)}`);
    }
  }

  const readSound = createSoundReader(readSettings);
  server.handle(soundDataV2, readSound);
  server.handle(soundList, async () => ({ files: await listSystemSounds() }));
  server.handle(soundUpload, ({ kind, name, base64 }) => saveUploadedSound(kind, name, base64));
  server.handle(soundData, async (input) => input.file !== undefined || input.gain !== undefined
    ? readSound(input) : { dataUrl: LEGACY_SILENT_WAV, path: "" });
  // team = 서버 울타리 안 직원 데몬(10-11, paseo-team@ 유닛이 TEAM_UID·PASEO_HOME=/team/paseo 를 준다)
  server.handle(hostInfo, async () => {
    const team = isTeamDaemon();
    // 직원용 Paseo 는 HOME=/home/<아이디> 로 돈다(서버 직원 도구 drop-in)
    return { platform: process.platform, canPlay: canPlayHere(), team, ...(team && process.env.HOME ? { home: process.env.HOME } : {}), ...(await hostIdentity()) };
  });
  server.handle(chimeCheck, async ({ clientId, sessionId, cwd }) => checkSession(clientId, sessionId, cwd));
  server.handle(chimeCheckV2, async ({ clientId, sessionId, cwd, baseline }) => checkSessionV2(clientId, sessionId, cwd, baseline));
  server.handle(lastTurnCheck, async ({ sessionId }) => ({ commandOnly: await lastTurnCommandOnly(sessionId) }));
  server.handle(chimeForget, async ({ clientId }) => {
    forgetClient(clientId);
    return { ok: true };
  });
  server.handle(codexRuns, async ({ cwd, limit }) => listRuns(cwd, limit));
  server.handle(codexRunItems, async ({ cwd, stamp }) => ({ items: await runItems(cwd, stamp) }));
  server.handle(codexChats, async ({ cwd }) => ({ chats: await listChats(cwd) }));
  server.handle(codexDoc, async ({ cwd, path }) => ({ text: await readDoc(cwd, path) }));
  server.handle(codexUsage, async ({ cwd }) => {
    const r = await readUsage(cwd);
    return r.state === "ok" ? { ok: true, computedAt: r.computedAt, items: r.items } : { ok: false };
  });
  // 용량 줄 옆 [정리](리규형님 10-08 "확장과 같게") — 이 기기의 codex_rescue 정리 스크립트를 띄우고, 출력은 기다림 요청으로 준다
  server.handle(codexCleanCheck, async ({ cwd }) => cleanCheck(cwd));
  server.handle(codexCleanStart, async ({ cwd, items, yes }) => cleanStart(cwd, items, yes));
  server.handle(codexCleanWait, async ({ jobId, seen }) => cleanWait(jobId, seen));
  // 휴지통: 넣을 때는 문서까지 통째로(확장 onDelete 와 같이 includeDocs=true)
  server.handle(codexTrashRun, async ({ cwd, stamp, slug, subject, mode }) => {
    const moved = await trashRun(cwd, stamp, slug, true, subject, mode, Date.now());
    console.log(`[codex-trash] ${moved ? "trashed" : "skipped"} ${stamp}`);
    return { moved };
  });
  server.handle(codexTrashList, async ({ cwd }) => ({ items: await listTrash(cwd) }));
  server.handle(codexTrashRestore, async ({ cwd, stamp }) => {
    const res = await restoreTrashed(cwd, stamp);
    console.log(`[codex-trash] restored ${stamp}: ${res.restored} file(s), ${res.conflicts.length} conflict(s)`);
    return res;
  });
  server.handle(codexTrashPurge, async ({ cwd, stamp, includeDocs }) => {
    const ok = await purgeTrashed(cwd, stamp, includeDocs);
    console.log(`[codex-trash] purged ${stamp} (docs: ${includeDocs}) ok=${ok}`);
    return { ok };
  });
  server.handle(codexTrashEmpty, async ({ cwd, includeDocs }) => {
    const count = await emptyTrash(cwd, includeDocs);
    console.log(`[codex-trash] emptied ${count} run(s) (docs: ${includeDocs})`);
    return { count };
  });
  server.handle(chatTrashMove, async ({ cwd, stamp }) => {
    const moved = await trashChat(cwd, stamp, Date.now());
    console.log(`[chat-trash] ${moved ? "trashed" : "skipped"} ${stamp}`);
    return { moved };
  });
  server.handle(chatTrashList, async ({ cwd }) => ({ items: await listChatTrash(cwd) }));
  server.handle(chatTrashRestore, async ({ cwd, stamp }) => {
    const res = await restoreChat(cwd, stamp);
    console.log(`[chat-trash] restore ${stamp}: ${res.restored ? "ok" : res.conflict ? "conflict" : "nothing"}`);
    return res;
  });
  server.handle(chatTrashPurge, async ({ cwd, stamp }) => {
    const ok = await purgeChat(cwd, stamp);
    console.log(`[chat-trash] purged ${stamp} ok=${ok}`);
    return { ok };
  });
  server.handle(chatTrashEmpty, async ({ cwd }) => {
    const count = await emptyChatTrash(cwd);
    console.log(`[chat-trash] emptied ${count} conversation(s)`);
    return { count };
  });
  server.handle(activityList, async ({ cwd }) => listActivity(cwd));
  server.handle(agentActivity, async ({ cwd, sessionId, wfId, agentId, status }) => readAgentActivity(cwd, sessionId, wfId, agentId, status));
  server.handle(bgOutput, async ({ cwd, sessionId, taskId }) => readBgOutput(cwd, sessionId, taskId));
  server.handle(bgClear, async ({ cwd, group }) => {
    const count = await clearFinishedBg(cwd, group);
    console.log(`[bg-clear] ${group}: ${count} task(s)`);
    return { count };
  });
  // 머리줄 단추(확장 activityCounts): Codex 진행은 패널이 보이는 최근 실행 중 끝나지 않은 것, 채팅은 문서를 읽지 않고 센다
  server.handle(activityCounts, async ({ cwd }) => {
    const [running, runs, codexChats] = await Promise.all([countRunning(cwd), listRuns(cwd), countLiveChats(cwd)]);
    return { ...running, codexRuns: runs.runs.filter((r) => !isTerminal(r.phase)).length, codexChats };
  });
  // 작업 현황 "통계" 탭(10-08) — 이 기기 ~/.claude 전체(stats-cache.json + 오늘 대화 기록)로 확장 Claude Status 통계 탭과 같은 값
  server.handle(claudeStats, async ({ force }) => collectClaudeStats(force === true));
  // 프로젝트 매니저 목록(VS Code 가 있는 이 PC 데몬에서만 뜻이 있다 — 화면도 PC 플러그인만 붙인다)
  server.handle(offlineProjectsStatus, ({ mtimeMs }) => waitOfflineCopy(mtimeMs));
  server.handle(projectsManager, async () => (await copiedProjects()) ?? listProjects());
  server.handle(projectsWait, async ({ mtimeMs }) => usesOfflineCopy() ? waitOfflineCopy(mtimeMs) : waitProjectsChange(mtimeMs));
  server.handle(projectsPins, async () => { const value = await readOfflineCopy(); return value ? { keys: value.copy?.keys ?? [] } : projectPins(); });
  server.handle(projectsPinSet, async ({ key, pinned }) => { assertProjectsWritable(); return setProjectPin(key, pinned); });
  server.handle(projectsPinOrder, async ({ keys }) => { assertProjectsWritable(); return setProjectPinOrder(keys); });
  server.handle(projectsOrder, async () => { const value = await readOfflineCopy(); return value ? { groups: value.copy?.groups ?? {} } : projectOrders(); });
  server.handle(projectsOrderSet, async ({ group, keys }) => { assertProjectsWritable(); return setProjectOrder(group, keys); });
  server.handle(projectsResetOrder, async () => {
    assertProjectsWritable();
    await Promise.all([clearProjectOrders(), clearProjectPins()]);
    return { ok: true };
  });
  // 프로젝트 관리 화면(10-10) — 목록 파일을 화면에서 고친다(이름·카테고리·켜고 끄기·추가·삭제·카테고리 이름 바꾸기·지우기)
  server.handle(projectsEdit, async (op) => { assertProjectsWritable(); return editProjects(op); });
  server.handle(projectsHosts, async () => projectHosts());
  // 팀원 관리 시험판(10-11) — 고를 스킬·명령어 목록(PC 것은 비교용, 고르는 것은 서버 것 — SSH 로 읽는다)
  server.handle(teamSkills, async () => listGlobalSkills());
  server.handle(teamServerSkills, async ({ host }) => listServerSkills(host));
  // 팀원 목록·팀원 전용 프로젝트(10-11) — PC 플러그인 전용 파일 team.json 에 저장만 한다(서버에 직원을 만드는 일은 뒷단 작업 때)
  server.handle(teamState, async () => teamStateRead());
  server.handle(teamMemberSave, async (input) => saveMember(input));
  server.handle(teamMemberRemove, async ({ id }) => removeMember(id));
  server.handle(teamProjectEdit, async ({ member, op }) => editMemberProjects(member, op));
  server.handle(teamCategoryOrder, async ({ member, names }) => setMemberCategoryOrder(member, names));
  // 서버 작업(10-11 — 서버에 반영·스킬 다시 맞추기·지우기). SSH 로 서버 직원 도구·로그인 서버 관리 도구를 부른다
  server.handle(teamJobStart, async ({ member, action }) => startTeamJob(member, action));
  server.handle(teamJobWait, async ({ jobId, seen }) => waitTeamJob(jobId, seen));
  // VS Code 확장 설정 가져오기(10-08) — 설정 화면 소리 칸 단추. 이 기기 VS Code 사용자 설정을 읽기만 한다(설정 화면은 PC 플러그인만 붙인다)
  server.handle(extSettingsImport, async () => importExtSettings());
  // 소리는 화면 하나에서만(10-08) — 화면들의 "울려도 되나"를 모아 하나만 고른다(화면은 이 PC 플러그인에만 묻는다)
  server.handle(soundScreenUsed, async ({ screenId }) => markScreenUsed(screenId));
  server.handle(soundClaim, async (input) => claimSound(input));
  // Windows PC 또는 직원 Linux 데몬이 자기 화면의 정본이다. 일반 서버로 자동 넘기지 않는다.
  let routerPromise: Promise<ReturnType<typeof createSoundRouter>> | undefined;
  const router = () => routerPromise ??= (async () => {
    const { serverId } = await hostIdentity();
    if (!canCoordinateSound() || !serverId) throw new Error("v2 소리 정본 호스트 아님/번호 미확인");
    return createSoundRouter(serverId);
  })();
  const origins = createSoundOrigins();
  server.handle(soundPresence, async (input) => (await router()).presence(input));
  server.handle(soundReport, async (input) => (await router()).report(input));
  server.handle(soundWait, async ({ screenId }) => (await router()).wait(screenId));
  server.handle(soundTake, async (input) => (await router()).take(input));
  server.handle(soundCancel, async ({ eventId }) => (await router()).cancel(eventId));
  server.handle(soundDropScreen, async ({ screenId }) => (await router()).dropScreen(screenId));
  server.handle(soundResult, async (input) => (await router()).result(input));
  server.handle(soundOriginObserve, async (input, { paseo }) => origins.observe(input.agentId, input, paseo));
  server.handle(soundOriginPrepare, async (input, { paseo }) => origins.prepare(input, paseo));
  server.handle(soundOriginValidate, async (input, { paseo }) => origins.validate(input.event, input, paseo));
  server.handle(soundOriginDrop, async ({ eventId }) => origins.drop(eventId));
  // 위쪽 제목 "카테고리 - 이름"(10-08) — 이 기기 이름표의 제목을 주고, 원래 이름 기록·프로젝트 이름 바꾸기
  server.handle(headerTitlesWait, async ({ sig }) => waitHeaderTitles(sig));
  server.handle(headerTitleApply, async (input) => applyHeaderTitle(input));
  // 생각 상자에서 Claude 의 말을 꺼낼 자리(10-09) — 이 기기의 Claude 원본 기록에서 생각 칸 경계를 찾는다
  server.handle(thinkingBoundary, async ({ agentId, text, wait }, { paseo }) => ({ cut: await thinkingCut(paseo, agentId, text, wait === true).catch(() => null) }));
  server.handle(clientLog, async ({ message }) => {
    console.log(`[client] ${message}`);
    return { ok: true };
  });
  // 생각 상자 번역·읽기 — 이 기기 키 파일로 구글 API를 호출한다
  // 10-08: 번역 대상·음성 언어(lang)는 화면이 Paseo 언어 설정으로 정해 보낸다. 없으면(옛 화면) 한국어
  server.handle(translateKo, async ({ texts, lang }) => translateTexts(texts, lang ?? "ko"));
  server.handle(ttsSynthesize, async ({ text, lang }) => synthesizeText(text, lang ?? "ko"));
  server.handle(googleStatus, async () => {
    const settings = readSpeechSettings().settings;
    const keys = readGoogleKeys();
    return { translate: !!(settings.translate === "google" ? keys.gemini : keys[settings.translate]),
      tts: !!(settings.tts === "google" ? keys.tts : keys.openai) };
  });
  server.handle(speechGet, async ({ lang }) => readSpeechSettings(lang));
  server.handle(speechSave, async (settings) => saveSpeechSettings(settings));
  server.handle(speechPreview, async (input) => previewVoice(input));
  server.handle(speechKeysState, async () => readSpeechKeysState());
  server.handle(speechKeysSave, async (input) => saveSpeechKeys(input));
  server.handle(speechKeysCheck, async (settings) => checkSpeechKeys(settings));
  // 설정 화면 "번역·읽기" 칸(10-08) — 키 저장·확인. 🔴 키 값은 돌려보내지 않는다(있음/없음·마지막 확인 결과만)
  server.handle(googleKeysState, async () => readGoogleKeysState());
  server.handle(googleKeysSave, async (input) => saveGoogleKeys(input));
  server.handle(googleKeysCheck, async ({ lang }) => checkGoogleKeys(lang ?? "ko"));
  // 폰 받아쓰기 이름 힌트(10-10) — 설정 화면 칸. 저장하면 PC 데몬이 서버들에도 보낸다
  server.handle(sttHintsGet, async () => ({ hints: readSttHints() }));
  server.handle(sttHintsSave, async ({ hints }) => saveSttHints(hints));
  // 기기 사이 Paseo 설정 맞추기의 정본(10-07) — 화면은 이 PC 플러그인만 묻는다
  server.handle(syncWait, async ({ slot, rev }) => waitSettings(slot, rev));
  server.handle(syncPut, async ({ slot, changes, seed, screen }) => putSettings(slot, changes, seed, screen));
  // PC 에서 가져오기 — PC 앱이 맡기고 웹·폰이 가져간다(10-07)
  server.handle(layoutSave, async ({ slot, key, value, screen }) => saveLayout(slot, key, value, screen));
  // 대표 PC 웹(10-08) — 설정 화면 "기준 화면" 줄의 지정·풀기 버튼
  server.handle(layoutOwnerGet, async () => ({ owner: await layoutOwner() }));
  server.handle(layoutOwnerSet, async ({ screen, label }) => setLayoutOwner(screen, label));
  server.handle(layoutLoad, async ({ slot }) => loadLayout(slot));
  // 웹·폰 원격과 Paseo 보관 상태 맞추기(rcSync, 10-06)는 10-10 리규형님 결정으로 걷었다 — Paseo 대화엔 리모트 컨트롤을 안 켠다
  // 폰·웹 세션 제목의 프로젝트 이름표 — 목록이 있는 PC 데몬만 실제로 보낸다(10-07)
  const stopProjectLabels = startProjectLabels();
  const stopProjectsCopy = startOfflineProjectsCopy();
  // 폰 받아쓰기의 받는 곳(10-10) — 모든 기기 데몬에서 연다(리규형님 결정 "4대 모두". 데몬 설정의 받아쓰기 칸을 돌린 기기만 실제로 쓴다).
  // 팀원 데몬(서버 울타리 안)은 열지 않는다 — 같은 서버 리규형님 데몬이 이미 그 포트를 쥐고 있고(EADDRINUSE, 10-11 IVR),
  // 서버 팀원 도구가 팀원 마이크를 그 창구로 돌려 둔다
  const teamDaemon = isTeamDaemon();
  const stopSttServer = teamDaemon ? () => {} : startSttServer();
  // 리규형님 키가 바뀌면 같은 서버 팀원의 키 사본도 맞춘다(10-13) — 팀원 도구가 깔린 서버의 리규형님 데몬에서만 돈다
  const stopTeamKeySync = startTeamKeySync();
  // 같은 창에서 계정 바꾸기(10-14) — 입력창 위 알약이 기록을 바꾸고, 실행기(claude-rc-relay/account.mjs)가 그 기록으로 계정을 정한다.
  // 팀원 데몬은 안 한다
  server.handle(accountsWait, async ({ rev }) => waitAccounts(rev));
  server.handle(accountSwitch, async ({ agentId, to }, { paseo }) => {
    const handle = paseo.agents.ref(agentId);
    await handle.refresh().catch(() => null);
    const provider = (handle.current() as { provider?: string } | null)?.provider ?? providerFromDisk(agentId);
    return switchAccount(agentId, to, provider);
  });
  // Claude 다시 로그인(10-14) — 로그인이 풀린 대화를 턴 끝에서 알아보고, 이 기기 데몬이 `claude auth login` 을 대신 띄운다. 팀원 데몬은 안 한다
  server.handle(loginWait, async ({ rev }) => waitLogin(rev));
  server.handle(loginStart, async ({ target }) => startLogin(target));
  server.handle(loginCode, async ({ code }) => submitCode(code));
  server.handle(loginCancel, async () => cancelLogin());
  const stopAccountHooks: Array<() => void> = [];
  if (!teamDaemon) {
    stopAccountHooks.push(server.on("agent.archived", ({ agent }) => {
      void forgetAccount(agent.id);
      forgetLogin(agent.id);
    }));
    stopAccountHooks.push(server.on("agent.turn_ended", (event) => {
      void onTurnEnded(event).catch((error: unknown) => console.log(`[claude-login] turn check failed: ${String(error)}`));
    }));
  }
  // 폰 푸시(10-15 — 질문지·압축 준비만, 모든 대화). 폰 앱이 준 토큰을 화면이 맡기고, 이 데몬 대화의 일만 보낸다. 직원 데몬은 안 한다
  server.handle(pushRegister, async ({ token }) => registerPushToken(token));
  if (teamDaemon) server.handle(pushCompactWait, async () => ({ rev: 0, agentIds: [] }));
  else {
    const push = createPush();
    server.handle(pushCompactWait, async ({ rev }) => push.waitCompact(rev));
    const guard = (work: () => unknown) => {
      try {
        void Promise.resolve(work()).catch((error: unknown) => console.log(`[push] hook failed: ${String(error)}`));
      } catch (error) {
        console.log(`[push] hook failed: ${String(error)}`);
      }
    };
    stopAccountHooks.push(
      server.on("agent.permission_requested", (event, context) => guard(() => push.onPermissionRequested(event, context))),
      server.on("agent.permission_resolved", (event) => guard(() => push.onPermissionResolved(event))),
      server.on("agent.turn_started", (event) => guard(() => push.onTurnStarted(event))),
      server.on("agent.turn_ended", (event, context) => guard(() => push.onTurnEnded(event, context))),
      server.on("agent.archived", (event) => guard(() => push.onArchived(event))),
    );
  }
  return () => {
    for (const stop of stopAccountHooks) stop();
    stopAccounts();
    stopLogin();
    void routerPromise?.then((value) => value.dispose(), () => {});
    stopProjectLabels();
    stopProjectsCopy();
    stopOfflineCopyWatch();
    stopSttServer();
    stopTeamKeySync();
  };
}
