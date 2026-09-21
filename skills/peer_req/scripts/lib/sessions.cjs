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
// ■ 다른 머신 — Remote Control 목록의 참조 번호·제목으로 찾는다 (C1 · D27 · 2026-09-21 개정)
//   목록에는 제목과 짧은 참조 번호(ref)만 나온다. 어느 머신·폴더의 세션인지는 목록만으로 알 수 없다.
//   🔴 원격 줄의 ref 는 **보는 쪽이 달라도 같고**, 같은 대화면 제목이 바뀌어도·재시작·재개해도 그대로다.
//      새 대화가 열리면 제목과 함께 바뀐다(2026-09-21 기록 대조 — 기획서 §6.1-1 의 "보는 쪽마다 다르다" 는
//      자기 줄과 남의 줄을 비교한 오류였다). 그래서 기억한 ref 가 제목보다 먼저다.
//     ① 기억한 세션의 ref 가 목록에 있으면 그것 — 제목이 바뀌었으면 새 제목을 기억한다
//     ② 주소록 rc_title — 정확히 같은 제목, 또는 끝에 " · 숫자" 가 붙은 것만. 부분 일치 금지.
//        여럿이면 가장 큰 순번을 고르지 않는다 — 사용자에게 묻는다.
//     ③ 기억한 제목이 목록에 하나 있으면 그것 — ref 가 목록에 없다는 건 새 대화라는 뜻이라, 제목을 고정해 쓰는
//        경우에만 맞는다. 틀리면 받는 쪽이 WRONG_TARGET 으로 돌려보낸다
//     ④ 다른 짝 몫과 "이 짝 아님" 을 뺀 원격 세션이 하나뿐이면 그것 — **목록을 전부 읽었을 때만**.
//        읽지 못한 줄이나 처음 보는 종류의 줄이 있으면 그 줄이 진짜 짝일 수 있어 자동으로 고르지 않는다
//     ⑤ 여럿이면 사용자에게 묻는다
//   🔴 기억은 **상대가 받았다고 답한 뒤에** 한다(ingest 가 received ACK·결과를 받을 때 promoteRoute).
//      전에는 보내기 전에 적어 두어, 엉뚱한 세션을 골라도 짝으로 기억부터 했다.
//   rc_title 은 선택이다 — 제목을 따로 붙이지 않는 사용자는 목록에서 한 번 고르면 된다.
//   주소록 rc_title 이 있는데 목록에 없으면 ④ 의 자동 선택은 하지 않는다 — 남은 하나가 그 짝이라는 근거가 없다.
//   "이 짝 아님"(WRONG_TARGET 으로 돌아온 세션)은 {제목, ref} 쌍으로 적는다 — 제목만 적으면 같은 제목을 다시 쓰는
//   새 대화까지 영영 후보에서 빠진다.
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

// 파일 모양: { session_id, root, name_at_bind, source, bound_at, selected_at, invalidated_at }
//   selected_at    : 이 세션을 고른 때 — 보낸 요청의 prepared 시각(bind·here 는 그때). 늦게 온 ACK 를 이것과 비교한다.
//                    bound_at 은 기록한 때(ACK 가 온 때)라 비교 기준이 못 된다(2026-09-21 Codex 리뷰)
//   invalidated_at : WRONG_TARGET·forget 으로 지운 때. session_id 없이 이것만 남긴다 —
//                    그보다 먼저 보낸 요청의 늦은 ACK 가 지운 기록을 되살리지 않게 한다
// readDeclared 는 session_id 가 있는 것만 돌려준다(0.1.x 도 같은 규칙이라 무효화 기록을 무시한다).
function readDeclaredRaw(endpointId) {
  return util.readJson(declaredFile(endpointId), null);
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
  const now = util.nowIso();
  const rec = { session_id: o.sessionId, root: o.root, name_at_bind: o.name || null, source: o.source, bound_at: now, selected_at: o.selectedAt || now };
  util.writeJsonAtomic(declaredFile(endpointId), rec);
  return rec;
}

