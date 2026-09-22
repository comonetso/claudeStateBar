//
// title.cjs — 시작 훅이 붙이는 세션 제목의 순번 (2026-09-22 요청)
//
// 같은 프로젝트를 VS Code 창 두 개로 열면 두 세션이 똑같이 "기기 · 프로젝트" 가 되어, 폰·웹 목록에서도
// 짝 찾기의 rc_title 매칭에서도 구분이 안 됐다. 그래서 살아 있는 세션 중 같은 제목이 있으면 번호를 붙인다.
//   기기 · 프로젝트        같은 제목(뒤에 " · 숫자" 포함)의 살아 있는 세션이 없을 때
//   기기 · 프로젝트 · N    있으면 가장 큰 번호 + 1. 순번 없는 제목을 1로 세므로 번호는 2부터다
//
// 🔴 형식은 전역 ~/.claude/scripts/rc_title.js 와 똑같아야 한다(구분자 " · ", ruleRe·nextSeq 도 같은 식).
//    어긋나면 그 스크립트가 규칙 제목으로 못 알아봐서 /start 때마다 사용자에게 묻는다.
//
// 세션 목록은 rc_title.js 와 같은 곳에서 읽는다 — Claude Code 가 쓰는 내부 엔드포인트라 공식 기능이 아니고,
// 로그인 토큰은 ~/.claude/.credentials.json 에만 있다고 본다(파일이 없는 macOS 키체인·환경변수 토큰이면 못 읽는다).
// 사용자 결정(2026-09-22):
//   · 조회는 최대 2초 기다린다 — 실측 한 번 0.45~0.64초(이 PC, 5회)
//   · 조회가 안 되면(토큰 없음·실패·2초 넘김) 순번 없이 붙인다 — 0.2.0 과 같은 동작
//   · 창 여러 개를 거의 동시에 열어 같은 번호를 받는 것은 감수한다 — /start 의 rc_title.js 가 겹침을 다시 매긴다
//
// Node 버전에 기대지 않는다 — util.cjs 머리말 참고(fetch 대신 http/https 모듈).
//

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');

const SESSIONS_API = 'https://api.anthropic.com/v1/code/sessions?limit=100';
const LIST_TIMEOUT_MS = 2000;

// rc_title.js 와 같은 식이다 — 한쪽만 고치지 마라
function ruleRe(base) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc + '(?:\\s*·\\s*(\\d+))?$');
}

function nextSeq(base, sessions) {
  const re = ruleRe(base);
  let max = 0;
  for (let i = 0; i < sessions.length; i++) {
    const m = String((sessions[i] && sessions[i].title) || '').match(re);
    if (m) max = Math.max(max, m[1] ? parseInt(m[1], 10) : 1);
  }
  return max + 1;
}

function withSeq(base, n) {
  return n > 1 ? base + ' · ' + n : base;
}

function accessToken() {
  const c = util.readJson(path.join(util.claudeHome(), '.credentials.json'), null);
  const t = c && c.claudeAiOauth && c.claudeAiOauth.accessToken;
  return typeof t === 'string' && t ? t : null;
}

// 이 세션의 Remote Control 세션 ID(목록의 id 와 같은 cse_ 형식). 훅 시점에는 대개 아직 없다 — RC 는 세션이 뜬 뒤에 붙는다.
function selfRemoteId(sessionId) {
  if (!sessionId) return null;
  const dir = path.join(util.claudeHome(), 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch (e) {
    return null;
  }
  for (let i = 0; i < names.length; i++) {
    const j = util.readJson(path.join(dir, names[i]), null);
    if (j && j.sessionId === sessionId && typeof j.bridgeSessionId === 'string') return j.bridgeSessionId.replace(/^session_/, 'cse_');
  }
  return null;
}

// GET → 세션 배열. 실패·200 아님·시간 초과는 null. 어떤 경우에도 reject 하지 않는다.
function listSessions(url, token, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      finish(null);
      if (req) req.destroy();
    }, timeoutMs);
    try {
      const u = new URL(url);
      const mod = u.protocol === 'http:' ? require('http') : require('https');
      req = mod.get(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          headers: {
            Authorization: 'Bearer ' + token,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode !== 200) return finish(null);
            try {
              const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const list = (j && (j.sessions || j.data)) || (Array.isArray(j) ? j : null);
              finish(Array.isArray(list) ? list : null);
            } catch (e) {
              finish(null);
            }
          });
          res.on('error', () => finish(null));
        }
      );
      req.on('error', () => finish(null));
    } catch (e) {
      finish(null);
    }
  });
}

// base("기기 · 프로젝트")에 순번을 붙인 제목. 조회가 안 되면 base 그대로. reject 하지 않는다.
// url·timeoutMs 는 테스트용 — 훅은 넘기지 않는다.
function numberedTitle(base, sessionId, url, timeoutMs) {
  const token = accessToken();
  if (!token) return Promise.resolve(base);
  return listSessions(url || SESSIONS_API, token, timeoutMs || LIST_TIMEOUT_MS).then(
    (list) => {
      if (!list) return base;
      const self = selfRemoteId(sessionId);
      const others = list.filter((s) => s && s.status !== 'archived' && (s.id || s.uuid) !== self);
      return withSeq(base, nextSeq(base, others));
    },
    () => base
  );
}

module.exports = { SESSIONS_API, LIST_TIMEOUT_MS, ruleRe, nextSeq, withSeq, listSessions, numberedTitle };
