#!/usr/bin/env node
// Paseo 가 띄우는 Claude 에 Remote Control 을 붙이는 중계 프로그램(리규형님 10-05 결정 — 중계 + Paseo 에 기능 요청).
//
// 왜: Paseo 는 Claude 를 화면 없는 stream-json 방식으로 띄운다. 이 방식에서는 /remote-control 명령이 막히고,
// 설정 remoteControlAtStartup 도 Claude 가 직접 켜지 않는다 — 초기화 응답에 remote_control_auto_enable 로
// "켜야 한다"고 알려만 주고, 실제로 켜는 건 띄운 쪽(VS Code 확장 등)이 control_request
// {subtype:"remote_control", enabled:true} 를 보내서 한다. Paseo 는 그 요청을 보내지 않는다(Paseo 97083dd 기준).
//
// 하는 일: Paseo 설정 agents.providers.claude.command 를 ["node", "<이 파일>", "--real", "<진짜 claude>"] 로 두면
// Paseo 가 붙이는 인자를 그대로 진짜 claude 에 넘기고 입출력을 중계한다. 초기화 응답이 자동 연결을 말하면 켜기 요청을
// 한 줄 끼워 넣고, 그 응답과 연결 상태 알림(system/bridge_state)은 Paseo 로 넘기지 않는다(Paseo 가 모르는 줄).
// 그 밖의 바이트는 손대지 않는다. Paseo 가 이 기능을 넣으면 설정에서 command 를 지우고 이 파일을 버린다
// (요청: https://github.com/getpaseo/paseo/discussions/6141, 10-05).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const argv = process.argv.slice(2);
let real = "claude";
if (argv[0] === "--real") {
  real = argv[1];
  argv.splice(0, 2);
}

const LOG = join(homedir(), ".paseo", "claude-rc-relay.log");
const log = (msg) => {
  try {
    mkdirSync(join(homedir(), ".paseo"), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {
    /* 기록 실패는 중계에 영향을 주지 않는다 */
  }
};

const RC_ID = `csb-rc-${process.pid}`;
const resumeArg = argv.find((a) => a.startsWith("--resume"));
log(`start real=${real} args=${argv.length}${resumeArg ? ` ${resumeArg.slice(0, 50)}` : ""}`);

const child = spawn(real, argv, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
child.on("error", (e) => {
  log(`spawn failed: ${e.message}`);
  process.stderr.write(`claude-rc-relay: cannot start ${real}: ${e.message}\n`);
  process.exit(127);
});

// Paseo → claude: 바이트는 그대로 넘기고, 줄을 훑어 초기화 요청 번호만 기억한다
let initId = null;
let inBuf = "";
process.stdin.on("data", (chunk) => {
  child.stdin.write(chunk);
  if (initId) return;
  inBuf += chunk.toString("utf8");
  let nl;
  while ((nl = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    if (!line.includes('"initialize"')) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
        initId = msg.request_id;
        inBuf = "";
        break;
      }
    } catch {
      /* 줄이 JSON 이 아니면 지나간다 */
    }
  }
});
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => {
  /* claude 가 먼저 끝나 파이프가 닫힌 경우 */
});

// claude → Paseo: 줄 단위로 넘기되, 우리가 보낸 요청의 응답과 연결 상태 알림만 뺀다
let sent = false;
let outBuf = "";
const enable = (why) => {
  if (sent) return;
  sent = true;
  log(`enable remote control (${why})`);
  child.stdin.write(JSON.stringify({ type: "control_request", request_id: RC_ID, request: { subtype: "remote_control", enabled: true } }) + "\n");
};
const handleLine = (line) => {
  if (line.includes(RC_ID)) {
    log(line.includes('"subtype":"success"') ? "remote control on" : `remote control failed: ${line.slice(0, 300)}`);
    return false;
  }
  if (line.includes('"bridge_state"')) {
    const m = /"state":"([a-z_]+)"/.exec(line);
    log(`bridge ${m ? m[1] : "?"}`);
    return false;
  }
  if (!sent && initId && line.includes('"control_response"') && line.includes(`"${initId}"`)) {
    // 리규형님 설정(remoteControlAtStartup)·조직 정책을 Claude 가 판정한 값을 그대로 따른다
    if (/"remote_control_auto_enable":\s*true/.test(line)) setImmediate(() => enable("auto_enable"));
    else {
      sent = true;
      log("auto_enable off — not enabling");
    }
  }
  return true;
};
// 조각 경계에서 잘린 한글이 깨지지 않게 디코더로 이어 붙인다
const decoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk) => {
  outBuf += decoder.write(chunk);
  let nl;
  let pass = "";
  while ((nl = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, nl + 1);
    outBuf = outBuf.slice(nl + 1);
    if (handleLine(line)) pass += line;
  }
  if (pass) process.stdout.write(pass);
});
child.stdout.on("end", () => {
  outBuf += decoder.end();
  if (outBuf && handleLine(outBuf)) process.stdout.write(outBuf);
  outBuf = "";
});

child.on("exit", (code, signal) => {
  log(`exit code=${code} signal=${signal}`);
  process.exitCode = code ?? 1;
  process.stdout.write("", () => process.exit(code ?? 1));
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 이미 끝남 */
    }
  });
}