function forget(endpointId) {
  const f = declaredFile(endpointId);
  const prev = util.readJson(f, null);
  util.writeJsonAtomic(f, { session_id: null, invalidated_at: util.nowIso() });
  return !!(prev && prev.session_id);
}

// ───────────────────────── 다른 머신 — 고른 세션(머신 상태) ─────────────────────────
// 선언과 같은 모양 — 짝마다 파일 하나. 키는 endpoint_id 라서 이 PC 의 다른 저장소가 같은 짝을
// 다른 별칭으로 불러도 한 번 고른 것을 함께 쓴다.
//
// 🔴 0.2.0 부터 폴더가 remote_titles_v2 다. 0.1.x 는 remote_titles 를 쓰고, "이 짝 아님" 을 문자열로만 읽어
//    새 형식({제목, ref})을 만나면 조용히 버린다 — 같은 파일을 두 버전이 번갈아 덮으면 서로의 기록을 잃는다
//    (2026-09-21 Codex 리뷰 재현). 그래서 폴더를 나누고, 옛 폴더는 읽기만 한다:
//      · 옛 "이 짝 아님" 은 가져온다(빼는 쪽이라 안전하다)
//      · 옛 기억(제목·ref)은 가져오지 않는다 — 받았다는 답을 확인하지 않고 적은 것이다
//    두 버전이 함께 열려 있는 동안에는 서로의 새 기억을 모른다. 새 버전으로 세션을 다시 열면 끝난다.

function titlesDir() {
  return path.join(util.stateDir(), 'remote_titles_v2');
}

function legacyTitlesDir() {
  return path.join(util.stateDir(), 'remote_titles');
}

function titleFile(endpointId) {
  if (!ab.ID_RE.test(endpointId || '')) throw new Error('endpoint_id 형식 오류: ' + endpointId);
  return path.join(titlesDir(), endpointId + '.json');
}

// "이 짝 아님" 항목 — 0.1.x 는 제목 문자열로 적었다. 둘 다 읽는다.
//   { title, ref, at } : ref 가 있으면 ref 로만 가린다(같은 제목의 새 대화는 다시 후보가 된다). at = 뺀 때
//   구형 문자열         : 제목으로 가린다
function normNot(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((n) =>
      typeof n === 'string'
        ? { title: n, ref: null, at: null }
        : n && typeof n === 'object'
        ? { title: typeof n.title === 'string' ? n.title : null, ref: typeof n.ref === 'string' && n.ref ? n.ref : null, at: typeof n.at === 'string' ? n.at : null }
        : null
    )
    .filter((n) => n && (n.title || n.ref));
}

function isExcluded(notList, row) {
  return notList.some((n) => (n.ref ? n.ref === row.ref : n.title === row.name));
}

function listJsonDir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/.test(n));
  } catch (e) {
    return [];
  }
  return names
    .map((n) => ({ id: n.replace(/\.json$/, ''), j: util.readJson(path.join(dir, n), null) }))
    .filter((x) => x.j && typeof x.j === 'object');
}

// 파일 모양: { title, ref, source, picked_at, selected_at, invalidated_at, not:[{title, ref, at}…] }
//   title·ref      : 이 짝으로 보낼 세션 (없을 수 있다 — not 만 남은 경우)
//   picked_at      : 기억한 때(받았다는 답이 온 때) · selected_at : 그 세션을 고른 때(비교 기준)
//   invalidated_at : forget 으로 지운 때 — 그 전에 보낸 요청의 늦은 ACK 가 되살리지 않게
//   not            : 이 짝이 아니라고 받는 쪽이 돌려보낸(WRONG_TARGET) 세션. 자동 선택·후보에서 뺀다
function readTitles() {
  const out = { endpoints: {} };
  listJsonDir(legacyTitlesDir()).forEach((x) => {
    out.endpoints[x.id] = { title: null, ref: null, source: null, picked_at: null, selected_at: null, invalidated_at: null, not: normNot(x.j.not), legacy: true };
  });
  listJsonDir(titlesDir()).forEach((x) => {
    const j = x.j;
    out.endpoints[x.id] = {
      title: typeof j.title === 'string' && j.title ? j.title : null,
      ref: typeof j.ref === 'string' && j.ref ? j.ref : null,
      source: j.source || null,
      picked_at: j.picked_at || null,
      selected_at: j.selected_at || null,
      invalidated_at: j.invalidated_at || null,
      not: normNot(j.not),
    };
  });
  return out;
}

