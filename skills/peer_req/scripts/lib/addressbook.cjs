//
// addressbook.cjs — 주소록(.peer_req.json) 찾기·파싱·검증 (TODO I2)
//
// 주소록은 **모든 참여 저장소의 루트**에 둔다.
//   · 보내는 저장소 : self + peers(보낼 짝)
//   · 받기만 하는 저장소 : self 만 있어도 된다 — 하지만 **self 는 반드시 있어야 한다**.
//     받는 쪽이 "내 앞으로 온 게 맞나" 를 확인하려면 자기 정체를 알아야 하기 때문이다(2026-09-19 사용자 결정).
// 옛 remote_req 처럼 양쪽 파일의 thread UUID 를 짝 맞추지 않는다.
//
// 🔴 파싱은 JSON 파서로 한다. JSON.parse 는 중복 키를 조용히 덮어쓰므로 중복 별칭은 따로 훑어서 잡는다.
//

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');

const BOOK_NAME = '.peer_req.json';

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// SSH 별칭 — 앞에 '-' 가 오면 ssh 가 옵션으로 읽는다(-oProxyCommand=… 로 로컬 명령 실행, 리뷰 P1)
const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;
const KNOWN_TOP = ['schema_version', 'self', 'peers', 'groups', 'records', 'unattended'];
const OS_VALUES = ['windows', 'linux', 'macos'];

