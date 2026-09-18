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
// ■ 다른 머신 — Remote Control 제목으로 찾는다 (C1 · D27)
//   목록에는 제목과 짧은 참조 번호만 나온다. 어느 머신·폴더의 세션인지는 알 수 없어서 제목이 유일한 단서다.
//     ① 주소록 rc_title — 정확히 같은 제목, 또는 끝에 " · 숫자" 가 붙은 것만. 부분 일치 금지.
//        여럿이면 가장 큰 순번을 고르지 않는다 — 사용자에게 묻는다.
//     ② 전에 고른 세션(머신 상태에 짝마다 적어 둔 제목·참조 번호)이 목록에 있으면 그것.
//        제목으로 먼저 찾고, 없으면 참조 번호로 찾는다 — 사용자가 이름을 붙여 제목이 바뀌어도
//        참조 번호는 그대로였다(2026-09-19 실측: [87f895] 가 무작위 제목 → "CallAdmin · CallAdmin admin DEV").
//        참조 번호는 보는 쪽마다 다를 수 있다(기획서 §6.1) — 그래서 주소록이 아니라 이 PC 상태에만 두고,
//        못 찾으면 짐작하지 않고 묻는다.
//     ③ 다른 짝 몫(주소록의 다른 rc_title · 다른 짝에 적어 둔 제목)을 뺀 원격 세션이 하나뿐이면 그것 — 적어 둔다
//     ④ 여럿이면 사용자에게 묻고, 고른 것을 적어 둔다
//   rc_title 은 선택이다 — 제목을 따로 붙이지 않는 사용자는 Claude Code 가 지은 무작위 제목
//   (`호스트-형용사-명사`)을 한 번 고르면 된다. RC 제목은 같은 대화면 재시작·재개해도 유지된다
//   (사용자 실측). 새 대화가 열려 제목이 바뀌면 적어 둔 제목이 목록에서 사라지므로 그때만 다시 묻는다.
//   주소록 rc_title 이 있는데 목록에 없으면 ③ 의 자동 선택은 하지 않는다 — 적어 둔 짝이 안 떠 있다는 뜻이라
//   남은 하나가 그 짝이라는 근거가 없다. 묻는다.
//   (엉뚱한 곳으로 가도 받는 쪽이 주소록으로 대상을 확인해 WRONG_TARGET 으로 돌려보낸다 — 그때 적어 둔 제목을 지운다)
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

// ───────────────────────── 다른 머신 — 고른 제목(머신 상태) ─────────────────────────
// 선언과 같은 모양 — 짝마다 파일 하나. 키는 endpoint_id 라서 이 PC 의 다른 저장소가 같은 짝을
// 다른 별칭으로 불러도 한 번 고른 것을 함께 쓴다.

function titlesDir() {
  return path.join(util.stateDir(), 'remote_titles');
}

function titleFile(endpointId) {
  if (!ab.ID_RE.test(endpointId || '')) throw new Error('endpoint_id 형식 오류: ' + endpointId);
  return path.join(titlesDir(), endpointId + '.json');
}

// 파일 모양: { title, ref, source, picked_at, not:[제목…] }
//   title·ref : 이 짝으로 보낼 세션 (없을 수 있다 — not 만 남은 경우)
//   not       : 이 짝이 아니라고 받는 쪽이 돌려보낸(WRONG_TARGET) 제목. 자동 선택·후보에서 뺀다
function readTitles() {
  const out = { endpoints: {} };
  let names = [];
  try {
    names = fs.readdirSync(titlesDir()).filter((n) => /\.json$/.test(n));
  } catch (e) {
    return out;
  }
  names.forEach((n) => {
    const j = util.readJson(path.join(titlesDir(), n), null);
    if (!j || typeof j !== 'object') return;
    out.endpoints[n.replace(/\.json$/, '')] = {
      title: typeof j.title === 'string' && j.title ? j.title : null,
      ref: typeof j.ref === 'string' && j.ref ? j.ref : null,
      source: j.source || null,
      picked_at: j.picked_at || null,
      not: Array.isArray(j.not) ? j.not.filter((t) => typeof t === 'string') : [],
    };
  });
  return out;
}

const NOT_MAX = 20; // 무작위 제목은 새 대화마다 새로 생기므로 오래된 것은 버린다

// source: user(사용자가 목록에서 고름) · auto(후보가 하나뿐이라 정함) · ref(참조 번호로 다시 찾아 제목을 고침)
// 사용자가 직접 고른 제목은 not 에서 뺀다 — 사용자 판단이 우선이다
function rememberTitle(endpointId, o) {
  const prev = readTitles().endpoints[endpointId];
  const not = (prev ? prev.not : []).filter((t) => t !== o.title);
  const rec = { title: o.title, ref: o.ref || null, source: o.source, picked_at: util.nowIso(), not: not };
  util.writeJsonAtomic(titleFile(endpointId), rec);
  return rec;
}

// 사용자가 지우라고 할 때 — 적어 둔 것 전부
function forgetTitle(endpointId) {
  const f = titleFile(endpointId);
  const had = fs.existsSync(f);
  util.unlinkQuiet(f);
  return had;
}

