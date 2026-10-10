// Paseo 공급자 "Claude (Yeogiaen)" 실행 스크립트(10-10). 회사 Team 계정 폴더(~/.claude-team)로 claude 를 띄운다.
// 순서는 바탕화면 세션이 만든 claude-team.cmd 와 같다 — 설정 동기화(claude-team-sync.js team)를 한 번 돌리고 claude 실행.
// 동기화가 실패해도 그대로 실행한다(claude-team.cmd 도 결과를 보지 않는다).
// 동기화 출력은 stderr 로만 보낸다 — stdout 은 Paseo 와 claude 가 주고받는 stream-json 통로라 섞이면 안 된다.
// 리모트 컨트롤 중계(relay.mjs)는 거치지 않는다 — Team 은 조직 정책으로 리모트 컨트롤이 꺼져 있다.
// 쓰는 법(Paseo config.json agents.providers): command = [node, 이 파일, "--real", <claude.exe>]
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("--real");
if (at < 0 || !args[at + 1]) {
  process.stderr.write("claude-team-launch: --real <claude 실행 파일> 이 필요합니다\n");
  process.exit(2);
}
const real = args[at + 1];
const argv = [...args.slice(0, at), ...args.slice(at + 2)];

const env = { ...process.env, CLAUDE_CONFIG_DIR: join(homedir(), ".claude-team") };
const sync = spawnSync(process.execPath, [join(homedir(), ".local", "bin", "claude-team-sync.js"), "team"], {
  stdio: ["ignore", 2, 2],
  env,
  windowsHide: true,
});
if (sync.error || sync.status !== 0) {
  process.stderr.write(`claude-team-launch: 설정 동기화 실패(${sync.error?.message ?? `exit ${sync.status}`}) — 그대로 실행합니다\n`);
}

const child = spawn(real, argv, { stdio: "inherit", env, windowsHide: true });
child.on("error", (e) => {
  process.stderr.write(`claude-team-launch: claude 실행 실패 ${e.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 이미 끝남 */
    }
  });
}
