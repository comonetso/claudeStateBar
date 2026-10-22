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
//
// 🔴 실행기는 이 파일 하나다(10-18 리규형님 "코드가 파편화된 것이 문제"). 개인·팀 공급자 모두, PC·서버 모두 이 파일로 띄운다.
// PC 팀 공급자만 따로 쓰던 claude-team-launch/launch.mjs 는 이 파일을 그대로 실행하는 이행용 껍데기다 — 거기에 기능을 넣지 마라.
// 그 실행기에만 있던 동작(SIGBREAK 신호 · 동기화 실패 이유 남기기 · 출력·입력 흐름 제어)은 여기로 옮겼다.
// 팀 설정 동기화는 PC(Windows) 도구라 Windows 에서만 돈다(10-18 Codex 261018_052815 D4 — 리눅스에서 PC 정션 스크립트를 부르지 않는다).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { applyAccount, HOME, watchAccount } from "./account.mjs";
import { createAssistantFix } from "./assistant-fix.mjs";
import { createRotation, handoffNotice, jsonLines, noticeForwarder, saveHandoff, shouldResume, startResumeKicker, takeHandoff } from "./rotation.mjs";
import { isRegistered, isStaffDaemon, legacyRcStateDir, paseoHome, personalSwitchFile, relayLogFile, rotationTestFile, teamSyncScript, workRecorder, workRoot } from "./workstate.mjs";

// 진짜 claude 위치 — `--real <실행 파일>` 하나만 받는다(10-18 Codex D5). 해석은 이 한 곳뿐이다(팀 껍데기 launch.mjs 도 이 파일을 그대로 실행한다).
// 기기 네 대의 Paseo 설정은 모두 맨 앞 `--real <claude>` 이고(10-18 실측), 옛 팀 실행기는 위치와 무관하게 찾았다 — 둘 다 받으려고 첫 `--real` 을 찾는다.
// `--real` 이 없거나 · 값이 비었거나 · 값이 다른 옵션처럼 보이거나(-로 시작) · 두 번 나오면 실패한다.
// 예전 relay 는 `--real` 이 맨 앞이 아니면 PATH 의 claude 를 조용히 실행했다 — 다른 판의 claude 가 떠도 알 수 없었다
const rawArgs = process.argv.slice(2);
const realAt = rawArgs.indexOf("--real");
const realValue = realAt >= 0 ? rawArgs[realAt + 1] : undefined;
const realBad = realAt < 0 ? "--real 이 없음" : !realValue ? "--real 뒤 값이 없음" : realValue.startsWith("-") ? `--real 뒤 값이 옵션처럼 보임(${realValue.slice(0, 40)})`
  : rawArgs.indexOf("--real", realAt + 1) >= 0 ? "--real 이 두 번 나옴" : null;
if (realBad) {
  // 동기 쓰기로 다 쓴 뒤 끝낸다 — Windows 에서 stderr 가 파이프면 process.stderr.write 는 비동기라 바로 끝내면 이 줄이 잘릴 수 있다.
  // 최상위 await 를 쓰지 않는다(10-18 2차 — rotation_verify 가 이 파일을 CommonJS 로 바꿔 vm 에서 돌리는데 최상위 await 가 있으면 문법 오류)
  try {
    writeSync(2, `claude-rc-relay: ${realBad} — 사용법: node relay.mjs --real <claude 실행 파일> [claude 인자…]\n`);
  } catch {
    /* 오류 출력이 막혀도 종료 코드 2 는 남긴다 */
  }
  process.exit(2);
}
const real = realValue;
const argv = [...rawArgs.slice(0, realAt), ...rawArgs.slice(realAt + 2)];

const LOG_DIR = paseoHome(process.env);
const LOG = relayLogFile(LOG_DIR);
const log = (msg) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
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

// 10-10 리규형님 결정: Paseo 대화엔 리모트 컨트롤을 켜지 않는다(Paseo 로 폰·웹에서 다 보게 되어 필요 없어짐).
// 이 중계는 아래 화면 중복 막기(fixAssistant)와 일회성 실행 구분 때문에 남겨 둔다. 다시 켜려면 true —
// 그때는 함께 걷은 보관 동기화(플러그인 rcSync, plugins-next 기록에 있음)도 되살려야 상태 파일이 쓸모 있다.
const REMOTE_CONTROL = false;