// 받는 쪽이 WRONG_TARGET 으로 돌려보낸 제목 — 적어 둔 세션이 그것이면 지우고, not 에 넣는다.
// 늦게 온 WRONG_TARGET 이 그사이 새로 고른 세션을 지우지 않도록 제목이 같을 때만 지운다.
function markWrongTitle(endpointId, title) {
  if (!title) return { forgot: false };
  const prev = readTitles().endpoints[endpointId] || { title: null, ref: null, source: null, picked_at: null, not: [] };
  const forgot = prev.title === title;
  const not = prev.not.filter((t) => t !== title).concat([title]).slice(-NOT_MAX);
  const rec = { title: forgot ? null : prev.title, ref: forgot ? null : prev.ref, source: forgot ? null : prev.source, picked_at: forgot ? null : prev.picked_at, not: not };
  util.writeJsonAtomic(titleFile(endpointId), rec);
  return { forgot: forgot };
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

// 다른 머신 짝 — 머리말의 ①~④.
//   ready 에 remember 가 붙으면 prepare 가 그 세션(제목·참조 번호)을 적어 둔다.
function resolveRemote(o, peer, make) {
  const rows = o.agents.rows;
  const remote = rows.filter((r) => r.where === 'remote');
  if (remote.length === 0) {
    return make({ status: 'unreachable', reason: '목록에 다른 머신 세션이 하나도 없다 — 이 세션의 Remote Control 이 꺼져 있을 가능성이 크다', rc_visible: false });
  }
  const sel = peer.session_selector || {};
  const rcTitle = typeof sel.rc_title === 'string' && sel.rc_title.trim() ? sel.rc_title : null;
  const asCandidates = (list) => list.map((r) => withSendTo(rows, r));
  const ready = (row, extra) => make(Object.assign({ status: 'ready', send_to: addressFor(rows, row), row: row }, extra));

  // ① 주소록 제목
  if (rcTitle) {
    const hits = remote.filter((r) => titleMatches(r.name, rcTitle, sel.accept_numeric_suffix));
    if (hits.length === 1) return ready(hits[0], { via: 'rc_title' });
    if (hits.length > 1) return make({ status: 'ask', reason: '제목 "' + rcTitle + '" 후보가 ' + hits.length + '개다', candidates: asCandidates(hits) });
  }

  // ② 전에 고른 세션 — 제목, 없으면 참조 번호
  const titles = o.titles || readTitles();
  const mine = titles.endpoints[peer.endpoint_id] || null;
  const notList = mine ? mine.not : [];
  let note = null;
  if (mine && mine.title) {
    const byTitle = remote.filter((r) => r.name === mine.title);
    if (byTitle.length === 1) return ready(byTitle[0], { via: 'remembered' });
    if (byTitle.length > 1) {
      const byBoth = byTitle.filter((r) => mine.ref && r.ref === mine.ref);
      if (byBoth.length === 1) return ready(byBoth[0], { via: 'remembered' });
      return make({ status: 'ask', reason: '전에 고른 제목 "' + mine.title + '" 인 세션이 ' + byTitle.length + '개다', candidates: asCandidates(byTitle) });
    }
    const byRef = mine.ref ? remote.filter((r) => r.ref === mine.ref) : [];
    if (byRef.length === 1 && notList.indexOf(byRef[0].name) === -1) {
      return ready(byRef[0], { via: 'remembered_ref', remember: true, note: '전에 고른 세션의 제목이 "' + mine.title + '" → "' + byRef[0].name + '" 로 바뀌었다(참조 번호가 같다)' });
    }
    note = '전에 고른 세션("' + mine.title + '")이 목록에 없다 — 닫혔거나 새 대화로 바뀌었다';
  }

  // ③·④ 다른 짝 몫과 "이 짝 아님" 으로 돌아온 제목을 뺀 나머지
  const others = ab.peersOf(o.book);
  const takenByBook = (r) =>
    Object.keys(others).some((a) => {
      const p = others[a];
      if (!p || p.endpoint_id === peer.endpoint_id) return false;
      const s = p.session_selector || {};
      return typeof s.rc_title === 'string' && s.rc_title.trim() !== '' && titleMatches(r.name, s.rc_title, s.accept_numeric_suffix);
    });
  const takenByState = (r) => Object.keys(titles.endpoints).some((id) => id !== peer.endpoint_id && titles.endpoints[id].title === r.name);
  const free = remote.filter((r) => notList.indexOf(r.name) === -1 && !takenByBook(r) && !takenByState(r));
  const lead = rcTitle ? 'Remote Control 목록에 제목 "' + rcTitle + '" 인 세션이 없다 — ' : '';
  if (free.length === 0) {
    return make({ status: 'unreachable', reason: lead + '다른 짝 몫을 빼면 남는 다른 머신 세션이 없다', note: note, rc_visible: true });
  }
  // 주소록에 제목을 적어 둔 짝이 안 떠 있으면, 남은 하나가 그 짝이라는 근거가 없다 — 자동으로 고르지 않는다
  if (free.length === 1 && !rcTitle) return ready(free[0], { via: 'only_candidate', remember: true, note: note });
  return make({ status: 'ask', reason: lead + '어느 세션이 이 짝인지 모른다(후보 ' + free.length + '개). 고르면 기억해 두고 다음부터 묻지 않는다', note: note, candidates: asCandidates(free) });
}

// 한 짝의 전송 대상을 정한다.
//   반환 status: ready(보내면 된다) · ask(사용자에게 물어야 한다) · unreachable(목록에 짝 세션이 없다)
function resolvePeer(o) {
  const book = o.book;
  const peer = ab.peersOf(book)[o.alias];
  const agents = o.agents;
  const same = peer.machine_id === book.self.machine_id;
  const out = { alias: o.alias, endpoint_id: peer.endpoint_id, same_machine: same };
  const make = (extra) => Object.assign({}, out, extra);

  if (!same) return resolveRemote(o, peer, make);

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

module.exports = {
  readRegistry,
  readDeclared,
  declare,
  forget,
  readTitles,
  rememberTitle,
  forgetTitle,
  markWrongTitle,
  parseAgents,
  titleMatches,
  findReplyTarget,
  resolvePeer,
  addressFor,
};
