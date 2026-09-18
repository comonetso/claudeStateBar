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
    const prevFile = path.join(dir, 'result', alias + '.md');
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
  if (env.type === 'result' && accepted) resultFile = store.writeText(dir, 'result', alias + '.md', env.body + '\n');
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
      if (!peer || peer.machine_id !== book.self.machine_id) return;
      const mine = states[alias];
      if (mine && state.FINAL.indexOf(mine.state) !== -1) return;
      const peerDir = path.join(store.recordsRoot(t.root), id);
      const peerRec = store.readRequestRecord(peerDir);
      if (!peerRec || peerRec.direction !== 'inbound') return;
      const theirs = state.fold(store.listEvents(peerDir)).self;
      if (!theirs) return;
      if (!mine || mine.state === 'prepared' || mine.state === 'transport_accepted' || mine.state === 'unknown') {
        const ack = readReply(path.join(peerDir, 'outbox', 'ack.txt'));
        if (ack) pulled.push(ingestEnvelope(root, ack, 'peer-record'));
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
