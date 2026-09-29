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
// 별칭은 사람이 부르는 이름이라 한글도 받는다(2026-09-21 사용자 결정). 공백은 받지 않는다 — 명령 인자로 넘기기 때문이다.
// 기록 파일 이름에는 별칭 대신 util.fileKey 를 쓴다.
// ⚠️ 0.1.x 는 한글 별칭 주소록을 "형식 오류" 로 읽는다 — 옛 버전으로 열려 있는 세션이 있으면 그 세션을 새로 연 뒤 쓴다.
const ALIAS_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_-]*$/;
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
    return { ok: false, errors: ['JSON syntax error: ' + e.message], warnings: warnings, book: null };
  }
  findDuplicateKeys(text).forEach((d) => errors.push('duplicate key: ' + d + ' (the later value silently overwrites the earlier one)'));

  if (!isObject(book)) return { ok: false, errors: ['the top level is not an object'], warnings: warnings, book: null };
  if (book.schema_version !== 1) errors.push('schema_version must be 1 (now: ' + JSON.stringify(book.schema_version) + ')');
  Object.keys(book).forEach((k) => {
    if (KNOWN_TOP.indexOf(k) === -1) warnings.push('unknown top-level key: ' + k + ' (ignored)');
  });

  const self = book.self;
  if (!isObject(self)) {
    errors.push('self is missing — it needs endpoint_id, machine_id and root');
  } else {
    if (!ID_RE.test(self.endpoint_id || '')) errors.push('self.endpoint_id has a bad format: ' + JSON.stringify(self.endpoint_id) + ' (lowercase letters, digits, . _ -)');
    if (!self.machine_id || typeof self.machine_id !== 'string') errors.push('self.machine_id is missing');
    if (!util.isAbsolutePath(self.root)) {
      errors.push('self.root must be an absolute path: ' + JSON.stringify(self.root));
    } else if (file && !util.samePath(self.root, path.dirname(path.resolve(file)))) {
      errors.push('self.root (' + self.root + ') differs from the folder holding the address book (' + path.dirname(path.resolve(file)) + ') — was it copied from another repository?');
    }
  }

  // peers 는 없어도 된다(받기 전용). 있으면 형식을 본다. 비어 있으면 "보낼 곳 없음" 은 prepare 가 알린다.
  const peers = book.peers;
  const endpointSeen = Object.create(null);
  if (self && self.endpoint_id) endpointSeen[self.endpoint_id] = 'self';
  if (peers !== undefined && !isObject(peers)) {
    errors.push('peers must be an object');
  } else if (peers) {
    Object.keys(peers).forEach((alias) => {
      const p = peers[alias];
      const at = 'peers.' + alias;
      if (!ALIAS_RE.test(alias)) errors.push(at + ': bad alias format (letters including Korean, digits, _ -, no spaces)');
      if (!isObject(p)) {
        errors.push(at + ': not an object');
        return;
      }
      if (!ID_RE.test(p.endpoint_id || '')) errors.push(at + '.endpoint_id has a bad format: ' + JSON.stringify(p.endpoint_id));
      else if (endpointSeen[p.endpoint_id]) errors.push(at + '.endpoint_id (' + p.endpoint_id + ') clashes with ' + endpointSeen[p.endpoint_id]);
      else endpointSeen[p.endpoint_id] = at;
      if (!p.machine_id || typeof p.machine_id !== 'string') errors.push(at + '.machine_id is missing');
      const loc = isObject(p.location) ? p.location : {};
      if (!util.isAbsolutePath(loc.root)) errors.push(at + '.location.root must be an absolute path: ' + JSON.stringify(loc.root));
      if (loc.os !== undefined && OS_VALUES.indexOf(loc.os) === -1) errors.push(at + '.location.os must be one of windows, linux, macos: ' + JSON.stringify(loc.os));
      if (loc.host_alias !== undefined && (typeof loc.host_alias !== 'string' || !HOST_RE.test(loc.host_alias))) {
        errors.push(at + '.location.host_alias must be a Host name from ~/.ssh/config (letters, digits, . _ @ -, not starting with -): ' + JSON.stringify(loc.host_alias));
      }
      const sameMachine = isObject(self) && util.sameMachine(p.machine_id, self.machine_id);
      if (sameMachine && p.machine_id !== self.machine_id) {
        warnings.push(at + '.machine_id (' + p.machine_id + ') differs from self (' + self.machine_id + ') only in letter case — treated as the same machine');
      }
      // rc_title 은 선택이다(D27) — 없으면 목록에서 한 번 고른 세션을 이 PC 가 기억한다. 적었다면 빈 값이면 안 된다.
      if (p.session_selector !== undefined && !isObject(p.session_selector)) {
        errors.push(at + '.session_selector must be an object');
      } else if (isObject(p.session_selector)) {
        const sel = p.session_selector;
        if (sel.rc_title !== undefined && !(typeof sel.rc_title === 'string' && sel.rc_title.trim())) {
          errors.push(at + '.session_selector.rc_title must be a non-empty string (the title to look for in the Remote Control list; leave it out if unknown — a session chosen from the list on the first send is remembered)');
        }
      }
      if (sameMachine && util.isAbsolutePath(loc.root) && util.samePath(loc.root, self.root)) {
        errors.push(at + ': same machine and same root — it lists itself as a peer');
      }
    });
  }

  const groups = book.groups;
  if (groups !== undefined) {
    if (!isObject(groups)) {
      errors.push('groups must be an object');
    } else {
      Object.keys(groups).forEach((g) => {
        const members = groups[g];
        if (!ALIAS_RE.test(g)) errors.push('groups.' + g + ': bad name format');
        if (peers && peers[g]) errors.push('groups.' + g + ': name clashes with a peer alias');
        if (!Array.isArray(members) || members.length === 0) {
          errors.push('groups.' + g + ': must be a non-empty array');
          return;
        }
        const seen = Object.create(null);
        members.forEach((m) => {
          if (!peers || !peers[m]) errors.push('groups.' + g + ': unknown peer ' + JSON.stringify(m));
          if (seen[m]) errors.push('groups.' + g + ': ' + m + ' appears twice');
          seen[m] = true;
        });
      });
    }
  }

  if (book.unattended !== undefined) {
    const u = book.unattended;
    if (!isObject(u) || (u.permission !== undefined && ['read_only', 'bypass'].indexOf(u.permission) === -1)) {
      errors.push('unattended must be { "permission": "read_only" | "bypass" }');
    }
  }

  if (book.records !== undefined) {
    const r = book.records;
    if (!isObject(r) || (r.commit !== undefined && typeof r.commit !== 'boolean')) {
      errors.push('records must be { "commit": true|false }');
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

// 그 폴더에 있는 주소록만 읽는다(위로 올라가지 않는다) — 짝 저장소의 주소록을 정확히 대조할 때 쓴다.
// 짝 폴더에 주소록이 없는데 상위 폴더의 다른 주소록을 짝의 것으로 읽으면 대조가 틀린다.
function loadBookAt(dir) {
  const file = path.join(dir, BOOK_NAME);
  if (!fs.existsSync(file)) return { found: false, file: file, root: dir, ok: false, errors: [], warnings: [], book: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { found: true, file: file, root: dir, ok: false, errors: ['could not read it: ' + e.message], warnings: [], book: null };
  }
  const r = validateBook(text, file);
  return { found: true, file: file, root: dir, ok: r.ok, errors: r.errors, warnings: r.warnings, book: r.book };
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

module.exports = { BOOK_NAME, ID_RE, ALIAS_RE, HOST_RE, findBook, findDuplicateKeys, validateBook, loadBook, loadBookAt, peersOf, expandTarget, recordsCommitted };
