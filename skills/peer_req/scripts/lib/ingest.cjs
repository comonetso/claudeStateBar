//
// ingest.cjs — 응답(ACK·결과)을 보낸 쪽 기록에 넣는다 · 같은 머신 짝 기록에서 가져온다 (TODO I13)
//
// 응답이 들어오는 길은 셋이다.
//   ① SendMessage 로 온 응답을 Claude 가 파일로 옮겨 `ingest` 로 넣는다
//   ② 무인 경로가 끝나고 결과 파일을 가져와 넣는다
//   ③ 보낸 세션이 닫혀 있어 응답을 못 받았을 때 — 같은 머신이면 짝 저장소의 기록을 직접 읽어 온다(sync)
// 셋 다 같은 함수를 지난다. 기록 규칙이 갈라지지 않게 하려는 것이다.
//

'use strict';

const fs = require('fs');
const path = require('path');
const envl = require('./envelope.cjs');
const store = require('./store.cjs');
const state = require('./state.cjs');
const ab = require('./addressbook.cjs');
const sessions = require('./sessions.cjs');
const util = require('./util.cjs');

// 이 응답이 "그 대상이 맞다" 는 증거인가 — 받았다(received·duplicate) 또는 결과를 보냈다
function confirmsTarget(env) {
  if (env.type === 'ack') return env.status === 'received' || env.status === 'duplicate';
  return env.type === 'result' && env.status !== 'wrong_target';
}

// 이 응답에 해당하는 우리 쪽 prepared 이벤트(같은 시도) — 고른 세션(route)이 거기 적혀 있다
function sentEventFor(dir, env, alias) {
  const evs = store.listEvents(dir).filter((e) => e.type === 'prepared' && e.attempt_id === env.attempt_id && e.recipient === alias);
  return evs.length ? evs[evs.length - 1] : null;
}

// 응답이 어느 받는 쪽의 것인가.
//   보통은 응답자 endpoint 로 찾는다. 단 WRONG_TARGET 은 **엉뚱한 곳이 받았다는 뜻**이라 응답자가
//   대상과 다른 게 정상이다(주소록이 없으면 'unknown'). 그때는 우리가 보낸 시도 번호로 찾는다(2차 리뷰 P2).
function findAlias(dir, rec, env) {
  const byEndpoint = Object.keys(rec.targets).filter((a) => rec.targets[a].endpoint_id === env.sender_endpoint)[0];
  if (byEndpoint) return byEndpoint;
  if (env.type === 'ack' && env.status === 'wrong_target') {
    const ev = store.listEvents(dir).filter((e) => e.type === 'prepared' && e.attempt_id === env.attempt_id && rec.targets[e.recipient])[0];
    if (ev) return ev.recipient;
  }
  return null;
}

// env 는 checkEnvelope 를 통과한 ack·result. 반환은 CLI 가 그대로 출력할 모양.
function ingestEnvelope(root, env, from) {
  const dir = store.requestDir(root, env.request_id);
  const rec = store.readRequestRecord(dir);
  if (!rec || rec.direction !== 'outbound') {
    return { ok: false, unknown_request: true, request_id: env.request_id, hint: '이 저장소가 보낸 요청이 아니다. 기록하지 않는다' };
  }
  const alias = findAlias(dir, rec, env);
  if (!alias) return { ok: false, request_id: env.request_id, hint: '응답자 ' + env.sender_endpoint + ' 는 이 요청의 받는 쪽이 아니고, 우리가 보낸 시도와도 맞지 않는다' };
  // 같은 결과를 또 받았으면(무인 "다시 확인" 등) 기록하지 않는다 — 이미 알린 것이 다시 "알리지 않은 것" 이 되지 않게
  const before = state.fold(store.listEvents(dir))[alias];
  if (env.type === 'result' && before && before.state === env.status) {
    const prevFile = path.join(dir, 'result', util.fileKey(alias) + '.md');
    const prev = fs.existsSync(prevFile) ? fs.readFileSync(prevFile, 'utf8') : null;
    if (prev === env.body + '\n') {
      return { ok: true, request_id: env.request_id, short_id: env.request_id.slice(0, 8), alias: alias, type: env.type, status: env.status, accepted: false, unchanged: true, body: env.body, result_file: prevFile, state: before };
    }
  }
  const detail = (from ? 'from=' + from : '') + (env.sender_endpoint !== rec.targets[alias].endpoint_id ? ' responder=' + env.sender_endpoint : '');
  const added = store.appendEvent(dir, { type: env.status, recipient: alias, attempt_id: env.attempt_id, detail: detail || null });
  const after = state.fold(store.listEvents(dir))[alias];
  // 상태가 실제로 이 응답으로 바뀐 경우에만 결과 본문을 쓴다 — 완료 뒤 늦게 온 임시 결과가 덮지 않게(2차 리뷰 P2)
  const accepted = !!after && after.state === env.status && after.changedAt === added.event.at;
  let resultFile = null;
  if (env.type === 'result' && accepted) resultFile = store.writeText(dir, 'result', util.fileKey(alias) + '.md', env.body + '\n');
  const target = rec.targets[alias];
  const sent = sentEventFor(dir, env, alias);
  // 대상이 맞다는 답이 왔다 — 그때 고른 세션을 기억한다(2026-09-21: 전에는 보내기 전에 기억했다)
  let promoted = null;
  if (sent && sent.route && confirmsTarget(env) && env.sender_endpoint === target.endpoint_id) {
    try {
      promoted = sessions.promoteRoute(target.endpoint_id, target.root, sent.route, sent.at);
    } catch (e) {
      promoted = { error: e.message };
    }
  }
  // "대상 아님" 이 돌아왔다 — 다른 머신이면 그 세션을 {제목, ref} 로 후보에서 빼고 기억을 지운다.
  // 주소록 rc_title 은 사용자가 정한 값이라 그대로 두고, 그 세션(ref)만 뺀다. 같은 머신이면 그 세션 기록을 지운다.
  let wrongTitle = null;
  let forgotLocal = false;
  if (env.type === 'ack' && env.status === 'wrong_target' && sent) {
    const r = sent.route;
    if (r && r.same_machine) forgotLocal = sessions.forgetIfDeclared(target.endpoint_id, r.session_id);
    else if (r && (r.title || r.ref)) wrongTitle = Object.assign({ title: r.title || null, ref: r.ref || null }, sessions.markWrongTitle(target.endpoint_id, { title: r.title, ref: r.ref }));
    else if (sent.remote_title) wrongTitle = Object.assign({ title: sent.remote_title }, sessions.markWrongTitle(target.endpoint_id, sent.remote_title)); // 0.1.x 기록
  }
  return {
    ok: true,
    request_id: env.request_id,
    short_id: env.request_id.slice(0, 8),
    alias: alias,
    type: env.type,
    status: env.status,
    accepted: accepted,
    body: env.body,
    result_file: resultFile,
    wrong_title: wrongTitle,
    forgot_local: forgotLocal,
    promoted: promoted,
    state: after,
  };
}

