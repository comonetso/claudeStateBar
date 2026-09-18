//
// store.cjs — 발신·수신 기록 (TODO I4)
//
// 위치: <저장소 루트>/docs/_msg/peer_req/<request_id>/
//   request.json        방향(outbound|inbound)·envelope·대상 스냅샷 — 처음 한 번만 게시한다(publishOnce)
//   events/<ms>-<rand>-<type>.json
//                       상태 변화 한 건 = 파일 한 개. 동시에 써도 서로 덮지 않는다
//   outbox/<이름>.txt   보낼(또는 보낸) 메시지 원문 — Claude 가 이 파일 내용을 SendMessage 로 넘긴다
//   result/<이름>.md    받은 결과 본문(발신 측) / 내가 보낸 결과(수신 측)
//
// 🔴 한 파일에 여러 프로세스가 append 하지 않는다. 이벤트는 항상 새 파일로 만든다(C7·Codex 6.2).
// 머신 전용 상태(선언·락)는 여기 두지 않는다 — Git 에 올라가면 안 된다. sessions.cjs 참고.
//

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');

const RECORD_SUBDIR = path.join('docs', '_msg', 'peer_req');
const BLOCK_BEGIN = '# >>> peer_req: records.commit=false';
const BLOCK_END = '# <<< peer_req';
const BLOCK = BLOCK_BEGIN + '\n*\n' + BLOCK_END + '\n';

// 결과 메시지 파일 — 확정(completed·failed)은 한 번만 게시하는 final, 임시(awaiting_user)는 덮어쓰는 result
const RESULT_FINAL = 'result-final.txt';
const RESULT_TEMP = 'result.txt';

function recordsRoot(repoRoot) {
  return path.join(repoRoot, RECORD_SUBDIR);
}

// D18: 기본은 커밋한다. 주소록 records.commit=false 면 기록 폴더의 .gitignore 에 우리 블록을 둔다.
// 사용자가 이미 만든 .gitignore 가 있어도 블록을 덧붙이고, 다시 켤 때는 그 블록만 뺀다(2차 리뷰 P2).
function applyCommitPolicy(repoRoot, commit) {
  const dir = recordsRoot(repoRoot);
  util.mkdirp(dir);
  const gi = path.join(dir, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : null;
  const has = cur !== null && cur.indexOf(BLOCK_BEGIN) !== -1;
  if (!commit) {
    if (has) return;
    const base = cur === null ? '' : cur.replace(/\s*$/, cur.length ? '\n' : '');
    util.writeFileAtomic(gi, base + BLOCK);
  } else if (has) {
    const re = new RegExp('\\n?' + BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + BLOCK_END + '\\n?');
    const rest = cur.replace(re, '\n').replace(/^\s+|\s+$/g, '');
    if (rest) util.writeFileAtomic(gi, rest + '\n');
    else fs.unlinkSync(gi);
  }
}

// 이 요청에 대해 보낼 결과 메시지 파일 — 확정본이 있으면 그것
function resultMessageFile(dir) {
  const fin = path.join(dir, 'outbox', RESULT_FINAL);
  if (fs.existsSync(fin)) return fin;
  const tmp = path.join(dir, 'outbox', RESULT_TEMP);
  return fs.existsSync(tmp) ? tmp : null;
}

function requestDir(repoRoot, requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('request_id 형식 오류: ' + requestId);
  return path.join(recordsRoot(repoRoot), requestId);
}

// 처음 게시할 때만 성공한다. 이미 있으면 { created:false, existing }.
// 게시된 request.json 은 항상 완성본이다 — 늦게 온 쪽이 반쪽 JSON 을 읽지 않는다(리뷰 P2).
// 폴백 경로에서 남이 선점만 하고 아직 붙이지 못했으면 { created:false, pending:true }.
function createRequestRecord(dir, meta) {
  util.mkdirp(path.join(dir, 'events'));
  const file = path.join(dir, 'request.json');
  if (util.publishOnce(file, JSON.stringify(meta, null, 2) + '\n')) return { created: true };
  const existing = util.readJson(file, null);
  if (existing) return { created: false, existing: existing };
  return { created: false, pending: util.publishPending(file) };
}

function readRequestRecord(dir) {
  return util.readJson(path.join(dir, 'request.json'), null);
}

function appendEvent(dir, event) {
  const evDir = path.join(dir, 'events');
  util.mkdirp(evDir);
  const ev = Object.assign({ at: util.nowIso() }, event);
  const safeType = String(ev.type || 'event').replace(/[^a-z_]/gi, '');
  for (let i = 0; i < 5; i++) {
    const name = Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '-' + safeType + '.json';
    if (util.publishOnce(path.join(evDir, name), JSON.stringify(ev, null, 2) + '\n')) return { file: name, event: ev };
  }
  throw new Error('이벤트 파일 이름 충돌이 반복됐다');
}

function listEvents(dir) {
  const evDir = path.join(dir, 'events');
  let names = [];
  try {
    names = fs.readdirSync(evDir).filter((n) => /\.json$/.test(n));
  } catch (e) {
    return [];
  }
  const out = [];
  names.forEach((n) => {
    try {
      out.push(Object.assign({ file: n }, JSON.parse(fs.readFileSync(path.join(evDir, n), 'utf8'))));
    } catch (e) {
      // 깨진 파일은 건너뛴다
    }
  });
  out.sort((a, b) => (a.at === b.at ? a.file.localeCompare(b.file) : a.at < b.at ? -1 : 1));
  return out;
}

function writeText(dir, sub, name, text) {
  const f = path.join(dir, sub, name);
  util.writeFileAtomic(f, text);
  return f;
}

function listRequestIds(repoRoot) {
  try {
    return fs.readdirSync(recordsRoot(repoRoot)).filter((n) => /^[0-9a-f-]{36}$/i.test(n));
  } catch (e) {
    return [];
  }
}

module.exports = { RECORD_SUBDIR, RESULT_FINAL, RESULT_TEMP, resultMessageFile, recordsRoot, applyCommitPolicy, requestDir, createRequestRecord, readRequestRecord, appendEvent, listEvents, writeText, listRequestIds };