const NOT_MAX = 20; // 새 대화마다 ref 가 새로 생기므로 오래된 것은 버린다

// source: user(사용자가 목록에서 고름) · auto(후보가 하나뿐이라 정함) · ref(참조 번호로 다시 찾음) · rc_title · title
// 사용자가 "이 짝 아님" 에 든 세션을 **그 뒤에** 다시 골랐으면 not 에서 뺀다 — 사용자 판단이 우선이다
function rememberTitle(endpointId, o) {
  const prev = readTitles().endpoints[endpointId];
  const row = { name: o.title, ref: o.ref || null };
  const not = (prev ? prev.not : []).filter((n) => !(o.source === 'user' && isExcluded([n], row) && (!n.at || !o.selectedAt || n.at < o.selectedAt)));
  const now = util.nowIso();
  const rec = { title: o.title, ref: o.ref || null, source: o.source, picked_at: now, selected_at: o.selectedAt || now, invalidated_at: prev ? prev.invalidated_at || null : null, not: not };
  util.writeJsonAtomic(titleFile(endpointId), rec);
  return rec;
}

// 사용자가 지우라고 할 때 — 적어 둔 것 전부. 지운 때를 남긴다(늦은 ACK 가 되살리지 않게)
function forgetTitle(endpointId) {
  const prev = readTitles().endpoints[endpointId];
  util.writeJsonAtomic(titleFile(endpointId), { title: null, ref: null, source: null, picked_at: null, selected_at: null, invalidated_at: util.nowIso(), not: [] });
  return !!(prev && (prev.title || prev.ref || prev.not.length));
}

// 받는 쪽이 WRONG_TARGET 으로 돌려보낸 세션 — 적어 둔 세션이 그것이면 지우고, not 에 {제목, ref, 뺀 때} 로 넣는다.
// 늦게 온 WRONG_TARGET 이 그사이 새로 고른 세션을 지우지 않도록 같은 세션일 때만 지운다
// (ref 가 둘 다 있으면 ref 로, 아니면 제목으로 본다). 두 번째 인자로 제목 문자열만 오는 것은 0.1.x 기록이다.
function markWrongTitle(endpointId, wrong) {
  const w = typeof wrong === 'string' ? { title: wrong, ref: null } : wrong || {};
  if (!w.title && !w.ref) return { forgot: false };
  const prev = readTitles().endpoints[endpointId] || { title: null, ref: null, source: null, picked_at: null, selected_at: null, invalidated_at: null, not: [] };
  const forgot = !!(prev.title || prev.ref) && (prev.ref && w.ref ? prev.ref === w.ref : prev.title === w.title);
  const entry = { title: w.title || null, ref: w.ref || null, at: util.nowIso() };
  const not = prev.not.filter((n) => !(n.ref === entry.ref && n.title === entry.title)).concat([entry]).slice(-NOT_MAX);
  const keep = !forgot;
  const rec = {
    title: keep ? prev.title : null,
    ref: keep ? prev.ref : null,
    source: keep ? prev.source : null,
    picked_at: keep ? prev.picked_at : null,
    selected_at: keep ? prev.selected_at : null,
    invalidated_at: prev.invalidated_at || null,
    not: not,
  };
  util.writeJsonAtomic(titleFile(endpointId), rec);
  return { forgot: forgot };
}

