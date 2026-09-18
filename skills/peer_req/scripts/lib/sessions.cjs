//
// sessions.cjs — 짝 세션 찾기 (기획서 D20·C1·D21)
//
// ■ 같은 머신 — 세션 번호(sessionId)로 찾는다 (D20)
//   VS Code 세션은 /rename 을 해도 재시작하면 같은 머신 안 이름이 자동 이름으로 돌아간다
//   (2026-09-19 서버 실측). 이름은 매번 바뀌지만 sessionId 는 재시작해도 같다.
//   그래서 "이 짝 = 이 sessionId" 를 머신 상태에 적어 두고, 보낼 때마다 등록 파일에서
//   그 번호의 **지금 이름**을 찾는다.
//     ① 적어 둔 번호가 살아 있으면 그것
//     ② 없으면 짝 root 아래에서 도는 세션 — 1개면 그것으로 보내고 적어 둔다(자동)
//     ③ 0개·2개 이상이면 사용자에게 묻고, 알려 준 것을 적어 둔다
//   (②의 자동 선택은 사용자 결정 — "짝은 실무에서 무작위로 생기지 않는다")
//
//   🔴 등록 파일 ~/.claude/sessions/<pid>.json 은 공식 문서에 없는 내부 형식이다.
//      Claude Code 업데이트로 모양이 바뀌면 읽기를 포기하고 ③(사용자에게 묻기)으로 떨어진다.
//      절대 짐작으로 고르지 않는다.
//
// ■ 다른 머신 — Remote Control 제목으로 찾는다 (C1)
//   정확히 같은 제목, 또는 끝에 " · 숫자" 가 붙은 것만 후보다. 부분 일치 금지.
//   후보가 여럿이면 가장 큰 순번을 고르지 않는다 — 사용자에게 묻는다.
//
// ■ RC 연결 판정 (D21)
//   다른 머신 세션은 **이 세션이 RC 에 연결돼 있을 때만** 목록에 보인다(공식 문서).
//   그래서 목록에 Remote Control 행이 있으면 연결된 것이다. 등록 파일의 bridgeSessionId 는
//   참고일 뿐 연결 증거가 아니다(끊겨도 남을 수 있다).
//

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');
const ab = require('./addressbook.cjs');

// ───────────────────────── 등록 파일 ─────────────────────────

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0 || Math.floor(pid) !== pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 남의 권한 프로세스여도 살아는 있다
  }
}

