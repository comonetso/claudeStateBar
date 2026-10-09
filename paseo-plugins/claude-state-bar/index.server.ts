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
import { startRcSync } from "./server/rcSync";
import { translateTexts } from "./server/translate";
import { getGoogleStatus } from "./server/googleKeys";
import { checkGoogleKeys, googleKeysState as readGoogleKeysState, saveGoogleKeys } from "./server/googleCheck";
import { googleKeysCheck, googleKeysSave, googleKeysState } from "./shared/googleKeys";
import { synthesizeText } from "./server/tts";
import { translateKo } from "./shared/translate";
import { googleStatus, ttsSynthesize } from "./shared/tts";
import { startSttServer } from "./server/sttServer";
import { readSttHints, saveSttHints } from "./server/sttHints";
import { sttHintsGet, sttHintsSave } from "./shared/stt";
import { canPlayHere, createSoundReader, LEGACY_SILENT_WAV } from "./server/sound";
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
import { projectsManager, projectsWait, projectsOrder, projectsOrderSet, projectsPinOrder, projectsPinSet, projectsPins, projectsResetOrder } from "./shared/projects";
import { clearProjectOrders, projectOrders, setProjectOrder } from "./server/projectsOrder";
import { clearProjectPins, projectPins, setProjectPin, setProjectPinOrder } from "./server/projectsPins";
import { DEFAULT_SETTINGS, soundSettings } from "./shared/settings";
import { syncPut, syncWait } from "./shared/settingsSync";
import { layoutLoad, layoutOwnerGet, layoutOwnerSet, layoutSave } from "./shared/layoutSync";
import { putSettings, waitSettings } from "./server/settingsSync";
import { hostIdentity, layoutOwner, loadLayout, saveLayout, setLayoutOwner } from "./server/layoutSync";
import { hostInfo, soundData, soundDataV2 } from "./shared/sound";
import { importExtSettings } from "./server/extSettings";
import { extSettingsImport } from "./shared/extSettings";
import { collectClaudeStats } from "./server/stats/claudeStats";
import { claudeStats } from "./shared/stats";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(soundSettings);
  const readSettings = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : DEFAULT_SETTINGS;
  };

  const readSound = createSoundReader(readSettings);
  server.handle(soundDataV2, readSound);
  server.handle(soundData, async (input) => input.file !== undefined || input.gain !== undefined
    ? readSound(input) : { dataUrl: LEGACY_SILENT_WAV, path: "" });
  server.handle(hostInfo, async () => ({ platform: process.platform, canPlay: canPlayHere(), ...(await hostIdentity()) }));
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
  server.handle(projectsManager, async () => listProjects());
  server.handle(projectsWait, async ({ mtimeMs }) => waitProjectsChange(mtimeMs));
  server.handle(projectsPins, async () => projectPins());
  server.handle(projectsPinSet, async ({ key, pinned }) => setProjectPin(key, pinned));
  server.handle(projectsPinOrder, async ({ keys }) => setProjectPinOrder(keys));
  server.handle(projectsOrder, async () => projectOrders());
  server.handle(projectsOrderSet, async ({ group, keys }) => setProjectOrder(group, keys));
  server.handle(projectsResetOrder, async () => {
    await Promise.all([clearProjectOrders(), clearProjectPins()]);
    return { ok: true };
  });
  // VS Code 확장 설정 가져오기(10-08) — 설정 화면 소리 칸 단추. 이 기기 VS Code 사용자 설정을 읽기만 한다(설정 화면은 PC 플러그인만 붙인다)
  server.handle(extSettingsImport, async () => importExtSettings());
  // 소리는 화면 하나에서만(10-08) — 화면들의 "울려도 되나"를 모아 하나만 고른다(화면은 이 PC 플러그인에만 묻는다)
  server.handle(soundScreenUsed, async ({ screenId }) => markScreenUsed(screenId));
  server.handle(soundClaim, async (input) => claimSound(input));
  // 정본은 이 환경의 Windows PC 하나다. 다른 소리 파일 호스트로 자동 failover하지 않는다.
  let routerPromise: Promise<ReturnType<typeof createSoundRouter>> | undefined;
  const router = () => routerPromise ??= (async () => {
    const { serverId } = await hostIdentity();
    if (process.platform !== "win32" || !serverId) throw new Error("v2 소리 정본 PC 아님/번호 미확인");
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
  server.handle(googleStatus, async () => getGoogleStatus());
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
  // 웹·폰 원격과 Paseo 보관 상태 맞추기 + 열린 대화의 Claude 를 띄워 원격에 붙이기(10-06)
  const stopRcSync = startRcSync();
  // 폰·웹 세션 제목의 프로젝트 이름표 — 목록이 있는 PC 데몬만 실제로 보낸다(10-07)
  const stopProjectLabels = startProjectLabels();
  // 폰 받아쓰기의 받는 곳(10-10) — 모든 기기 데몬에서 연다(리규형님 결정 "4대 모두". 데몬 설정의 받아쓰기 칸을 돌린 기기만 실제로 쓴다)
  const stopSttServer = startSttServer();
  return () => {
    void routerPromise?.then((value) => value.dispose(), () => {});
    stopRcSync();
    stopProjectLabels();
    stopSttServer();
  };
}