// ───────────────────────── 확인된 뒤에 기억한다 (2026-09-21) ─────────────────────────
// prepare 는 고른 세션을 prepared 이벤트의 route 에 적기만 한다. 상대가 "받았다"(received·duplicate ACK)거나
// 결과를 보내오면 ingest 가 이 함수로 그때 기억한다. 엉뚱한 세션을 골랐으면 WRONG_TARGET 이 오고 기억은 생기지 않는다.
//   sentAt : 그 prepared 이벤트 시각 = 그 세션을 고른 때. 비교는 전부 "고른 때" 끼리 한다 —
//            ACK 가 온 순서가 아니라 고른 순서로 최신을 정한다(2026-09-21 Codex 리뷰: 먼저 보낸 요청의 ACK 가
//            먼저 오면 나중에 고른 세션의 ACK 가 버려지던 문제)
//   건너뛰는 경우: 그 뒤에 지웠다(invalidated) · 그 뒤에 "이 짝 아님" 이 됐다(excluded) · 더 나중에 고른 기억이 있다(newer)
function promoteRoute(endpointId, targetRoot, route, sentAt) {
  if (!route) return null;
  const after = (t) => !!(t && sentAt && t > sentAt);
  if (route.same_machine) {
    if (!route.session_id || !route.bind) return null;
    const raw = readDeclaredRaw(endpointId);
    if (raw && after(raw.invalidated_at)) return { kind: 'declared', skipped: 'invalidated' };
    if (raw && raw.session_id === route.session_id) return { kind: 'declared', unchanged: true };
    if (raw && raw.session_id && after(raw.selected_at || raw.bound_at)) return { kind: 'declared', skipped: 'newer' }; // 0.1.x 기록은 bound_at 이 고른 때다
    return { kind: 'declared', rec: declare(endpointId, { sessionId: route.session_id, root: targetRoot, name: route.name || null, source: route.source || 'auto', selectedAt: sentAt }) };
  }
  if (!route.remember || !route.title) return null;
  const cur = readTitles().endpoints[endpointId];
  if (cur && after(cur.invalidated_at)) return { kind: 'remote', skipped: 'invalidated' };
  const hits = cur ? cur.not.filter((n) => isExcluded([n], { name: route.title, ref: route.ref || null })) : [];
  // "이 짝 아님" 에 든 세션 — 사용자가 그 뒤에 직접 고른 것만 받는다
  if (hits.length && (route.source !== 'user' || hits.some((n) => after(n.at)))) return { kind: 'remote', skipped: 'excluded' };
  if (cur && cur.ref && route.ref && cur.ref === route.ref && cur.title === route.title) return { kind: 'remote', unchanged: true };
  if (cur && (cur.title || cur.ref) && after(cur.selected_at || cur.picked_at)) return { kind: 'remote', skipped: 'newer' };
  return { kind: 'remote', rec: rememberTitle(endpointId, { title: route.title, ref: route.ref || null, source: route.source || 'auto', selectedAt: sentAt }) };
}

// 같은 머신 짝에게 보냈는데 WRONG_TARGET 이 왔다 — 그 세션을 짝으로 기록해 두었으면 지운다(지운 때를 남긴다)
function forgetIfDeclared(endpointId, sessionId) {
  if (!sessionId) return false;
  const cur = readDeclared().endpoints[endpointId];
  if (!cur || cur.session_id !== sessionId) return false;
  return forget(endpointId);
}

// ───────────────────────── ListAgents 출력 파싱 ─────────────────────────