// 반환: { readable, sessions:[{pid,sessionId,cwd,name,status,kind,bridge}] }
function readRegistry() {
  const dir = path.join(util.claudeHome(), 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch (e) {
    return { readable: false, sessions: [], reason: dir + ' 를 읽지 못했다' };
  }
  const sessions = [];
  let malformed = 0;
  names.forEach((n) => {
    const j = util.readJson(path.join(dir, n), null);
    if (!j || typeof j.sessionId !== 'string' || typeof j.cwd !== 'string' || typeof j.name !== 'string') {
      malformed++;
      return;
    }
    if (!pidAlive(j.pid)) return;
    sessions.push({
      pid: j.pid,
      sessionId: j.sessionId,
      cwd: j.cwd,
      name: j.name,
      status: j.status || null,
      kind: j.kind || null,
      bridge: j.bridgeSessionId || null,
    });
  });
  // 파일은 있는데 전부 모양이 다르면 형식이 바뀐 것이다 — 읽을 수 없다고 본다
  if (names.length > 0 && malformed === names.length) {
    return { readable: false, sessions: [], reason: '등록 파일 형식이 예상과 다르다(Claude Code 업데이트?)' };
  }
  return { readable: true, sessions: sessions };
}

// ───────────────────────── 선언(머신 상태) ─────────────────────────
// 짝마다 파일 하나 — 두 세션이 동시에 서로 다른 짝을 기록해도 한쪽이 사라지지 않는다(리뷰 P2).

function declaredDir() {
  return path.join(util.stateDir(), 'declared');
}

function declaredFile(endpointId) {
  if (!ab.ID_RE.test(endpointId || '')) throw new Error('endpoint_id 형식 오류: ' + endpointId);
  return path.join(declaredDir(), endpointId + '.json');
}

function readDeclared() {
  const out = { version: 2, endpoints: {} };
  let names = [];
  try {
    names = fs.readdirSync(declaredDir()).filter((n) => /\.json$/.test(n));
  } catch (e) {
    return out;
  }
  names.forEach((n) => {
    const j = util.readJson(path.join(declaredDir(), n), null);
    if (j && j.session_id) out.endpoints[n.replace(/\.json$/, '')] = j;
  });
  return out;
}

// source: here(받는 대화에서 직접) · auto(후보 1개 자동) · user(사용자가 골라 줌)
function declare(endpointId, o) {
  const rec = { session_id: o.sessionId, root: o.root, name_at_bind: o.name || null, source: o.source, bound_at: util.nowIso() };
  util.writeJsonAtomic(declaredFile(endpointId), rec);
  return rec;
}

function forget(endpointId) {
  const f = declaredFile(endpointId);
  const had = fs.existsSync(f);
  util.unlinkQuiet(f);
  return had;
}

// ───────────────────────── ListAgents 출력 파싱 ─────────────────────────

// ListAgents 결과 원문 → { self, rows:[{name,ref,kind,status,where}] }
//   where: local(같은 머신) · remote(Remote Control) · cloud
function parseAgents(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const selfM = src.match(/This session is (.+?) \[([0-9a-z]+)\]/);
  const rows = [];
  const re = /^\s+(.+?) \[([0-9a-z]+)\]\s+·\s+(.+?)\s+·\s+([A-Za-z]+)/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const kind = m[3].trim();
    const where = /^remote control$/i.test(kind) ? 'remote' : /^cloud$/i.test(kind) ? 'cloud' : 'local';
    rows.push({ name: m[1].trim(), ref: m[2], kind: kind, status: m[4], where: where });
  }
  return { self: selfM ? { name: selfM[1].trim(), ref: selfM[2] } : null, rows: rows };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleMatches(title, base, acceptSuffix) {
  if (title === base) return true;
  if (acceptSuffix === false) return false;
  return new RegExp('^' + escapeRe(base) + ' · \\d+$').test(title);
}

// 이름이 목록에 몇 번 나오나 → SendMessage 의 to 값(동명이 있으면 "이름 [ref]")
function addressFor(rows, row) {
  const same = rows.filter((r) => r.name === row.name);
  return same.length > 1 ? row.name + ' [' + row.ref + ']' : row.name;
}

function withSendTo(rows, r) {
  return Object.assign({ send_to: addressFor(rows, r) }, r);
}

// ───────────────────────── 회신 주소 다시 찾기 ─────────────────────────

// 받은 from(uds:…)이 막혔을 때 — 같은 머신의 보낸 쪽 세션은 재시작하면 주소가 바뀐다(실측).
// 보낸 쪽 저장소(sender_root) 아래에서 도는 세션을 찾아 지금 이름을 돌려준다.
function findReplyTarget(o) {
  const reg = o.registry || readRegistry();
  if (!reg.readable) return { status: 'ask', reason: '세션 등록 파일을 읽을 수 없다(' + reg.reason + ')', candidates: [] };
  const localRows = o.agents.rows.filter((r) => r.where === 'local');
  const cands = reg.sessions
    .filter((s) => s.sessionId !== o.selfSessionId && util.isUnder(s.cwd, o.senderRoot))
    .map((s) => {
      const rows = localRows.filter((r) => r.name === s.name);
      return { session_id: s.sessionId, name: s.name, cwd: s.cwd, status: s.status, send_to: rows.length === 1 ? rows[0].name : null };
    });
  const sendable = cands.filter((c) => c.send_to);
  if (sendable.length === 1) return { status: 'ready', send_to: sendable[0].send_to, session_id: sendable[0].session_id };
  if (cands.length === 0) return { status: 'unreachable', reason: '보낸 쪽 저장소(' + o.senderRoot + ')에서 도는 세션이 없다 — 닫혔다' };
  return { status: 'ask', reason: '보낸 쪽 저장소에서 도는 세션이 ' + cands.length + '개다', candidates: cands };
}

// ───────────────────────── 대상 결정 ─────────────────────────

// 한 짝의 전송 대상을 정한다.
//   반환 status: ready(보내면 된다) · ask(사용자에게 물어야 한다) · unreachable(목록에 짝 세션이 없다)
function resolvePeer(o) {
  const book = o.book;
  const peer = ab.peersOf(book)[o.alias];
  const agents = o.agents;
  const same = peer.machine_id === book.self.machine_id;
  const out = { alias: o.alias, endpoint_id: peer.endpoint_id, same_machine: same };
  const make = (extra) => Object.assign({}, out, extra);

  if (!same) {
    const sel = peer.session_selector || {};
    const cands = agents.rows.filter((r) => r.where === 'remote' && titleMatches(r.name, sel.rc_title, sel.accept_numeric_suffix));
    if (cands.length === 1) return make({ status: 'ready', via: 'rc_title', send_to: addressFor(agents.rows, cands[0]), row: cands[0] });
    if (cands.length === 0) {
      const rcVisible = agents.rows.some((r) => r.where === 'remote');
      return make({
        status: 'unreachable',
        reason: rcVisible
          ? 'Remote Control 목록에 제목 "' + sel.rc_title + '" 인 세션이 없다'
          : '목록에 다른 머신 세션이 하나도 없다 — 이 세션의 Remote Control 이 꺼져 있을 가능성이 크다',
        rc_visible: rcVisible,
      });
    }
    return make({ status: 'ask', reason: '제목 "' + sel.rc_title + '" 후보가 ' + cands.length + '개다', candidates: cands.map((r) => withSendTo(agents.rows, r)) });
  }

  // 같은 머신
  const reg = o.registry || readRegistry();
  const localRows = agents.rows.filter((r) => r.where === 'local');
  const toLocal = (s) => {
    const rows = localRows.filter((r) => r.name === s.name);
    if (rows.length === 1) return { send_to: rows[0].name, row: rows[0] };
    return null; // 목록에 없거나 같은 이름이 여럿 → 짐작하지 않는다
  };
  const asCandidates = (list) => list.map((s) => ({ session_id: s.sessionId, name: s.name, cwd: s.cwd, status: s.status, in_list: !!toLocal(s) }));

  if (!reg.readable) {
    return make({ status: 'ask', reason: '세션 등록 파일을 읽을 수 없다(' + reg.reason + ') — 목록에서 사용자에게 고르게 한다', candidates: localRows.map((r) => withSendTo(agents.rows, r)) });
  }
  const live = reg.sessions.filter((s) => s.sessionId !== o.selfSessionId);

  const dec = readDeclared().endpoints[peer.endpoint_id];
  let note = null;
  if (dec) {
    const hit = live.filter((s) => s.sessionId === dec.session_id);
    if (hit.length === 1) {
      const t = toLocal(hit[0]);
      if (t) return make(Object.assign({ status: 'ready', via: 'declared', session_id: hit[0].sessionId }, t));
      return make({ status: 'ask', reason: '기록해 둔 세션(' + hit[0].name + ')이 ListAgents 목록에서 하나로 특정되지 않는다', candidates: asCandidates(hit) });
    }
    if (hit.length > 1) return make({ status: 'ask', reason: '기록해 둔 세션 번호로 도는 프로세스가 여럿이다', candidates: asCandidates(hit) });
    note = '기록해 둔 세션(' + (dec.name_at_bind || dec.session_id) + ')은 지금 떠 있지 않다';
  }

  const cands = live.filter((s) => util.isUnder(s.cwd, peer.location.root));
  if (cands.length === 1) {
    const t = toLocal(cands[0]);
    if (t) return make(Object.assign({ status: 'ready', via: 'auto', session_id: cands[0].sessionId, bind: true, note: note }, t));
    return make({ status: 'ask', reason: '후보(' + cands[0].name + ')가 ListAgents 목록에서 하나로 특정되지 않는다', note: note, candidates: asCandidates(cands) });
  }
  if (cands.length === 0) {
    return make({ status: 'ask', reason: '짝 폴더(' + peer.location.root + ')에서 도는 세션을 찾지 못했다', note: note, candidates: asCandidates(live) });
  }
  return make({ status: 'ask', reason: '짝 폴더에서 도는 세션이 ' + cands.length + '개다', note: note, candidates: asCandidates(cands) });
}

module.exports = { readRegistry, readDeclared, declare, forget, parseAgents, titleMatches, findReplyTarget, resolvePeer, addressFor };
