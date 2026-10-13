//
// mailbox.cjs — 기기마다 하나인 우편함 폴더 (peer_mail)
//
// 위치: <PASEO_HOME 또는 ~/.paseo>/peer-mail/
//   outbox/<id>.json   이 기기의 대화가 보낸 것 — PC 중계기가 가져간다(서버는 SSH 연결로, PC 는 바로)
//   sent/<id>.json     중계기가 가져갔다고 확인한 것
//   inbox/<id>.json    중계기가 이 기기로 보낸 알림(접수 확인·전달 상태) — 대화를 깨우지 않는 것들
//   inbox-done/        mail.cjs 가 기록에 반영한 알림
// 한 항목 = 파일 하나. 임시 이름으로 다 쓴 뒤 rename 으로 넣는다 — 반쪽 파일을 읽는 쪽이 없게.
// 🔴 이 폴더는 이 사용자만 읽고 쓴다(0700). 본문이 들어 있다.
//

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('./util.cjs');

// 한 항목 크기 상한 — 이보다 큰 본문은 파일 경로로 넘겨라(중계 연결 한 줄 = 한 항목이라 무한히 키우지 않는다)
const MAX_ITEM_BYTES = 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paseoHome() {
  return process.env.PASEO_HOME || path.join(os.homedir(), '.paseo');
}

function base() {
  return process.env.PEER_MAIL_HOME || path.join(paseoHome(), 'peer-mail');
}

function dir(name) {
  return path.join(base(), name);
}

function ensureDirs() {
  util.mkdirp(path.dirname(base())); // Paseo 홈 등 우편함 위 폴더는 기본 권한으로
  ['outbox', 'sent', 'inbox', 'inbox-done'].forEach((n) => {
    util.mkdirp(dir(n), util.PRIVATE_DIR_MODE); // 새로 만드는 우편함 폴더(peer-mail 포함)는 0700
    try {
      fs.chmodSync(dir(n), 448); // 0o700 — Windows 에서는 의미 없다
    } catch (e) {
      // 못 바꾸면 그대로
    }
  });
}

// 항목 하나가 우편함 크기 상한 안에 드는가 — 기록을 남기기 전에 먼저 재 본다(넣다가 실패해 기록만 남지 않게)
function fits(item) {
  const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
  return { ok: bytes <= MAX_ITEM_BYTES, bytes: bytes, max: MAX_ITEM_BYTES };
}

// 항목을 폴더에 넣는다 — 다 쓴 임시 파일을 rename. 같은 id 가 이미 있으면 덮지 않는다.
function put(folder, item) {
  if (!item || !ID_RE.test(item.id || '')) throw new Error('mailbox item needs a UUID id');
  const text = JSON.stringify(item);
  if (Buffer.byteLength(text, 'utf8') > MAX_ITEM_BYTES) throw new Error('mailbox item is larger than ' + MAX_ITEM_BYTES + ' bytes — shorten the body or point to a file');
  ensureDirs();
  const final = path.join(dir(folder), item.id + '.json');
  if (fs.existsSync(final)) return { file: final, existed: true };
  const tmp = path.join(dir(folder), '.' + item.id + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 384 });
  fs.renameSync(tmp, final);
  return { file: final, existed: false };
}

function list(folder) {
  try {
    return fs
      .readdirSync(dir(folder))
      // 정확한 UUID 이름만 — 느슨하면 다리의 ack 검사(NAME_RE)를 못 지나는 이름이 ping 마다 다시 올라간다(Codex 리뷰 261014_010400)
      .filter((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(n))
      .sort();
  } catch (e) {
    return [];
  }
}

function read(folder, name) {
  try {
    const st = fs.statSync(path.join(dir(folder), name));
    if (st.size > MAX_ITEM_BYTES) return null;
    const buf = fs.readFileSync(path.join(dir(folder), name));
    if (buf.length > MAX_ITEM_BYTES) return null; // 잰 뒤 읽기 전에 커진 파일(Codex 261013 #12)
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function move(from, to, name) {
  ensureDirs();
  try {
    fs.renameSync(path.join(dir(from), name), path.join(dir(to), name));
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { MAX_ITEM_BYTES, ID_RE, paseoHome, base, dir, ensureDirs, fits, put, list, read, move };
