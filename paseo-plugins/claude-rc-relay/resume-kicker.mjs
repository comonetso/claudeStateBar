#!/usr/bin/env node
// 넘긴 뒤 자동 이어 달리기(10-16 리규형님 "자동으로 이어서") — rotation.mjs startResumeKicker 가 띄우는 분리 프로세스.
// 실행기가 팀 공급자를 넘겨 Claude 를 끄고 스스로 끝나면, 실행기와 이어 둔 표준 입력 파이프가 닫힌다. 그때 한 번:
//   ① 넘김 파일(<home>/claude-rc-relay-handoff/<대화>.json)이 없으면 — 이미 누가(사람 말·깨우기) 다시 띄워 가져갔다 → 아무것도 안 함
//   ② Paseo 에서 그 대화가 실행 중이면 — 이미 다시 떴다 → 아무것도 안 함
//   ③ 아니면 Paseo 에 이어 달리기 말(RESUME_PROMPT)을 넣는다 → Paseo 가 새 공급자로 실행기를 다시 띄우고, 실행기가 넘김 안내를 그 말 앞에 붙인다
// 기다리는 시간 값은 없다 — 파이프가 닫히는 순간이 실행기가 끝난 순간이다.
// 무중단 작업(10-16 저녁, workstate.mjs): 이행 번호(tid)를 받으면 이행 파일(claude-work/transition)에 단계를 남긴다 —
// dispatching(보내는 중) → admitted(접수·이미 다시 뜸) / failed(보내기 실패) / unknown(결과 모름). 감독자가 이 기록으로 넘겨받는다.
// 감독자가 이미 넘겨받은 이행(주인이 kicker 가 아님)이면 아무것도 보내지 않는다 — 두 번 깨우지 않게.
// 인자: <대화 번호> <Paseo 홈> <기록 파일> [이행 번호]
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paseoCli, RESUME_PROMPT } from "./rotation.mjs";
import { appendEvent, pruneTransitions, readTransition, TRANSITION_OPEN, writeTransition } from "./workstate.mjs";

const [agentId, home, logFile, tid] = process.argv.slice(2);
const short = String(agentId ?? "").slice(0, 8);
const log = (message) => {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] rotation resume ${message} (agent ${short})\n`);
  } catch { /* 기록 실패는 무시 */ }
};
const handoff = join(home, "claude-rc-relay-handoff", `${agentId}.json`);
const root = join(home ?? "", "claude-work");

/** 이행 파일 단계 — 이 kicker 가 주인일 때만 바꾼다. 주인이 아니면 false(아무것도 하지 말라는 뜻) */
function stage(state, extra = {}) {
  if (!tid) return true;
  try {
    const cur = readTransition(root, agentId, tid);
    if (!cur) return true; // 기록이 없으면(쓰기 실패) 예전처럼 동작만 한다
    if (cur.owner !== "kicker" || !TRANSITION_OPEN.includes(cur.state)) {
      log(`skipped — transition ${tid} is ${cur.state} owned by ${cur.owner ?? "?"}`);
      return false;
    }
    writeTransition(root, agentId, { ...cur, state, ...(state === "dispatching" ? { dispatchAt: new Date().toISOString() } : { closedAt: new Date().toISOString() }), ...extra });
    appendEvent(root, { kind: "transition", agentId, tid, state, owner: "kicker", ...extra });
    if (!TRANSITION_OPEN.includes(state)) pruneTransitions(root, agentId);
  } catch (error) { log(`transition record failed — ${error?.code ?? error?.message ?? error}`); }
  return true;
}

// Paseo 명령 실행 — PC 의 paseo.cmd 는 cmd 로(인자는 따옴표로 감싼다, 넣을 말은 파일로 넘겨 따옴표 문제가 없다), 시험용 .mjs 는 node 로
function paseo(args) {
  const cli = paseoCli();
  // 데몬이 답하지 않으면 영원히 기다리지 않는다 — 감독자의 재확인 간격(RECHECK_MS 5분)과 같은 값. 시간이 다 되면 결과 모름으로 남긴다(Codex 리뷰 261016_182309)
  const opts = { encoding: "utf8", windowsHide: true, env: process.env, timeout: 300_000, killSignal: "SIGKILL" };
  if (/\.(mjs|cjs|js)$/i.test(cli)) return spawnSync(process.execPath, [cli, ...args], opts);
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${[cli, ...args].map((a) => `"${a}"`).join(" ")}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawnSync(cli, args, opts);
}

let done = false;
function resume() {
  if (done) return;
  done = true;
  try {
    if (!agentId || !home || !logFile) return;
    if (!stage("dispatching")) return;
    if (!existsSync(handoff)) { log("skipped — already restarted (handoff taken)"); stage("admitted", { by: "restarted" }); return; }
    const inspect = paseo(["inspect", agentId, "--json"]);
    let status = null;
    try { status = JSON.parse(inspect.stdout).Status ?? null; } catch { /* 아래에서 실패로 남긴다 */ }
    if (!status) { log(`failed — inspect exit=${inspect.status ?? inspect.error?.code ?? "?"}`); stage("unknown", { why: "inspect" }); return; }
    if (status === "running") { log("skipped — agent already running"); stage("admitted", { by: "running" }); return; }
    if (!existsSync(handoff)) { log("skipped — already restarted (handoff taken)"); stage("admitted", { by: "restarted" }); return; }
    const promptFile = join(home, "claude-rc-relay-handoff", `${agentId}.resume.txt`);
    // 이번 이행 번호를 말에 붙인다 — 감독자가 결과 모름 이행을 대화 기록에서 확인할 때 예전 넘김의 같은 문구와 섞지 않게(Codex 리뷰 261016_182309)
    try { writeFileSync(promptFile, tid ? `${RESUME_PROMPT} (이행 ${tid})` : RESUME_PROMPT); } catch (error) {
      log(`failed — prompt file ${error?.code ?? error}`); stage("failed", { why: "prompt-file" }); return; // 아직 아무것도 안 보냈다
    }
    const sent = paseo(["send", agentId, "--prompt-file", promptFile, "--no-wait"]);
    try { unlinkSync(promptFile); } catch { /* 이미 없음 */ }
    log(sent.status === 0 ? `sent (was ${status})` : `send failed exit=${sent.status ?? sent.error?.code ?? "?"} (was ${status})`);
    // 0 이면 데몬이 받았다. 그 밖은 데몬과 주고받다 끊겼을 수도 있어 "모름" — 감독자가 대화 기록으로 확인만 하고 다시 보내지 않는다
    if (sent.status === 0) stage("admitted", { by: "sent", was: status });
    else stage("unknown", { why: `send ${sent.error?.code ?? `exit ${sent.status}`}` });
  } catch (error) {
    log(`failed — ${error?.message ?? error}`);
    stage("unknown", { why: "exception" });
  }
}
process.stdin.on("end", resume);
process.stdin.on("close", resume);
process.stdin.on("error", resume);
process.stdin.resume();
