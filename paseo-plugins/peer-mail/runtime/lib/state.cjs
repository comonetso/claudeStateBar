//
// state.cjs — 이벤트를 접어서 상태를 계산한다 (TODO I5 · 기획서 C5·C6·C8)
//
// 상태는 (request_id, 받는 쪽) 단위다. 1:N 이면 받는 쪽마다 따로 흘러간다.
//
//   prepared → transport_accepted → received → processing → completed
//                 ↘ held                                  ↘ awaiting_user (change_request)
//   종결: completed · awaiting_user · failed · refused · expired · unreachable · wrong_target · conflict
//
// 🔴 SendMessage 성공(transport_accepted)은 읽음이 아니다. received 는 받는 쪽이
//    request_id·해시를 확인하고 기록한 뒤 보낸 ACK 로만 된다.
//
// "보고됨"(reported)은 상태가 아니라 표시다. 마지막 상태 변화 뒤에 reported 가 없으면
// 사용자에게 아직 알리지 않은 것 → 세션 시작 훅이 "알리지 않은 N건" 으로 센다(C8).
//

'use strict';

const STATE_OF = {
  prepared: 'prepared',
  transport_accepted: 'transport_accepted',
  held: 'held',
  unknown: 'unknown',
  received: 'received',
  duplicate: 'received',
  processing: 'processing',
  completed: 'completed',
  awaiting_user: 'awaiting_user',
  failed: 'failed',
  refused: 'refused',
  expired: 'expired',
  unreachable: 'unreachable',
  wrong_target: 'wrong_target',
  conflict: 'conflict',
};

const TERMINAL = ['completed', 'awaiting_user', 'failed', 'refused', 'expired', 'unreachable', 'wrong_target', 'conflict'];
// 결과가 확정돼 더 바뀌지 않는 것 — 같은 요청의 결과를 두 번 쓰지 않는다(리뷰 P2)
const FINAL = ['completed', 'failed'];

const RANK = { prepared: 0, transport_accepted: 1, held: 1, unknown: 1, received: 2, processing: 3 };

function isTerminal(s) {
  return TERMINAL.indexOf(s) !== -1;
}

function rank(s) {
  if (isTerminal(s)) return 4;
  return RANK[s] !== undefined ? RANK[s] : 0;
}

function blank() {
  return { state: null, attempt_id: null, changedAt: null, reportedAt: null, detail: null };
}

// events: listEvents() 결과(시간순). 반환: { <받는 쪽>: {state, attempt_id, changedAt, reportedAt, unreported, detail} }
function fold(events) {
  const by = {};
  events.forEach((ev) => {
    const who = ev.recipient || 'self';
    if (!by[who]) by[who] = blank();
    const st = by[who];
    if (ev.type === 'reported') {
      st.reportedAt = ev.at;
      return;
    }
    const s = STATE_OF[ev.type];
    if (!s) return;
    // 새 시도(attempt)의 prepared 는 그 받는 쪽 상태를 처음부터 다시 시작한다
    if (ev.type === 'prepared' && ev.attempt_id && ev.attempt_id !== st.attempt_id) {
      st.state = 'prepared';
      st.attempt_id = ev.attempt_id;
      st.changedAt = ev.at;
      st.detail = ev.detail || null;
      return;
    }
    if (st.state === 'completed') return; // 완료 뒤에 늦게 온 것은 무시한다(중복 결과 포함)
    // awaiting_user → completed 처럼 종결끼리의 이동은 받는다. 진행이 뒤로 가는 것은 받지 않는다.
    if (st.state === null || isTerminal(s) || rank(s) >= rank(st.state)) {
      st.state = s;
      st.changedAt = ev.at;
      st.detail = ev.detail || null;
      if (ev.attempt_id) st.attempt_id = ev.attempt_id;
    }
  });
  Object.keys(by).forEach((k) => {
    const st = by[k];
    st.unreported = !!st.changedAt && (!st.reportedAt || st.reportedAt < st.changedAt);
  });
  return by;
}

// 사용자에게 알릴 만한 것인가 (세션 시작 훅 · inbox)
//   발신(outbound): 종결됐는데 아직 안 알렸다
//   수신(inbound) : 처리 대기이거나, 처리까지 끝냈는데 알리기 전에 세션이 닫혔다(리뷰 P2)
function needsAttention(direction, st) {
  if (!st || !st.unreported) return false;
  if (direction === 'outbound') return isTerminal(st.state);
  return st.state === 'received' || st.state === 'processing' || isTerminal(st.state);
}

module.exports = { TERMINAL, FINAL, isTerminal, fold, needsAttention };