function readReply(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const env = envl.extractEnvelope(fs.readFileSync(file, 'utf8'));
    return envl.checkEnvelope(env).length ? null : env;
  } catch (e) {
    return null;
  }
}

// 같은 머신 짝에게 보냈는데 아직 확정되지 않은 요청을, 짝 저장소 기록에서 따라잡는다.
// book 이 있어야 같은 머신인지 안다. 반환: 새로 들여온 것 목록.
// 확정(completed·failed)만 건너뛴다 — awaiting_user 뒤의 completed 도 따라잡아야 한다(2차 리뷰 P2).
function syncFromPeerRecords(root, book) {
  const pulled = [];
  if (!book || !book.self) return pulled;
  const peers = ab.peersOf(book);
  store.listRequestIds(root).forEach((id) => {
    const dir = store.requestDir(root, id);
    const rec = store.readRequestRecord(dir);
    if (!rec || rec.direction !== 'outbound') return;
    const states = state.fold(store.listEvents(dir));
    Object.keys(rec.targets || {}).forEach((alias) => {
      const t = rec.targets[alias];
      const peer = peers[alias];
      if (!peer || !util.sameMachine(peer.machine_id, book.self.machine_id)) return;
      const mine = states[alias];
      if (mine && state.FINAL.indexOf(mine.state) !== -1) return;
      const peerDir = path.join(store.recordsRoot(t.root), id);
      const peerRec = store.readRequestRecord(peerDir);
      if (!peerRec || peerRec.direction !== 'inbound') return;
      const theirs = state.fold(store.listEvents(peerDir)).self;
      if (!theirs) return;
      if (!mine || mine.state === 'prepared' || mine.state === 'transport_accepted' || mine.state === 'unknown') {
        // 처음 받은 ACK(ack.txt) + 같은 요청을 다시 보냈으면 그 시도의 duplicate ACK — 받는 쪽은 재시도마다
        // ack-duplicate-<attempt>.txt 를 남긴다. 이것까지 읽어야 다시 보낸 세션이 기억에 오른다(Codex 리뷰).
        const files = ['ack.txt'];
        if (mine && mine.attempt_id && /^[0-9a-f-]{36}$/i.test(mine.attempt_id)) files.push('ack-duplicate-' + mine.attempt_id + '.txt');
        files.forEach((name) => {
          const ack = readReply(path.join(peerDir, 'outbox', name));
          if (ack) pulled.push(ingestEnvelope(root, ack, 'peer-record'));
        });
      }
      if (state.isTerminal(theirs.state)) {
        const res = readReply(store.resultMessageFile(peerDir));
        const now = state.fold(store.listEvents(dir))[alias];
        if (res && (!now || now.state !== res.status)) pulled.push(ingestEnvelope(root, res, 'peer-record'));
      }
    });
  });
  return pulled.filter((p) => p.ok);
}

module.exports = { ingestEnvelope, syncFromPeerRecords, readReply };