// ListAgents 결과 원문 → { self, rows:[{name,ref,kind,status,where}], unparsed, declared, complete }
//   where: local(같은 머신 대화형) · remote(Remote Control) · cloud · unknown(처음 보는 종류)
//   🔴 모르는 종류를 local 로 넣지 않는다 — 원격 줄의 표기가 바뀌면 원격 후보에서 조용히 빠지고, 남은 하나가
//      엉뚱하게 자동 선택된다(2026-09-21 Codex 지적). 같은 머신에서는 등록 파일에 있는 이름일 때만 쓴다.
//   complete : 짝 후보 섹션의 들여쓴 줄을 전부 읽었고, "Peer sessions (N)" 의 N 과 읽은 줄 수가 같다
//   섹션 — 목록에는 "Peer sessions" 말고도 "Subagents"·"Teammates" 섹션이 나온다(Claude Code 2.1.278 렌더러 확인).
//          그 둘은 이 세션이 띄운 일꾼이라 짝 후보가 아니다 — 세지 않는다(2026-09-21 Codex 리뷰: 그 줄 때문에
//          정상 목록이 "불완전" 으로 읽혀 자동 선택이 막혔다). 처음 보는 섹션은 짝 후보로 읽어 개수 대조에 걸리게 둔다.
//          헤더가 하나도 없는 목록(옛 형식)은 전부 짝 후보로 읽는다.
//   종류(kind) — 같은 버전에서 원격은 "Remote Control", 클라우드는 "cloud session" 이다.
const LOCAL_KINDS = ['interactive'];
const NON_PEER_SECTIONS = ['Subagents', 'Teammates'];
const HEADER_RE = /^([A-Z][A-Za-z ]*?)(?: \((\d+)\))?:\s*$/;

function parseAgents(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const selfM = src.match(/This session is (.+?) \[([0-9a-z]+)\]/);
  const rows = [];
  const re = /^\s+(.+?) \[([0-9a-z]+)\]\s+·\s+(.+?)\s+·\s+([A-Za-z]+)/;
  let unparsed = 0;
  let declared = null;
  let section = null;
  let otherRows = 0;
  src.split('\n').forEach((line) => {
    const h = line.match(HEADER_RE);
    if (h) {
      section = h[1];
      if (section === 'Peer sessions' && h[2] !== undefined) declared = (declared || 0) + Number(h[2]);
      return;
    }
    if (!/^\s+\S/.test(line)) return;
    if (section !== null && NON_PEER_SECTIONS.indexOf(section) !== -1) {
      otherRows++;
      return;
    }
    const m = line.match(re);
    if (!m) {
      unparsed++;
      return;
    }
    const kind = m[3].trim();
    const where = /^remote control$/i.test(kind) ? 'remote' : /^cloud( session)?$/i.test(kind) ? 'cloud' : LOCAL_KINDS.indexOf(kind.toLowerCase()) !== -1 ? 'local' : 'unknown';
    rows.push({ name: m[1].trim(), ref: m[2], kind: kind, status: m[4], where: where, section: section });
  });
  const complete = unparsed === 0 && (declared === null || declared === rows.length);
  return { self: selfM ? { name: selfM[1].trim(), ref: selfM[2] } : null, rows: rows, unparsed: unparsed, declared: declared, other_rows: otherRows, complete: complete };
}

// 원격 자동 선택(남은 하나)을 해도 될 만큼 목록을 이해했나 — 읽지 못한 줄이 없고, 처음 보는 종류의 줄은
// 등록 파일로 이 머신 세션임이 확인되는 것뿐이어야 한다
function listUnderstood(agents, reg) {
  if (agents.complete === false) return false;
  const names = {};
  if (reg && reg.readable) reg.sessions.forEach((s) => (names[s.name] = true));
  return !agents.rows.some((r) => r.where === 'unknown' && !names[r.name]);
}