// 웹·폰 원격과 Paseo 보관 상태 맞추기(리규형님 10-06 결정) — 플러그인 claude-state-bar 의 rcSync 가 읽던 상태 파일(10-10 rcSync 와 함께 끔).
// ~/.paseo/claude-rc-state/<Claude 대화 번호>.json = { sessionId, relayPid, startedAt, cse?, remoteArchivedAt?, exitedAt? }
// 대화 번호는 이어 띄울 때 --resume=<번호>, 새 대화면 Claude 가 내보내는 첫 session_id 에서 얻는다.
const STATE_DIR = legacyRcStateDir();
const argValue = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return null;
  return argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[i + 1] ?? null;
};
let sessionId = argValue("--resume") ?? argValue("--session-id");
let state = null;
const saveState = (patch) => {
  if (!REMOTE_CONTROL || ephemeral || !sessionId) return;
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

// 같은 창 계정 바꾸기(10-14, account.mjs): 이 대화를 다른 계정으로 바꿔 둔 기록이 있으면 그 계정으로 띄운다.
// 설정 폴더(CLAUDE_CONFIG_DIR)를 지정해 띄울 때는(PC 팀 공급자 · 팀으로 바꾼 대화) 팀 설정 동기화(claude-team-sync.js team)를 한 번 돌린다 —
// 순서는 바탕화면 세션이 만든 claude-team.cmd 와 같다. 동기화 없이 팀 폴더를 바로 지정했을 때 한 번 "로그인 안 됨"이 났다(10-14 실측, 원인 미확정).
// 동기화 스크립트는 PC 바탕화면 세션이 만든 Windows 도구(정션)라 Windows 에서만, 직원 데몬이 아닐 때만 돈다(10-18 Codex 261018_052815 D4).
// 리눅스에 CLAUDE_CONFIG_DIR 이 있어도 PC 정션 스크립트를 부르지 않는다 — 서버는 팀 계정이 토큰이라 원래 설정 폴더를 지정하지 않는다.
// 동기화가 실패해도 그대로 실행한다(claude-team.cmd 도 결과를 보지 않는다). 동기화 출력은 stderr 로만 — stdout 은 Paseo 와 claude 의 stream-json 통로다
const agentId = process.env.PASEO_AGENT_ID || null;
const childEnv = { ...process.env };
// 직원(울타리 안 팀원) 데몬이 띄운 Claude 면(10-18 Codex 261018_052815 C7) 화면 중복 막기·한글 디코더만 하고,
// 계정 바꾸기·넘김 안내·무중단 기록·자동 전환·계정 감시·PC 설정 동기화는 하지 않는다 — 일회성 실행(ephemeral)과 같은 자리에서 끈다
const staff = isStaffDaemon(process.env);
const account = ephemeral || staff ? null : applyAccount(childEnv, agentId);
if (!isStaffDaemon(process.env) && process.platform === "win32" && childEnv.CLAUDE_CONFIG_DIR) {
  const sync = spawnSync(process.execPath, [teamSyncScript(), "team"], {
    stdio: ["ignore", 2, 2],
    env: childEnv,
    windowsHide: true,
  });
  const failed = sync.error || sync.status !== 0;
  const why = failed ? (sync.error?.message ?? `exit ${sync.status}`) : "";
  log(`team account: settings sync ${failed ? `failed (${why})` : "ok"}`);
  if (failed) process.stderr.write(`claude-rc-relay: 설정 동기화 실패(${why}) — 그대로 실행합니다\n`);
}
if (account) log(`account ${account} (agent ${String(agentId).slice(0, 8)})`);
// 어느 계정으로 띄우는지 남긴다(값은 안 남긴다) — 서버 팀 토큰은 claude auth status 에 안 보이고 대화 안 명령 창에도 안 넘어가서
// 대화 안에서는 확인할 수 없었다(10-14). 계정 바꾸기가 의심될 때 이 줄로 본다
if (!ephemeral) log(`auth (agent ${String(agentId).slice(0, 8)}): team token ${childEnv.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "none"} · config dir ${childEnv.CLAUDE_CONFIG_DIR ? "set" : "default"}`);

// 자동 전환으로 꺼졌다 다시 뜨는 거라면 꺼지기 전 백그라운드 작업 목록을 첫 사람 말 앞에 한 번 붙인다(10-15 리규형님, rotation.mjs saveHandoff)
const handoff = ephemeral || staff ? null : takeHandoff(HOME, agentId);
const notice = handoff ? handoffNotice(handoff) : null;
if (handoff) log(`rotation handoff (agent ${String(agentId).slice(0, 8)}) — notice on next message, tasks=${handoff.tasks?.length ?? 0}`);
// 무중단 작업(10-16, workstate.mjs) — 이 실행기 세대·관측·넘김 이행을 claude-work/ 에 남긴다. 턴 끝 문지기와 감독자가 읽는다
const runGen = `${process.pid}-${Date.now()}`;
const work = workRecorder({ agentId, log, ephemeral: ephemeral || staff });
const rotation = createRotation({ real, env: childEnv, initialEnv: process.env, agentId, log, enabled: !ephemeral && !staff,
  handoff: (info) => saveHandoff(HOME, agentId, info), testFile: rotationTestFile(HOME),
  personalFile: personalSwitchFile(HOME),
  // 자동 전환은 무중단 등록 대화만(10-17 밤) — 판정마다 장부를 다시 읽는다
  registered: () => isRegistered(workRoot(), agentId),
  runGen, record: work.record, onTransition: work.onTransition });
// 직원 Claude 는 자기 홈(CLAUDE_CONFIG_DIR = /home/<아이디>/.claude)의 스킬·명령어·지침만 쓴다(10-20 리규형님 "각 홈에 있는 스킬만 —
// 넘겨받은 프로젝트에 있는 스킬을 쓰면 안 된다" · 프로젝트 지침도 함께 막기 버튼). Paseo 는 늘 --setting-sources=user,project,local 을
// 넘긴다 — 직원이면 그 자리를 user 하나로 바꿔 프로젝트 폴더의 .claude/skills·commands·settings.json 과 CLAUDE.md 를 읽지 않게 한다
// (10-20 PC 실측: user 면 셋 다 안 보이고 user,project,local 이면 셋 다 보인다). 값이 없으면 끝에 붙인다(Paseo 는 위치 인자를 쓰지 않는다)
if (staff) {
  const at = argv.findIndex((a) => a === "--setting-sources" || a.startsWith("--setting-sources="));
  if (at >= 0) argv.splice(at, argv[at] === "--setting-sources" ? 2 : 1, "--setting-sources=user");
  else argv.push("--setting-sources=user");
  log("staff: setting sources = user only (project skills·commands·settings·CLAUDE.md are not read)");
}
const child = spawn(real, argv, { stdio: ["pipe", "pipe", "inherit"], env: childEnv, windowsHide: true });
// 켜져 있는 동안 이 대화의 계정 기록이 바뀌면 Claude 를 끈다 — 다음 말 때 Paseo 가 이 실행기를 다시 띄우며 새 계정이 적용된다
const stopAccountWatch = ephemeral || staff
  ? () => {}
  : watchAccount(agentId, () => {
      log(`account changed (agent ${String(agentId).slice(0, 8)}) — stopping claude; the next message restarts it`);
      try {
        child.kill();
      } catch {
        /* 이미 끝남 */
      }
    });
child.on("exit", () => {
  stopAccountWatch();
  rotation.stop();
  // 자동 전환으로 꺼졌으면 다음 말을 기다리지 않고 이어 달린다(10-16, rotation.mjs startResumeKicker) — 손으로 바꾼 때는 안 한다.
  // 이행 파일에 다음 단계 주인을 남긴다 — kicker(pid 로 살아 있는지 본다), 못 띄웠으면 감독자가 넘겨받는다.
  // 일이 끝난 쉬는 틈의 넘김은 무중단 등록 대화만 깨운다(10-17 저녁, rotation.mjs shouldResume) — 그 밖엔 다음 사람 말을 기다린다
  const why = rotation.state().transition?.reason;
  if (rotation.state().switched && !shouldResume({ reason: why, registered: isRegistered(workRoot(), agentId) })) {
    log(`rotation switched at an idle point (${why}) — not waking (agent ${String(agentId).slice(0, 8)}); the next message starts the new account`);
    rotation.updateTransition({ state: "next_message", owner: "relay", relayExitAt: new Date().toISOString() });
  } else if (rotation.state().switched) {
    const kicker = startResumeKicker({ agentId, home: HOME, logFile: LOG, tid: rotation.state().transition?.tid ?? "" });
    if (kicker) log(`rotation resume armed (agent ${String(agentId).slice(0, 8)})`);
    rotation.updateTransition(kicker ? { owner: "kicker", kickerPid: kicker.pid ?? null, relayExitAt: new Date().toISOString() }
      : { owner: "supervisor", why: "kicker-not-started", relayExitAt: new Date().toISOString() });
  }
  work.flush();
});
child.on("error", (e) => {
  log(`spawn failed: ${e.message}`);
  process.stderr.write(`claude-rc-relay: cannot start ${real}: ${e.message}\n`);
  process.exit(127);
});

// Paseo → claude: 바이트는 그대로 넘기고, 줄을 훑어 초기화 요청 번호만 기억한다.
// 넘겨받은 안내가 있으면 첫 사람 말 줄에 붙인다(rotation.mjs noticeForwarder)
// 흐름 제어(옛 팀 실행기의 pause/drain 계약 — 10-18 Codex D3): claude 가 입력을 못 따라오면 Paseo 쪽 입력을 멈췄다가 비면 다시 받는다.
// 안 하면 받은 입력이 이 프로세스 메모리에 끝없이 쌓인다. 기다리는 drain 은 하나만 건다(한 조각이 여러 번 써져도 리스너가 쌓이지 않게)
let initId = null;
let inBuf = "";
let inputPaused = false;
const toChild = (data) => {
  if (child.stdin.write(data) || inputPaused) return;
  inputPaused = true;
  process.stdin.pause();
  child.stdin.once("drain", () => {
    inputPaused = false;
    process.stdin.resume();
  });
};
const rotationInput = jsonLines(rotation.input);
const forward = noticeForwarder(notice, toChild, () => log("rotation handoff notice added to the next message"));
process.stdin.on("data", (chunk) => {
  rotationInput.write(chunk);
  forward.write(chunk);
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
process.stdin.on("end", () => {
  rotationInput.end();
  forward.end();
  child.stdin.end();
});
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
  try { rotation.observe(JSON.parse(line)); } catch { /* JSON 이 아닌 출력 */ }
  if (!sessionId) {
    const m = /"session_id":"([0-9a-f-]{36})"/.exec(line);
    if (m) {
      sessionId = m[1];
      saveState({});
    }
  }
  // 아래 두 줄 거르기는 Remote Control 을 켰을 때만 — 꺼져 있으면 우리가 요청을 안 보내 걸러야 할 줄이 없다(10-18 Codex A절 반례:
  // 꺼져 있어도 글자만 보고 버려서, 도구 입력에 "bridge_state" 가 든 정상 assistant 줄이 Paseo 에 안 갔다). 다시 켜면 글자 검색 말고
  // 실제 control_response·system 줄 종류와 request_id 로 가려야 한다
  if (REMOTE_CONTROL && line.includes(RC_ID)) {
    const ok = line.includes('"subtype":"success"');
    log(ok ? "remote control on" : `remote control failed: ${line.slice(0, 300)}`);
    const cse = /"bridge_session_id":"(cse_[A-Za-z0-9]+)"/.exec(line);
    if (ok && cse) saveState({ cse: cse[1] });
    return false;
  }
  if (REMOTE_CONTROL && line.includes('"bridge_state"')) {
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
    if (!REMOTE_CONTROL) {
      sent = true;
      log("remote control off (10-10 decision) — not enabling");
    } else if (ephemeral) {
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
// Paseo 화면 중복 막기(10-05) — 까닭과 방법은 assistant-fix.mjs. 팀 공급자도 이 실행기로 뜨므로 모든 대화에 적용된다(10-18)
const fixAssistant = createAssistantFix();
// 조각 경계에서 잘린 한글이 깨지지 않게 디코더로 이어 붙인다.
// 흐름 제어(옛 팀 실행기의 pause/drain 계약 — 10-18 Codex D3): Paseo 가 출력을 못 따라오면(쓰기가 false) claude 출력 읽기를 멈추고,
// 비면(drain) 다시 읽는다. Windows 에선 파이프 쓰기가 비동기라 안 멈추면 큰 출력이 이 프로세스 메모리에 다 쌓인다
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
  if (pass && !process.stdout.write(pass)) child.stdout.pause();
});
process.stdout.on("drain", () => child.stdout.resume());
child.stdout.on("end", () => {
  outBuf += decoder.end();
  if (outBuf && handleLine(outBuf)) process.stdout.write(fixAssistant(outBuf));
  outBuf = "";
});

child.on("close", (code, signal) => {
  log(`exit code=${code} signal=${signal}`);
  saveState({ exitedAt: new Date().toISOString() });
  work.flush();
  process.exitCode = code ?? 1;
  process.stdout.write("", () => process.exit(code ?? 1));
});
// SIGBREAK = Windows 콘솔 Ctrl+Break(옛 팀 실행기에서 옮김, 10-18). 리눅스 node 에선 보통 이벤트 이름으로만 등록되고 오류가 없다
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 이미 끝남 */
    }
  });
}
