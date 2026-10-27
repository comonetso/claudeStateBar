'use strict';
//
// 중계기가 새로 여는 대화(받는 대화가 없을 때)의 모델·에포트·권한 — 이 기기의 기억 (10-27 리규형님 버튼)
//
// 처음엔 비어 있다. 피어메일을 쓰는 대화는 처음 보낼 때 한 번 묻는다 — 비어 있으면 세 값을, 있으면 그대로 쓸지를.
// 그 Paseo 대화(PASEO_AGENT_ID) 동안은 다시 묻지 않는다(압축해도 같은 대화). 확인한 값은 우편 항목(item.open)에 실려
// PC 중계기로 가고, 중계기는 그 값으로 대화를 연다. 값이 없으면 10-26 처럼 묻기 모드·그 기기 기본 모델·에포트.
// 기기마다 따로 기억한다(리규형님 버튼 "기기마다 따로" — PC 가 꺼져도 서버끼리 그대로 동작).
//
// 위치: <우편함 폴더>/open-config.json  { config: { model, thinkingOptionId, modeId } | null, confirmed: { 대화 번호: 시각 } }
//

const path = require('path');
const util = require('./util.cjs');
const mailbox = require('./mailbox.cjs');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{0,60}(\[1m\])?$/;
// 묻기 계열 — 이 권한으로 연 대화는 셸 명령에서 권한 창이 떠 멈춘다(중계기 안내문이 파일 도구로만 조사하게 한다)
const ASKING_MODES = ['default', 'acceptEdits'];
// 확인 기록은 최근 대화 것만 남긴다 — 대화마다 한 줄씩 끝없이 쌓이지 않게
const KEEP_CONFIRMED = 300;

function file() {
  return path.join(mailbox.base(), 'open-config.json');
}

// 맞는 칸만 남긴다(중계기는 서버에서 온 값을 이렇게 거른다). 남은 칸이 없으면 null
function clean(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (typeof c.model === 'string' && MODEL_RE.test(c.model)) out.model = c.model;
  if (EFFORTS.indexOf(c.thinkingOptionId) !== -1) out.thinkingOptionId = c.thinkingOptionId;
  if (MODES.indexOf(c.modeId) !== -1) out.modeId = c.modeId;
  return Object.keys(out).length ? out : null;
}

// 사람이 고른 세 값 — 하나라도 틀리면 이유 목록
function problems(c) {
  const p = [];
  if (!c.model || !MODEL_RE.test(c.model)) p.push('--model must be a Claude model id such as claude-opus-5-5');
  if (EFFORTS.indexOf(c.thinkingOptionId) === -1) p.push('--effort must be one of ' + EFFORTS.join('·'));
  if (MODES.indexOf(c.modeId) === -1) p.push('--mode must be one of ' + MODES.join('·'));
  return p;
}

function load() {
  const j = util.readJson(file(), null);
  const confirmed = j && j.confirmed && typeof j.confirmed === 'object' ? j.confirmed : {};
  return { config: clean(j && j.config), confirmed: confirmed };
}

function save(s) {
  const ids = Object.keys(s.confirmed).sort((a, b) => String(s.confirmed[b]).localeCompare(String(s.confirmed[a])));
  const confirmed = {};
  ids.slice(0, KEEP_CONFIRMED).forEach((id) => {
    confirmed[id] = s.confirmed[id];
  });
  util.writeJsonAtomic(file(), { config: s.config, confirmed: confirmed });
}

function confirmedHere(s, agentId) {
  return !!(agentId && s.confirmed[agentId]);
}

// 이 대화에서 확인했다고 적는다 — config 를 주면 기억도 그 값으로 바꾼다
function confirm(agentId, config) {
  const s = load();
  if (config) s.config = config;
  s.confirmed[agentId] = util.nowIso();
  save(s);
  return s;
}

function asking(modeId) {
  return ASKING_MODES.indexOf(modeId || 'default') !== -1;
}

module.exports = { EFFORTS, MODES, file, clean, problems, load, confirmedHere, confirm, asking };