// 같은 머신 줄 — 대화형 줄, 그리고 종류는 처음 보지만 등록 파일에 있는 이름(같은 머신 세션이 확실하다)
function localRowsOf(agents, reg) {
  const names = {};
  if (reg && reg.readable) reg.sessions.forEach((s) => (names[s.name] = true));
  return agents.rows.filter((r) => r.where === 'local' || (r.where === 'unknown' && names[r.name]));
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
  const localRows = localRowsOf(o.agents, reg);
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

// 다른 머신 짝 — 머리말의 ①~⑤.
//   ready 에 remember 가 붙으면 prepare 가 그 세션(제목·참조 번호)을 route 에 적고, 상대가 받았다고 답하면 기억한다.
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
  const titles = o.titles || readTitles();
  const mine = titles.endpoints[peer.endpoint_id] || null;
  const notList = mine ? mine.not : [];
  const excluded = (r) => isExcluded(notList, r);

  // 다른 짝 몫 — 주소록의 다른 rc_title · 다른 짝에 기억해 둔 세션 · 이번 요청에서 이미 다른 짝에게 배정한 세션
  //   다른 짝의 기억은 그 짝 자신이 찾는 규칙과 똑같이 가린다: 기억한 ref 가 목록에 있으면 그 줄,
  //   없으면(그 짝이 새 대화로 바뀌었다) 기억한 제목의 줄. ref 만 보면 그 짝의 새 대화를 이 짝이 가져갔다(Codex 리뷰).
  const others = ab.peersOf(o.book);
  const takenByBook = (r) =>
    Object.keys(others).some((a) => {
      const p = others[a];
      if (!p || p.endpoint_id === peer.endpoint_id) return false;
      const s = p.session_selector || {};
      return typeof s.rc_title === 'string' && s.rc_title.trim() !== '' && titleMatches(r.name, s.rc_title, s.accept_numeric_suffix);
    });
  const takenByState = (r) =>
    Object.keys(titles.endpoints).some((id) => {
      if (id === peer.endpoint_id) return false;
      const t = titles.endpoints[id];
      if (t.ref && remote.some((x) => x.ref === t.ref)) return t.ref === r.ref;
      return !!t.title && t.title === r.name;
    });
  // 그룹으로 보낼 때 앞 짝에게 이미 배정한 세션 — 기억은 ACK 뒤라 아직 기록에 없다(Codex 리뷰: 두 짝이 같은 세션으로 갔다)
  const claimed = (o.claimed && o.claimed.refs) || {};
  const takenByOther = (r) => !!claimed[r.ref] || takenByBook(r) || takenByState(r);

  // ① 기억한 세션의 참조 번호 — 같은 대화면 제목이 바뀌어도 그대로다
  if (mine && mine.ref) {
    const byRef = remote.filter((r) => r.ref === mine.ref && !excluded(r) && !claimed[r.ref]);
    if (byRef.length === 1) {
      const renamed = !!mine.title && byRef[0].name !== mine.title;
      return ready(byRef[0], { via: 'remembered_ref', remember: true, note: renamed ? '전에 고른 세션의 제목이 "' + mine.title + '" → "' + byRef[0].name + '" 로 바뀌었다(같은 대화 — 참조 번호가 같다)' : null });
    }
  }

  // ② 주소록 제목 — 이 경로로 보낸 세션도 참조 번호를 기억해 둔다(제목이 바뀌어도 ① 로 따라간다)
  if (rcTitle) {
    const hits = remote.filter((r) => titleMatches(r.name, rcTitle, sel.accept_numeric_suffix) && !excluded(r) && !claimed[r.ref]);
    if (hits.length === 1) return ready(hits[0], { via: 'rc_title', remember: true });
    if (hits.length > 1) return make({ status: 'ask', reason: '제목 "' + rcTitle + '" 후보가 ' + hits.length + '개다', candidates: asCandidates(hits) });
  }

  // ③ 기억한 제목 — 참조 번호가 목록에 없으니 새 대화다. 같은 제목이 하나면(제목을 고정해 쓰는 경우) 그리로 보낸다
  let note = null;
  if (mine && mine.title) {
    const byTitle = remote.filter((r) => r.name === mine.title && !excluded(r) && !takenByOther(r));
    if (byTitle.length === 1) {
      return ready(byTitle[0], { via: 'remembered', remember: true, note: mine.ref ? '전에 고른 대화(참조 번호 ' + mine.ref + ')는 목록에 없고 같은 제목의 세션이 있다 — 새 대화로 보고 그리로 보낸다' : null });
    }
    if (byTitle.length > 1) return make({ status: 'ask', reason: '전에 고른 제목 "' + mine.title + '" 인 세션이 ' + byTitle.length + '개다', candidates: asCandidates(byTitle) });
    note = '전에 고른 세션("' + mine.title + '")이 목록에 없다 — 닫혔거나 새 대화로 바뀌었다';
  }

  // ④·⑤ 다른 짝 몫과 "이 짝 아님" 을 뺀 나머지
  const free = remote.filter((r) => !excluded(r) && !takenByOther(r));
  const lead = rcTitle ? 'Remote Control 목록에 제목 "' + rcTitle + '" 인 세션이 없다 — ' : '';
  const understood = listUnderstood(o.agents, o.registry || null);
  if (free.length === 0 && understood) {
    return make({ status: 'unreachable', reason: lead + '다른 짝 몫을 빼면 남는 다른 머신 세션이 없다', note: note, rc_visible: true });
  }
  // 주소록에 제목을 적어 둔 짝이 안 떠 있거나, 목록에 읽지 못한 줄이 있으면 남은 하나가 그 짝이라는 근거가 없다
  if (free.length === 1 && !rcTitle && understood) return ready(free[0], { via: 'only_candidate', remember: true, note: note });
  const why = understood ? '' : ' 목록에 읽지 못한 줄이나 처음 보는 종류의 줄이 있어 자동으로 고르지 않는다(' + (o.agents.unparsed || 0) + '줄 · 종류 ' + o.agents.rows.filter((r) => r.where === 'unknown').map((r) => r.kind).join(',') + ').';
  return make({ status: 'ask', reason: lead + '어느 세션이 이 짝인지 모른다(후보 ' + free.length + '개).' + why + ' 고르면 받았다는 답이 온 뒤 기억해 두고 다음부터 묻지 않는다', note: note, candidates: asCandidates(free) });
}

