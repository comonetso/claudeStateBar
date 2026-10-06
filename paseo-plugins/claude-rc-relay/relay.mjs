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
// 그 밖에는 Paseo 화면 중복을 막으려고 본 대화 완성본 줄의 글만 고친다(아래 fixAssistant). 나머지 바이트는 손대지 않는다.
// Paseo 가 Remote Control 기능을 넣으면 설정에서 command 를 지우고 이 파일을 버린다 — 그때 화면 중복도 Paseo 에서
// 고쳐졌는지 먼저 본다(요청: https://github.com/getpaseo/paseo/discussions/6141, 10-05).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Paseo 가 대화 제목·브랜치 이름을 지으려고 한 번 부르는 일회성 실행은 SDK 옵션 persistSession:false 로 띄우고,
// SDK 는 그걸 이 인자로 넘긴다(Paseo 0.11 데몬: 구조화 텍스트 생성·Branch name generator 두 곳, internal:true).
// 이어 볼 대화가 아니라서 Remote Control 을 켜면 폰 목록에 몇 초짜리 세션만 생겼다 보관 목록에 쌓인다(10-05 실측 2건).
const ephemeral = argv.includes("--no-session-persistence");
log(`start real=${real} args=${argv.length}${resumeArg ? ` ${resumeArg.slice(0, 50)}` : ""}${ephemeral ? " ephemeral" : ""}`);

// 웹·폰 원격과 Paseo 보관 상태 맞추기(리규형님 10-06 결정) — 플러그인 claude-state-bar 의 rcSync 가 읽는 상태 파일.
// ~/.paseo/claude-rc-state/<Claude 대화 번호>.json = { sessionId, relayPid, startedAt, cse?, remoteArchivedAt?, exitedAt? }
// 대화 번호는 이어 띄울 때 --resume=<번호>, 새 대화면 Claude 가 내보내는 첫 session_id 에서 얻는다.
const STATE_DIR = join(homedir(), ".paseo", "claude-rc-state");
const argValue = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return null;
  return argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[i + 1] ?? null;
};
let sessionId = argValue("--resume") ?? argValue("--session-id");
let state = null;
const saveState = (patch) => {
  if (ephemeral || !sessionId) return;
  const file = join(STATE_DIR, `${sessionId}.json`);
  if (!state) {
    // 같은 대화를 다시 띄우면 원격 번호만 이어받는다(Remote Control 이 켜지면 어차피 다시 적힌다)
    let prevCse;
    try {
      prevCse = JSON.parse(readFileSync(file, "utf8")).cse;
    } catch {
      /* 처음 */
    }
    state = { sessionId, relayPid: process.pid, startedAt: new Date().toISOString(), ...(prevCse ? { cse: prevCse } : {}) };
  }
  Object.assign(state, patch);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch {
    /* 기록 실패는 중계에 영향을 주지 않는다 */
  }
};
saveState({});

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
  if (!sessionId) {
    const m = /"session_id":"([0-9a-f-]{36})"/.exec(line);
    if (m) {
      sessionId = m[1];
      saveState({});
    }
  }
  if (line.includes(RC_ID)) {
    const ok = line.includes('"subtype":"success"');
    log(ok ? "remote control on" : `remote control failed: ${line.slice(0, 300)}`);
    const cse = /"bridge_session_id":"(cse_[A-Za-z0-9]+)"/.exec(line);
    if (ok && cse) saveState({ cse: cse[1] });
    return false;
  }
  if (line.includes('"bridge_state"')) {
    const m = /"state":"([a-z_]+)"/.exec(line);
    const bridge = m ? m[1] : "?";
    // 정상 상태는 낱말만, 그 밖(failed 등)은 원인을 알 수 있게 원문 앞부분까지 남긴다(10-05 22:26 끊김 원인을 못 찾음)
    log(bridge === "ready" || bridge === "connected" ? `bridge ${bridge}` : `bridge ${bridge}: ${line.trim().slice(0, 300)}`);
    // 웹·폰에서 이 세션을 보관(또는 끝)하면 Claude 가 알린다 — "ended or archived from another device or app (code 4090)"(10-06 실측).
    // Claude 가 꺼질 때 저절로 되는 원격 보관과 구별되는 유일한 신호라 플러그인이 이걸 보고 Paseo 쪽도 보관한다.
    if (bridge === "failed" && (line.includes("4090") || /archived from another device/.test(line))) {
      saveState({ remoteArchivedAt: new Date().toISOString() });
      log("remote archived — Paseo 쪽 보관 대기");
    }
    return false;
  }
  if (!sent && initId && line.includes('"control_response"') && line.includes(`"${initId}"`)) {
    // 리규형님 설정(remoteControlAtStartup)·조직 정책을 Claude 가 판정한 값을 그대로 따른다
    if (ephemeral) {
      sent = true;
      log("ephemeral run — not enabling");
    } else if (/"remote_control_auto_enable":\s*true/.test(line)) setImmediate(() => enable("auto_enable"));
    else {
      sent = true;
      log("auto_enable off — not enabling");
    }
  }
  return true;
};
// Paseo 화면 중복 막기(10-05 리규형님 "대화가 중복으로 계속 나온다").
// Claude 는 한 응답의 완성본(assistant 줄)을 블록마다 따로, 그 블록만 담아 보낸다(실측). Paseo 0.11 의 조립기
// (TimelineAssembler.applyAbsoluteFragments)는 완성본을 "그 응답의 지금까지 전체"로 보고, 실시간 조각으로 쌓은 글과
// 앞부분이 다르면 처음부터 다시 그린 셈 친다. 그래서 같은 응답에 생각·본문 블록이 둘 이상이면 두 번째부터 두 번 나온다.
// 본 대화 줄의 첫 생각·본문 블록 앞에 같은 응답에서 앞서 나온 글을 붙여 Paseo 가 기대하는 모양으로 맞춘다.
// 서브에이전트 줄(parent_tool_use_id)은 Paseo 가 조립기를 거치지 않고 블록마다 그리므로 손대지 않는다.
let curMsgId = null;
let prevThinking = "";
let prevText = "";
const fixAssistant = (line) => {
  if (!line.includes('"type":"assistant"')) return line;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return line;
  }
  if (o.type !== "assistant" || o.parent_tool_use_id || !Array.isArray(o.message?.content) || !o.message.id) return line;
  if (o.message.id !== curMsgId) {
    curMsgId = o.message.id;
    prevThinking = "";
    prevText = "";
  }
  const pT = prevThinking;
  const pX = prevText;
  let changed = false;
  let firstThinking = true;
  let firstText = true;
  for (const b of o.message.content) {
    if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      prevThinking += b.thinking;
      if (firstThinking && pT) {
        b.thinking = pT + b.thinking;
        changed = true;
      }
      firstThinking = false;
    } else if (b?.type === "text" && typeof b.text === "string" && b.text) {
      prevText += b.text;
      if (firstText && pX) {
        b.text = pX + b.text;
        changed = true;
      }
      firstText = false;
    }
  }
  return changed ? JSON.stringify(o) + "\n" : line;
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
    if (handleLine(line)) pass += fixAssistant(line);
  }
  if (pass) process.stdout.write(pass);
});
child.stdout.on("end", () => {
  outBuf += decoder.end();
  if (outBuf && handleLine(outBuf)) process.stdout.write(fixAssistant(outBuf));
  outBuf = "";
});

child.on("exit", (code, signal) => {
  log(`exit code=${code} signal=${signal}`);
  saveState({ exitedAt: new Date().toISOString() });
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
