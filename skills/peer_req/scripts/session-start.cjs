#!/usr/bin/env node
//
// session-start.cjs — SessionStart 훅 (TODO I7 · 기획서 D7·D21·C8)
//
// 하는 일
//   1. "peer_req 로드됨" 을 사용자에게 알린다
//   2. Remote Control 자동 켜기 설정(remoteControlAtStartup)을 본다 — 꺼져 있으면 켜는 법을 안내한다.
//      설정을 대신 바꾸지 않는다.
//   3. 이 저장소에 주소록이 있으면 짝 요약과 "알리지 않은 요청·결과 N건" 을 보고한다
//   4. 세션 제목이 없으면 "기기 · 프로젝트" 로 붙인다(2026-09-21 사용자 결정) — 공식 출력 sessionTitle(`/rename` 과 같다).
//      다른 머신의 짝을 목록에서 알아보기 쉬워진다. 사람이 지은 제목이 있으면(session_title) 건드리지 않는다.
//      🔴 Claude Code 2.1.278 은 제목이 없으면 session_title 칸을 **아예 보내지 않는다**(설치본 `session_title:s??pd(id)`,
//      없으면 undefined — Codex 리뷰가 찾았다). 그래서 칸이 없을 때는 버전을 보고, 확인한 2.1.278 이상일 때만
//      "제목 없음" 으로 본다. 그보다 낮거나 버전을 모르면 사람 제목이 있을지 몰라 붙이지 않는다(2026-09-22 사용자 결정).
//      같은 제목의 살아 있는 세션이 있으면 " · 2" 처럼 순번을 붙인다(0.2.1) — 형식·기다리는 시간·실패 처리는 lib/title.cjs.
//
// 🔴 알림을 두 갈래로 싣는다 (D21)
//   · systemMessage      → 사용자 화면용. VS Code 확장에서 보이는지는 아직 확인 못 했다
//   · additionalContext  → Claude 문맥. "첫 응답 끝에 한 줄 알려라" — 이쪽은 확실히 전달된다
//
// 🔴 훅에서 RC 연결 여부를 판정하지 않는다. RC 는 세션이 뜬 **뒤에** 붙는다(사용자 관측).
//    실제 연결 판정은 보내기 직전 ListAgents 로 한다.
//
// 이 훅이 실패해도 세션은 떠야 한다 — 어떤 예외든 삼키고 0 으로 끝낸다.
// Node 버전에 기대지 않는다 — lib/util.cjs 머리말 참고.
//

'use strict';

const fs = require('fs');
const path = require('path');
const ab = require('./lib/addressbook.cjs');
const store = require('./lib/store.cjs');
const state = require('./lib/state.cjs');
const ingest = require('./lib/ingest.cjs');
const titles = require('./lib/title.cjs');
const util = require('./lib/util.cjs');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

// 설정의 language → LANG → OS 로캘 순. Windows 는 LANG 이 보통 없어서 로캘까지 본다.
function isKorean(settings) {
  let locale = '';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch (e) {
    locale = '';
  }
  const lang = String(settings.language || process.env.LANG || locale).toLowerCase();
  return lang.indexOf('ko') === 0 || lang.indexOf('korean') !== -1 || lang.indexOf('한국') !== -1;
}

// 프로젝트 이름 — .vscode/settings.json 의 window.title(창 제목과 맞춘다), 없거나 ${…} 변수가 섞였으면 폴더 이름.
// JSONC(주석·끝 쉼표)일 수 있어 JSON.parse 대신 그 키만 뽑는다. 앞의 정렬용 번호("1. ")는 뗀다.
function projectLabel(dir) {
  const leaf = path.basename(String(dir).replace(/[\\/]+$/, '')) || String(dir);
  try {
    const raw = fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8');
    const m = raw.match(/"window\.title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      const v = m[1].replace(/\\(.)/g, '$1').trim().replace(/^\d+\.\s*/, '');
      if (v && v.indexOf('${') === -1) return v;
    }
  } catch (e) {
    // 없으면 폴더 이름
  }
  return leaf;
}