// start 부터 위로 올라가며 주소록을 찾는다. 없으면 null.
function findBook(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    const f = path.join(dir, BOOK_NAME);
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// JSON.parse 가 삼키는 중복 키를 찾는다. 반환: ['peers.api', …]
function findDuplicateKeys(text) {
  const dups = [];
  const stack = [];
  const pathOf = (parent) => {
    if (!parent) return [];
    return parent.path.concat([parent.type === 'obj' ? parent.lastKey : '[]']);
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < n) {
        const c = text[j];
        if (c === '\\') {
          raw += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === '"') break;
        raw += c;
        j++;
      }
      const top = stack[stack.length - 1];
      if (top && top.type === 'obj' && top.expectKey) {
        let key = raw;
        try {
          key = JSON.parse('"' + raw + '"');
        } catch (e) {
          // 그대로 쓴다
        }
        if (top.keys[key]) dups.push(top.path.concat([key]).join('.'));
        top.keys[key] = true;
        top.lastKey = key;
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push({ type: 'obj', keys: Object.create(null), path: pathOf(stack[stack.length - 1]), expectKey: true, lastKey: null });
    } else if (ch === '[') {
      stack.push({ type: 'arr', path: pathOf(stack[stack.length - 1]) });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.type === 'obj') top.expectKey = true;
    }
    i++;
  }
  return dups;
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 주소록 텍스트를 검증한다. file 은 위치 대조용(self.root 가 파일이 있는 폴더와 같아야 한다).
function validateBook(text, file) {
  const errors = [];
  const warnings = [];
  let book;
  try {
    book = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ['JSON 문법 오류: ' + e.message], warnings: warnings, book: null };
  }
  findDuplicateKeys(text).forEach((d) => errors.push('중복 키: ' + d + ' (뒤의 값이 앞의 값을 조용히 덮는다)'));

  if (!isObject(book)) return { ok: false, errors: ['최상위가 객체가 아니다'], warnings: warnings, book: null };
  if (book.schema_version !== 1) errors.push('schema_version 은 1 이어야 한다 (지금: ' + JSON.stringify(book.schema_version) + ')');
  Object.keys(book).forEach((k) => {
    if (KNOWN_TOP.indexOf(k) === -1) warnings.push('모르는 최상위 키: ' + k + ' (무시한다)');
  });

  const self = book.self;
  if (!isObject(self)) {
    errors.push('self 가 없다 — endpoint_id·machine_id·root 가 필요하다');
  } else {
    if (!ID_RE.test(self.endpoint_id || '')) errors.push('self.endpoint_id 형식 오류: ' + JSON.stringify(self.endpoint_id) + ' (소문자·숫자·. _ -)');
    if (!self.machine_id || typeof self.machine_id !== 'string') errors.push('self.machine_id 가 없다');
    if (!util.isAbsolutePath(self.root)) {
      errors.push('self.root 는 절대경로여야 한다: ' + JSON.stringify(self.root));
    } else if (file && !util.samePath(self.root, path.dirname(path.resolve(file)))) {
      errors.push('self.root(' + self.root + ') 가 주소록이 있는 폴더(' + path.dirname(path.resolve(file)) + ')와 다르다 — 다른 저장소에서 복사해 온 주소록인가?');
    }
  }

  // peers 는 없어도 된다(받기 전용). 있으면 형식을 본다. 비어 있으면 "보낼 곳 없음" 은 prepare 가 알린다.
  const peers = book.peers;
  const endpointSeen = Object.create(null);
  if (self && self.endpoint_id) endpointSeen[self.endpoint_id] = 'self';
  if (peers !== undefined && !isObject(peers)) {
    errors.push('peers 는 객체여야 한다');
  } else if (peers) {
    Object.keys(peers).forEach((alias) => {
      const p = peers[alias];
      const at = 'peers.' + alias;
      if (!ALIAS_RE.test(alias)) errors.push(at + ': 별칭 형식 오류 (영문·숫자·_ -)');
      if (!isObject(p)) {
        errors.push(at + ': 객체가 아니다');
        return;
      }
      if (!ID_RE.test(p.endpoint_id || '')) errors.push(at + '.endpoint_id 형식 오류: ' + JSON.stringify(p.endpoint_id));
      else if (endpointSeen[p.endpoint_id]) errors.push(at + '.endpoint_id(' + p.endpoint_id + ') 가 ' + endpointSeen[p.endpoint_id] + ' 와 겹친다');
      else endpointSeen[p.endpoint_id] = at;
      if (!p.machine_id || typeof p.machine_id !== 'string') errors.push(at + '.machine_id 가 없다');
      const loc = isObject(p.location) ? p.location : {};
      if (!util.isAbsolutePath(loc.root)) errors.push(at + '.location.root 는 절대경로여야 한다: ' + JSON.stringify(loc.root));
      if (loc.os !== undefined && OS_VALUES.indexOf(loc.os) === -1) errors.push(at + '.location.os 는 windows·linux·macos 중 하나: ' + JSON.stringify(loc.os));
      if (loc.host_alias !== undefined && (typeof loc.host_alias !== 'string' || !HOST_RE.test(loc.host_alias))) {
        errors.push(at + '.location.host_alias 는 ~/.ssh/config 의 Host 이름이어야 한다(영문·숫자·. _ @ -, 첫 글자 - 금지): ' + JSON.stringify(loc.host_alias));
      }
      const sameMachine = isObject(self) && p.machine_id === self.machine_id;
      // rc_title 은 선택이다(D27) — 없으면 목록에서 한 번 고른 세션을 이 PC 가 기억한다. 적었다면 빈 값이면 안 된다.
      if (p.session_selector !== undefined && !isObject(p.session_selector)) {
        errors.push(at + '.session_selector 는 객체여야 한다');
      } else if (isObject(p.session_selector)) {
        const sel = p.session_selector;
        if (sel.rc_title !== undefined && !(typeof sel.rc_title === 'string' && sel.rc_title.trim())) {
          errors.push(at + '.session_selector.rc_title 은 비어 있지 않은 문자열이어야 한다 (Remote Control 목록에서 찾을 제목. 모르면 빼라 — 처음 보낼 때 목록에서 고르면 기억한다)');
        }
      }
      if (sameMachine && util.isAbsolutePath(loc.root) && util.samePath(loc.root, self.root)) {
        errors.push(at + ': 같은 머신의 같은 root 다 — 자기 자신을 짝으로 적었다');
      }
    });
  }

  const groups = book.groups;
  if (groups !== undefined) {
    if (!isObject(groups)) {
      errors.push('groups 는 객체여야 한다');
    } else {
      Object.keys(groups).forEach((g) => {
        const members = groups[g];
        if (!ALIAS_RE.test(g)) errors.push('groups.' + g + ': 이름 형식 오류');
        if (peers && peers[g]) errors.push('groups.' + g + ': 짝 별칭과 이름이 겹친다');
        if (!Array.isArray(members) || members.length === 0) {
          errors.push('groups.' + g + ': 비어 있지 않은 배열이어야 한다');
          return;
        }
        const seen = Object.create(null);
        members.forEach((m) => {
          if (!peers || !peers[m]) errors.push('groups.' + g + ': 없는 짝 ' + JSON.stringify(m));
          if (seen[m]) errors.push('groups.' + g + ': ' + m + ' 가 두 번 들어 있다');
          seen[m] = true;
        });
      });
    }
  }

  if (book.unattended !== undefined) {
    const u = book.unattended;
    if (!isObject(u) || (u.permission !== undefined && ['read_only', 'bypass'].indexOf(u.permission) === -1)) {
      errors.push('unattended 는 { "permission": "read_only" | "bypass" } 형식이어야 한다');
    }
  }

  if (book.records !== undefined) {
    const r = book.records;
    if (!isObject(r) || (r.commit !== undefined && typeof r.commit !== 'boolean')) {
      errors.push('records 는 { "commit": true|false } 형식이어야 한다');
    }
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings, book: book };
}

// 찾고 읽고 검증까지. 없으면 { found:false }.
function loadBook(start) {
  const file = findBook(start);
  if (!file) return { found: false, file: null, root: null, ok: false, errors: [], warnings: [], book: null };
  const text = fs.readFileSync(file, 'utf8');
  const r = validateBook(text, file);
  return { found: true, file: file, root: path.dirname(file), ok: r.ok, errors: r.errors, warnings: r.warnings, book: r.book };
}

function peersOf(book) {
  return isObject(book && book.peers) ? book.peers : {};
}

// 별칭 또는 그룹 이름 → 별칭 목록. 없으면 null.
function expandTarget(book, name) {
  const peers = peersOf(book);
  if (peers[name]) return [name];
  if (book.groups && Array.isArray(book.groups[name])) return book.groups[name].slice();
  return null;
}

function recordsCommitted(book) {
  return !(book && book.records && book.records.commit === false);
}

module.exports = { BOOK_NAME, ID_RE, HOST_RE, findBook, findDuplicateKeys, validateBook, loadBook, peersOf, expandTarget, recordsCommitted };
