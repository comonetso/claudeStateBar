#!/usr/bin/env node
//
// guard-addressbook.cjs — PreToolUse 훅: 다른 저장소의 주소록(.peer_req.json)을 Write·Edit 로 고치지 못하게 한다
//
// 2026-09-21 사용자 결정. 사고: 같은 PC 의 세 세션이 "짝이 안 맞네, 맞춰 주자" 며 서로의 self 를 고쳐
// 이름이 연쇄로 꼬였다. 주소록의 self 는 그 저장소 세션만 쓴다 — 상대 주소록은 읽기만 한다.
//
//   · 이 세션 저장소의 주소록은 통과 — 위치 = cwd 에서 위로 찾은 주소록 폴더, 없으면 git 루트, 그것도 없으면 cwd
//   · 다른 폴더의 .peer_req.json 이면 거부하고, 이유를 Claude 에게 알린다(permissionDecisionReason 은 Claude 가 본다)
//   · 🔴 셸 명령(sed 등)으로 고치는 것은 막지 못한다 — SKILL 의 규칙과 doctor 교차 대조가 함께 막는다
//   · 사람이 편집기로 직접 고치는 것은 막지 않는다(이 훅은 Claude 의 도구 호출에만 걸린다)
//
// 훅 설정의 `if` 조건(권한 규칙 문법)은 쓰지 않는다 — 경로 패턴이 프로젝트 기준이라 프로젝트 밖의 남의 주소록을
// 놓칠 수 있다. 대신 이 스크립트가 파일 이름부터 보고 아니면 바로 끝낸다.
// 판정할 수 없으면(입력이 이상하다) 통과시킨다 — 이 훅 때문에 평범한 편집이 막히면 안 된다.
// Node 버전에 기대지 않는다 — lib/util.cjs 머리말 참고.
//

'use strict';

const fs = require('fs');
const path = require('path');
const ab = require('./lib/addressbook.cjs');
const util = require('./lib/util.cjs');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    return null;
  }
}

function isBookFile(file) {
  return typeof file === 'string' && path.basename(file).toLowerCase() === ab.BOOK_NAME;
}

// 이 세션의 저장소 루트
function ownRoot(cwd) {
  const f = ab.findBook(cwd);
  if (f) return path.dirname(f);
  const r = util.runExe('git', ['rev-parse', '--show-toplevel'], { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status === 0 && String(r.stdout).trim()) return String(r.stdout).trim();
  return cwd;
}

function main() {
  const input = readStdin();
  if (!input) return;
  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (!isBookFile(file)) return;
  const cwd = input.cwd || process.cwd();
  const own = ownRoot(cwd);
  if (util.samePath(path.dirname(file), own)) return;
  const reason = [
    'peer_req: 다른 저장소의 주소록(' + file + ')은 고치지 않는다. 주소록의 self 는 그 저장소 세션만 쓴다(이 세션의 저장소: ' + own + ').',
    '짝이 어긋나 보이면 `peer.cjs doctor` 결과를 사용자에게 보여 주고, 그 저장소의 세션에서 고치게 하라. 셸 명령으로 우회하지 마라.',
  ].join(' ');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

try {
  main();
} catch (e) {
  // 훅 실패로 편집을 막지 않는다
}
process.exit(0);