// 제목 칸이 없을 때 "제목 없음" 으로 믿어도 되는 Claude Code 버전 — 실제로 확인한 버전이다(근거 없는 값이 아니다)
const TITLE_ABSENT_MEANS_NONE_SINCE = [2, 1, 278];

function parseVersion(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

// 이 세션의 Claude Code 버전 — ① 세션 등록 파일(~/.claude/sessions/<pid>.json, 비공식)의 version
// ② CLAUDE_CODE_EXECPATH 의 "claude-code-<버전>"(VS Code 확장의 실행 파일 경로). 둘 다 없으면 모른다.
function claudeVersion(sessionId) {
  const dir = path.join(util.claudeHome(), 'sessions');
  if (sessionId) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch (e) {
      names = [];
    }
    for (let i = 0; i < names.length; i++) {
      const j = util.readJson(path.join(dir, names[i]), null);
      if (j && j.sessionId === sessionId && parseVersion(j.version)) return parseVersion(j.version);
    }
  }
  const m = String(process.env.CLAUDE_CODE_EXECPATH || '').match(/claude-code-(\d+\.\d+\.\d+)/);
  return m ? parseVersion(m[1]) : null;
}

// 붙일 제목의 바탕("기기 · 프로젝트"), 붙이지 않을 때는 null. 순번은 main 이 lib/title.cjs 로 붙인다.
function autoTitle(input, root) {
  const title = util.deviceName() + ' · ' + projectLabel(root);
  if (typeof input.session_title === 'string') return input.session_title.trim() ? null : title;
  const v = claudeVersion(input.session_id);
  return v && atLeast(v, TITLE_ABSENT_MEANS_NONE_SINCE) ? title : null;
}

function pendingItems(root) {
  const items = [];
  store.listRequestIds(root).forEach((id) => {
    const dir = store.requestDir(root, id);
    const rec = store.readRequestRecord(dir);
    if (!rec) return;
    const states = state.fold(store.listEvents(dir));
    Object.keys(states).forEach((who) => {
      const st = states[who];
      if (!state.needsAttention(rec.direction, st)) return;
      items.push({ id: id.slice(0, 8), direction: rec.direction, peer: rec.direction === 'inbound' ? rec.envelope.sender_endpoint : who, state: st.state });
    });
  });
  return items;
}

