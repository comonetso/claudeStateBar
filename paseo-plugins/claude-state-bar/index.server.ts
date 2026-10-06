import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clearFinishedBg, countRunning, listActivity, readAgentActivity, readBgOutput } from "./server/activity/workflows";
import { checkSession, forgetClient } from "./server/chime/tracker";
import { lastTurnCommandOnly } from "./server/chime/lastTurn";
import { countLiveChats, listChats } from "./server/codex/chats";
import { isTerminal, listRuns, readDoc, runItems } from "./server/codex/runs";
import { emptyTrash, listTrash, purgeTrashed, restoreTrashed, trashRun } from "./server/codex/trash";
import { emptyChatTrash, listChatTrash, purgeChat, restoreChat, trashChat } from "./server/codex/chatTrash";
import { readUsage } from "./server/codex/usage";
import { listProjects, readProjectsFile, writeProjectsFile } from "./server/projects";
import { startRcSync } from "./server/rcSync";
import { translateTexts } from "./server/translate";
import { getGoogleStatus } from "./server/googleKeys";
import { synthesizeText } from "./server/tts";
import { translateKo } from "./shared/translate";
import { googleStatus, ttsSynthesize } from "./shared/tts";
import { canPlayHere, createSoundReader } from "./server/sound";
import { activityCounts, activityList, agentActivity, bgClear, bgOutput } from "./shared/activity";
import { chimeCheck, chimeForget, lastTurnCheck } from "./shared/chime";
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
import { clientLog } from "./shared/log";
import { projectsManager, projectsPinOrder, projectsPinSet, projectsPins } from "./shared/projects";
import { projectPins, setProjectPin, setProjectPinOrder } from "./server/projectsPins";
import { projectsFileRead, projectsFileWrite } from "./shared/projectsFile";
import { DEFAULT_SETTINGS, soundSettings } from "./shared/settings";
import { syncPut, syncWait } from "./shared/settingsSync";
import { layoutLoad, layoutSave } from "./shared/layoutSync";
import { putSettings, waitSettings } from "./server/settingsSync";
import { hostIdentity, loadLayout, saveLayout } from "./server/layoutSync";
import { hostInfo, soundData } from "./shared/sound";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(soundSettings);
  const readSettings = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : DEFAULT_SETTINGS;
  };

  server.handle(soundData, createSoundReader(readSettings));
  server.handle(hostInfo, async () => ({ platform: process.platform, canPlay: canPlayHere(), ...(await hostIdentity()) }));
  server.handle(chimeCheck, async ({ clientId, sessionId, cwd }) => checkSession(clientId, sessionId, cwd));
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
  // 프로젝트 매니저 목록(VS Code 가 있는 이 PC 데몬에서만 뜻이 있다 — 화면도 PC 플러그인만 붙인다)
  server.handle(projectsManager, async () => listProjects());
  server.handle(projectsPins, async () => projectPins());
  server.handle(projectsPinSet, async ({ key, pinned }) => setProjectPin(key, pinned));
  server.handle(projectsPinOrder, async ({ keys }) => setProjectPinOrder(keys));
  server.handle(projectsFileRead, async () => readProjectsFile());
  server.handle(projectsFileWrite, async ({ text, baseMtimeMs }) => writeProjectsFile(text, baseMtimeMs));
  server.handle(clientLog, async ({ message }) => {
    console.log(`[client] ${message}`);
    return { ok: true };
  });
  // 생각 상자 번역·읽기 — 이 기기 키 파일로 구글 API를 호출한다
  server.handle(translateKo, async ({ texts }) => translateTexts(texts));
  server.handle(ttsSynthesize, async ({ text }) => synthesizeText(text));
  server.handle(googleStatus, async () => getGoogleStatus());
  // 기기 사이 Paseo 설정 맞추기의 정본(10-07) — 화면은 이 PC 플러그인만 묻는다
  server.handle(syncWait, async ({ slot, rev }) => waitSettings(slot, rev));
  server.handle(syncPut, async ({ slot, changes, seed }) => putSettings(slot, changes, seed));
  // 머리줄 동기화 단추 — PC 앱이 맡기고 웹·폰이 가져간다(10-07)
  server.handle(layoutSave, async ({ slot, key, value }) => saveLayout(slot, key, value));
  server.handle(layoutLoad, async ({ slot }) => loadLayout(slot));
  // 웹·폰 원격과 Paseo 보관 상태 맞추기 + 열린 대화의 Claude 를 띄워 원격에 붙이기(10-06)
  const stopRcSync = startRcSync();
  return () => {
    stopRcSync();
  };
}
