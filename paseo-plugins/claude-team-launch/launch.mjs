// Paseo 가 넣어 준 공급자 계정 env 로 Claude 를 띄운다. 고정 팀 폴더를 덮어씌우지 않는다.
// 순서는 바탕화면 세션이 만든 claude-team.cmd 와 같다 — 설정 동기화(claude-team-sync.js team)를 한 번 돌리고 claude 실행.
// 동기화가 실패해도 그대로 실행한다(claude-team.cmd 도 결과를 보지 않는다).
// 동기화 출력은 stderr 로만 보낸다 — stdout 은 Paseo 와 claude 가 주고받는 stream-json 통로라 섞이면 안 된다.
// 리모트 컨트롤 중계(relay.mjs)는 거치지 않는다 — Team 은 조직 정책으로 리모트 컨트롤이 꺼져 있다.
// 쓰는 법(Paseo config.json agents.providers): command = [node, 이 파일, "--real", <claude.exe>]
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyAccount, HOME, watchAccount } from "../claude-rc-relay/account.mjs";
import { createRotation, handoffNotice, jsonLines, noticeForwarder, saveHandoff, takeHandoff } from "../claude-rc-relay/rotation.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--real");
if (at < 0 || !args[at + 1]) {
  process.stderr.write("claude-team-launch: --real <claude 실행 파일> 이 필요합니다\n");
  process.exit(2);
}
const real = args[at + 1];
const argv = [...args.slice(0, at), ...args.slice(at + 2)];

// 같은 창 계정 바꾸기(10-14, ../claude-rc-relay/account.mjs): 이 대화를 개인 계정으로 바꿔 둔 기록이 있으면 팀 계정 값
// (CLAUDE_CONFIG_DIR)을 지우고 기본 폴더(개인 계정)로 띄운다. 그때는 팀 설정 동기화도 하지 않는다.
const agentId = process.env.PASEO_AGENT_ID || null;
const env = { ...process.env };
const ephemeral = argv.includes("--no-session-persistence");
if (!ephemeral) applyAccount(env, agentId);
if (env.CLAUDE_CONFIG_DIR) {
  const sync = spawnSync(process.execPath, [join(homedir(), ".local", "bin", "claude-team-sync.js"), "team"], {
    stdio: ["ignore", 2, 2],
    env,
    windowsHide: true,
  });
  if (sync.error || sync.status !== 0) {
    process.stderr.write(`claude-team-launch: 설정 동기화 실패(${sync.error?.message ?? `exit ${sync.status}`}) — 그대로 실행합니다\n`);
  }
}

const log = (message) => {
  try {
    const dir = process.env.PASEO_HOME || join(homedir(), ".paseo");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "claude-rc-relay.log"), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch { /* 로그 실패로 Claude 를 끄지 않는다 */ }
};
// 자동 전환으로 꺼졌다 다시 뜨는 거라면 꺼지기 전 백그라운드 작업 목록을 첫 사람 말 앞에 한 번 붙인다(10-15, rotation.mjs saveHandoff)
const handoff = ephemeral ? null : takeHandoff(HOME, agentId);
if (handoff) log(`rotation handoff (agent ${String(agentId).slice(0, 8)}) — notice on next message, tasks=${handoff.tasks?.length ?? 0}`);
const rotation = createRotation({ real, env, initialEnv: process.env, agentId, log, enabled: !ephemeral,
  handoff: (info) => saveHandoff(HOME, agentId, info) });
const child = spawn(real, argv, { stdio: ["pipe", "pipe", "inherit"], env, windowsHide: true });
const input = jsonLines(rotation.input), output = jsonLines(rotation.observe);
process.stdin.on("data", input.write);
process.stdin.on("end", input.end);
if (handoff) {
  // 안내를 붙일 때만 직접 넘긴다(pipe 대신) — 막히면 입력을 잠시 멈춘다
  const forward = noticeForwarder(handoffNotice(handoff), (data) => {
    if (!child.stdin.write(data)) { process.stdin.pause(); child.stdin.once("drain", () => process.stdin.resume()); }
  }, () => log("rotation handoff notice added to the next message"));
  process.stdin.on("data", forward.write);
  process.stdin.on("end", () => { forward.end(); child.stdin.end(); });
} else process.stdin.pipe(child.stdin);
child.stdin.on("error", () => { /* Claude 가 먼저 종료됨 */ });
child.stdout.on("data", (chunk) => {
  output.write(chunk);
  if (!process.stdout.write(chunk)) child.stdout.pause();
});
process.stdout.on("drain", () => child.stdout.resume());
child.stdout.on("end", output.end);
// 켜져 있는 동안 이 대화의 계정 기록이 바뀌면 Claude 를 끈다 — 다음 말 때 Paseo 가 이 실행기를 다시 띄우며 새 계정이 적용된다
const stopAccountWatch = ephemeral ? () => {} : watchAccount(agentId, () => {
  log("account changed — stopping claude; the next message restarts it");
  try {
    child.kill();
  } catch {
    /* 이미 끝남 */
  }
});
child.on("exit", () => { stopAccountWatch(); rotation.stop(); });
child.on("error", (e) => {
  process.stderr.write(`claude-team-launch: claude 실행 실패 ${e.message}\n`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 이미 끝남 */
    }
  });
}