function main() {
  if (process.env.PEER_REQ_UNATTENDED === '1') return; // 무인 실행 — 답에 알림이 섞이면 안 된다
  // 비대화형(claude -p·SDK) 세션 — 스크립트가 받는 답에 "로드됨" 이 섞였다(2026-09-19 서버 실측).
  // 그 세션의 진입점은 sdk-cli 다(대화형 cli · VS Code claude-vscode).
  if (/^sdk-/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '')) return;
  const input = readStdin();
  const source = input.source || 'startup';
  if (source !== 'startup' && source !== 'resume') return; // /clear·compact 때는 조용히
  const cwd = input.cwd || process.cwd();
  const settings = util.readJson(path.join(util.claudeHome(), 'settings.json'), {});
  const ko = isKorean(settings);
  const rcOn = settings.remoteControlAtStartup === true;
  // 이 플러그인이 나온 마켓(comonetso)의 자동 업데이트 — Anthropic 밖 마켓은 기본으로 꺼져 있다
  const mk = settings.extraKnownMarketplaces && settings.extraKnownMarketplaces.comonetso;
  const autoUpdateOn = !!(mk && mk.autoUpdate === true);

  const b = ab.loadBook(cwd);
  let peersLine = null;
  let bookProblem = null;
  let items = [];
  if (b.found && b.ok) {
    const names = Object.keys(ab.peersOf(b.book));
    if (names.length) peersLine = ko ? '짝 ' + names.length + '곳(' + names.join(', ') + ')' : names.length + ' peer(s): ' + names.join(', ');
    else peersLine = ko ? '받기 전용' : 'receive-only';
    try {
      ingest.syncFromPeerRecords(b.root, b.book);
    } catch (e) {
      // 따라잡기 실패는 보고를 막지 않는다
    }
    items = pendingItems(b.root);
  } else if (b.found) {
    bookProblem = b.errors[0];
  }

  // 버전을 알림에 싣는다 — 자동 업데이트가 실제로 왔는지 화면에서 바로 보이게
  const ver = util.readJson(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), {}).version;
  const vtag = ver ? ' ' + ver : '';
  const parts = [ko ? 'peer_req' + vtag + ' 로드됨' : 'peer_req' + vtag + ' loaded'];
  if (peersLine) parts.push(peersLine);
  if (items.length) parts.push(ko ? '알리지 않은 요청·결과 ' + items.length + '건' : items.length + ' unreported request(s)/result(s)');
  if (!rcOn) parts.push(ko ? '⚠️ Remote Control 자동 켜기 꺼짐' : '⚠️ Remote Control auto-connect is off');
  if (!autoUpdateOn) parts.push(ko ? '자동 업데이트 꺼짐' : 'auto-update is off');
  if (bookProblem) parts.push(ko ? '⚠️ 주소록 오류: ' + bookProblem : '⚠️ address book error: ' + bookProblem);
  const line = parts.join(' · ');

  const ctx = [
    '[peer_req] 플러그인이 로드됐다. 이번 세션의 **첫 응답 끝에** 사용자에게 아래 한 줄을 사용자의 언어로 알려라. 이미 알렸으면 반복하지 마라.',
    '  → ' + line,
  ];
  if (!rcOn) {
    ctx.push(
      '[peer_req] ~/.claude/settings.json 에 "remoteControlAtStartup": true 가 없다. 다른 머신의 짝과는 Remote Control 로만 통신한다.',
      '  사용자가 peer_req 를 쓰려 할 때 켜는 법을 안내하라: /config 의 "Enable Remote Control for all sessions" 또는 settings.json 에 "remoteControlAtStartup": true. 설정을 대신 바꾸지 마라.'
    );
  }
  if (!autoUpdateOn) {
    ctx.push(
      '[peer_req] 이 플러그인의 마켓(comonetso)에 자동 업데이트가 꺼져 있어 새 버전이 저절로 오지 않는다. 첫 응답의 알림 줄에서 켜는 법을 한 줄로 덧붙여라:',
      '  ~/.claude/settings.json 의 "extraKnownMarketplaces": { "comonetso": { "source": { "source": "github", "repo": "comonetso/claudeStateBar" }, "autoUpdate": true } } (Claude State Bar 확장을 쓰면 알림의 [켜기] 한 번). 설정을 대신 바꾸지 마라.'
    );
  }
  if (items.length) {
    ctx.push('[peer_req] 사용자에게 아직 알리지 않은 요청·결과:');
    items.slice(0, 10).forEach((it) => ctx.push('  - ' + (it.direction === 'inbound' ? '받음' : '보냄') + ' ' + it.id + ' · ' + it.peer + ' · ' + it.state));
    ctx.push('  자세한 내용은 peer-req:peer_req 스킬의 inbox 절차로 확인한다(알린 뒤 --mark-reported).');
  }

  const out = { hookEventName: 'SessionStart', additionalContext: ctx.join('\n') };
  const base = autoTitle(input, b.found ? b.root : cwd);
  // 제목을 붙일 때만 목록을 조회한다 — 사람이 지은 제목이 있으면 네트워크를 쓰지 않는다
  return (base ? titles.numberedTitle(base, input.session_id) : Promise.resolve(null)).then((title) => {
    if (title) out.sessionTitle = title;
    return new Promise((resolve) => {
      process.stdout.write(JSON.stringify({ systemMessage: line, hookSpecificOutput: out }), () => resolve());
    });
  });
}

// 훅 실패로 세션을 막지 않는다 — 어떤 예외든 삼키고 0 으로 끝낸다
const exit = () => process.exit(0);
let running;
try {
  running = main();
} catch (e) {
  running = null;
}
Promise.resolve(running).then(exit, exit);