// 한 짝의 전송 대상을 정한다.
//   반환 status: ready(보내면 된다) · ask(사용자에게 물어야 한다) · unreachable(목록에 짝 세션이 없다)
function resolvePeer(o) {
  const book = o.book;
  const peer = ab.peersOf(book)[o.alias];
  const agents = o.agents;
  const same = util.sameMachine(peer.machine_id, book.self.machine_id);
  const out = { alias: o.alias, endpoint_id: peer.endpoint_id, same_machine: same };
  const make = (extra) => Object.assign({}, out, extra);

  if (!same) return resolveRemote(o, peer, make);

  // 같은 머신
  const reg = o.registry || readRegistry();
  const localRows = localRowsOf(agents, reg);
  const toLocal = (s) => {
    const rows = localRows.filter((r) => r.name === s.name);
    if (rows.length === 1) return { send_to: rows[0].name, row: rows[0] };
    return null; // 목록에 없거나 같은 이름이 여럿 → 짐작하지 않는다
  };
  const asCandidates = (list) => list.map((s) => ({ session_id: s.sessionId, name: s.name, cwd: s.cwd, status: s.status, in_list: !!toLocal(s) }));

  if (!reg.readable) {
    return make({ status: 'ask', reason: '세션 등록 파일을 읽을 수 없다(' + reg.reason + ') — 목록에서 사용자에게 고르게 한다', candidates: localRows.map((r) => withSendTo(agents.rows, r)) });
  }
  // 이번 요청에서 앞 짝에게 이미 배정한 세션은 뺀다(한 짝의 폴더가 다른 짝 폴더의 상위이면 후보가 겹친다)
  const claimedSessions = (o.claimed && o.claimed.sessions) || {};
  const live = reg.sessions.filter((s) => s.sessionId !== o.selfSessionId && !claimedSessions[s.sessionId]);

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
  promoteRoute,
  forgetIfDeclared,
  isExcluded,
  parseAgents,
  listUnderstood,
  localRowsOf,
  titleMatches,
  findReplyTarget,
  resolvePeer,
  addressFor,
};
