#!/usr/bin/env node
// 팀원 Claude 의 프로젝트 밖 막기 — Claude Code PreToolUse 훅(10-25 리규형님 지시 2항 "프로젝트 밖으로는 이동할 수 없다" ·
// 버튼 "훅으로 셸 명령 검사" · "팀원이 시스템 점검까지는 할 수 있어야" → "기록·서비스 상태까지" · 임시 폴더 열기 · 쓰기 도구도 거절).
// 실행기(staff-policy.mjs)가 팀원 Claude 의 명령줄 설정(--settings)에 걸어 둔다 — 팀원 설정 파일로는 끌 수 없다.
// 작업 폴더 밖 읽기 막기 설정(blockReadsOutsideWorkingDirectories)은 파일 도구(Read·Grep·Glob)만 거절하고 셸의 cat·ls·cd 는 허락 창으로
// 바꿀 뿐이다(공식 문서 permissions · 10-25 blueming 실측) — 셸 명령과 쓰기 도구는 여기서 본다.
// 팀원을 막으려는 것이 아니라 Claude 의 실수를 막는 것이다(지시 3-2). 셸 문법을 흉내 내 경로를 뽑으므로 스크립트가 안에서 여는 파일이나
// 변수로 만든 경로는 보지 못한다. 판정하다 오류가 나면 막지 않는다(출력 없음).
//   일하는 곳(읽기·쓰기·이동): 프로젝트(작업 폴더·--add-dir) · 팀원 홈 · 임시 폴더(/tmp·/var/tmp — 울타리 안 팀원 전용)
//   점검 경로(읽기만 — 이동·쓰기 거절): 시스템 기록 · journal · /proc · /sys · /etc · 프로그램 폴더
//   그 밖: 거절 — 허락 창 없이 Claude 에게 이유를 알린다
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const P = path.posix;
export const TEMP_DIRS = ["/tmp", "/var/tmp"];
/** 점검 경로 — 읽기만. 울타리가 붙인 것만 실제로 보인다(paseo-team@.service) */
export const READ_ONLY_DIRS = ["/proc", "/sys", "/var/log", "/run/log/journal", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt/paseo-team"];
/** 장치·표준 입출력 — 어디서든 읽고 쓴다(2>/dev/null 같은 것) */
const DEVICES = ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/fd", "/proc/self/fd"];

const within = (p, base) => p === base || p.startsWith(base === "/" ? "/" : base + "/");
const isName = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** 있는 데까지 실제 경로로(심볼릭 링크 풀기) — 없는 꼬리는 그대로 붙인다 */
export function realish(p, realpath = fs.realpathSync) {
  let cur = p;
  const rest = [];
  for (let n = 0; n < 4096; n++) {
    try {
      const r = realpath(cur);
      return rest.length ? P.join(r, ...rest.reverse()) : r;
    } catch {
      const parent = P.dirname(cur);
      if (parent === cur) return p;
      rest.push(P.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/**
 * 한 경로 판정 — kind: read | write | cd. 됨이면 null, 아니면 { path, kind, zone }
 * zone: "readonly"(점검 경로에 쓰기·이동) · "outside"(그 밖)
 */
export function judgePath(raw, kind, opts) {
  const abs = P.resolve(opts.cwd, raw);
  if (DEVICES.some((d) => within(abs, d))) return null;
  const real = realish(abs, opts.realpath);
  if (opts.work.some((w) => within(real, w))) return null;
  if (READ_ONLY_DIRS.some((d) => within(real, d))) return kind === "read" ? null : { path: real, kind, zone: "readonly" };
  return { path: real, kind, zone: "outside" };
}

// ── 셸 명령 쪼개기 — 단어·리다이렉션·명령 경계·치환·heredoc 만 흉내 낸다 ──

/** 여는 괄호 다음부터 짝 맞는 닫는 괄호까지(따옴표 안 괄호는 세지 않음) — [안쪽 글, 닫는 괄호 다음 위치] */
function readBalanced(src, i, open, close) {
  let depth = 1;
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return [src.slice(start, i), i + 1];
    i++;
  }
  return [src.slice(start), src.length];
}

const REDIR_OPS = ["&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<&", "<>", "<<", ">", "<"];

/**
 * 셸 글 → { cmds: [{ words, redirs }], subs: [치환 안쪽 글] }
 * 단어: { text, dynamic(값을 모르는 변수·치환이 섞임), glob(따옴표 밖 * ? [) }
 */
export function lex(src, env) {
  const cmds = [];
  const subs = [];
  let cmd = { words: [], redirs: [] };
  let word = null;
  let pendingRedir = null;
  const heredocs = [];
  const startWord = () => { word ??= { text: "", dynamic: false, glob: false, tilde: false }; };
  const endWord = () => {
    if (!word) return;
    if (word.tilde) {
      const m = /^~([^/]*)(.*)$/s.exec(word.text);
      if (m) word.text = (m[1] ? P.join("/home", m[1]) : env.home || "~") + m[2];
    }
    if (pendingRedir) {
      if (pendingRedir === "<<" || pendingRedir === "<<-") heredocs.push(word.text);
      else if (pendingRedir === ">&" || pendingRedir === "<&") {
        if (!/^(\d+-?|-)$/.test(word.text)) cmd.redirs.push({ op: ">", word });
      } else if (pendingRedir !== "<<<") cmd.redirs.push({ op: pendingRedir, word });
      pendingRedir = null;
    } else cmd.words.push(word);
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (cmd.words.length || cmd.redirs.length) cmds.push(cmd);
    cmd = { words: [], redirs: [] };
  };
  const dollar = (i, inQuote) => {
    // src[i] === "$"
    const n = src[i + 1];
    if (n === "(" && src[i + 2] === "(") { const [, j] = readBalanced(src, i + 3, "(", ")"); word.dynamic = true; return src[j] === ")" ? j + 1 : j; }
    if (n === "(") { const [inner, j] = readBalanced(src, i + 2, "(", ")"); subs.push(inner); word.dynamic = true; return j; }
    if (n === "{") {
      const j = src.indexOf("}", i + 2);
      const name = src.slice(i + 2, j < 0 ? src.length : j);
      if (name === "HOME" && env.home) word.text += env.home;
      else if (name === "PWD") word.text += env.cwd;
      else word.dynamic = true;
      return j < 0 ? src.length : j + 1;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
    if (m) {
      if (m[0] === "HOME" && env.home) word.text += env.home;
      else if (m[0] === "PWD") word.text += env.cwd;
      else word.dynamic = true;
      return i + 1 + m[0].length;
    }
    if (n && /[0-9@*#?$!-]/.test(n)) { word.dynamic = true; return i + 2; }
    word.text += "$";
    void inQuote;
    return i + 1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      endCmd();
      i++;
      // heredoc 본문 — 구분자 줄까지 건너뛴다
      while (heredocs.length) {
        const delim = heredocs.shift();
        for (;;) {
          const j = src.indexOf("\n", i);
          const line = src.slice(i, j < 0 ? src.length : j);
          i = j < 0 ? src.length : j + 1;
          if (line.replace(/^\t+/, "") === delim || j < 0) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t") { endWord(); i++; continue; }
    if (c === "#" && !word) { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (c === "\\") {
      if (src[i + 1] === "\n") { i += 2; continue; }
      startWord();
      word.text += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      const j = src.indexOf("'", i + 1);
      word.text += src.slice(i + 1, j < 0 ? src.length : j);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === "\\" && /["\\$`\n]/.test(src[i + 1] ?? "")) { if (src[i + 1] !== "\n") word.text += src[i + 1]; i += 2; continue; }
        if (d === "$") { i = dollar(i, true); continue; }
        if (d === "`") { const j = src.indexOf("`", i + 1); subs.push(src.slice(i + 1, j < 0 ? src.length : j)); word.dynamic = true; i = j < 0 ? src.length : j + 1; continue; }
        word.text += d;
        i++;
      }
      i++;
      continue;
    }
    if (c === "`") {
      startWord();
      const j = src.indexOf("`", i + 1);
      subs.push(src.slice(i + 1, j < 0 ? src.length : j));
      word.dynamic = true;
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === "$") { startWord(); i = dollar(i, false); continue; }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const [inner, j] = readBalanced(src, i + 2, "(", ")");
      subs.push(inner);
      startWord();
      word.dynamic = true;
      i = j;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // 숫자만 든 단어 바로 뒤면 그 숫자는 파일 번호(2>file)
      if (word && /^\d+$/.test(word.text) && !word.dynamic) word = null;
      else endWord();
      const op = REDIR_OPS.find((o) => src.startsWith(o, i));
      pendingRedir = op;
      i += op.length;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") { endCmd(); i++; continue; }
    startWord();
    if (c === "~" && word.text === "" && !word.dynamic) word.tilde = true;
    if (c === "*" || c === "?" || c === "[") word.glob = true;
    word.text += c;
    i++;
  }
  endCmd();
  return { cmds, subs };
}

// ── 명령별로 경로 단어 고르기 ──

const NO_PATH_ARGS = new Set(["echo", "printf", "true", "false", "test", "[", "[[", "]]", "exit", "return", "export", "unset", "alias",
  "unalias", "set", "shift", "read", "local", "declare", "typeset", "readonly", "wait", "jobs", "kill", "pkill", "sleep", "which", "type",
  "hash", "history", "help", "let", "eval", "trap", "umask", "ulimit", "getopts", "break", "continue",
  // 점검 — 내용을 읽지 않는다(경로는 파일시스템·대상 지정일 뿐)
  "df", "findmnt", "mount", "lsblk", "blkid", "free", "uptime", "ps", "pgrep", "top", "htop", "uname", "hostname", "whoami", "id", "groups",
  "date", "nproc", "lscpu", "lsmem", "vmstat", "iostat", "mpstat", "ss", "netstat", "ip", "ping", "dig", "nslookup", "host",
  "systemctl", "journalctl", "loginctl", "timedatectl", "hostnamectl", "stat", "file", "realpath", "readlink", "dirname", "basename", "pwd"]);
const RESERVED = new Set(["{", "}", "!", "if", "then", "else", "elif", "while", "until", "do", "time", "coproc", "exec", "command", "builtin", "nohup"]);
const ENDERS = new Set(["fi", "done", "esac", ";;"]);
const WRITE_ALL = new Set(["rm", "rmdir", "unlink", "touch", "mkdir", "truncate", "shred", "tee", "chmod", "chown", "chgrp", "chattr",
  "setfacl", "mkfifo", "mknod", "mv"]);
const COPY_LIKE = new Set(["cp", "rsync", "install", "scp"]);
const INTERP = new Set(["perl", "python", "python2", "python3", "node", "ruby", "php", "bash", "sh", "zsh", "dash", "ksh"]);

/** 옵션 다음 단어를 값으로 먹는 옵션 — 명령별(근사) */
const VALUE_OPTS = {
  grep: ["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--context"],
  rg: ["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "--regexp", "--file", "--glob", "--type", "--type-not", "--max-count"],
  sed: ["-e", "-f", "-l", "--expression", "--file"],
  awk: ["-f", "-v", "-F", "--file", "--assign", "--field-separator"],
  find: [],
  xargs: ["-I", "-L", "-n", "-P", "-d", "-s", "-E", "-a"],
  env: ["-u", "-C", "-S", "--unset", "--chdir"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-U"],
  nice: ["-n"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  ionice: ["-c", "-n", "-p"],
  watch: ["-n", "-d", "--interval"],
  stdbuf: ["-i", "-o", "-e"],
  cp: ["-t", "-S", "--target-directory", "--suffix"],
  mv: ["-t", "-S", "--target-directory", "--suffix"],
  ln: ["-t", "-S", "--target-directory", "--suffix"],
  install: ["-t", "-m", "-o", "-g", "-S", "--target-directory", "--mode", "--owner", "--group"],
  tar: ["-f", "-C", "-T", "-X", "--file", "--directory", "--files-from", "--exclude-from"],
  git: ["-C", "-c"],
  ssh: ["-i", "-p", "-l", "-o", "-F", "-L", "-R", "-D", "-J"],
  scp: ["-i", "-P", "-o", "-F", "-J"],
  rsync: ["-e", "--rsh", "--exclude-from", "--include-from", "--files-from"],
  truncate: ["-s", "--size", "-r", "--reference"],
  chmod: ["--reference"],
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  python: ["-c", "-m", "-W", "-X"],
  node: ["-e", "-p", "-r", "--eval", "--print", "--require"],
  perl: ["-e", "-E", "-I", "-M", "-m"],
  ruby: ["-e", "-I", "-r"],
  php: ["-r", "-c", "-d"],
  bash: ["-c", "-o"],
};
VALUE_OPTS.egrep = VALUE_OPTS.fgrep = VALUE_OPTS.grep;
VALUE_OPTS.gawk = VALUE_OPTS.mawk = VALUE_OPTS.nawk = VALUE_OPTS.awk;
VALUE_OPTS.python2 = VALUE_OPTS.python3 = VALUE_OPTS.python;
VALUE_OPTS.sh = VALUE_OPTS.zsh = VALUE_OPTS.dash = VALUE_OPTS.ksh = VALUE_OPTS.bash;

/** 단어 → [옵션 아닌 단어들, 옵션 값 { opt, word }들] */
function splitArgs(name, words) {
  const takes = new Set(VALUE_OPTS[name] ?? []);
  const plain = [];
  const values = [];
  let ended = false;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (ended || w.dynamic || !w.text.startsWith("-") || w.text === "-") { plain.push(w); continue; }
    if (w.text === "--") { ended = true; continue; }
    const eq = w.text.indexOf("=");
    if (w.text.startsWith("--") && eq > 0) { values.push({ opt: w.text.slice(0, eq), word: { ...w, text: w.text.slice(eq + 1) } }); continue; }
    if (takes.has(w.text) && k + 1 < words.length) { values.push({ opt: w.text, word: words[++k] }); continue; }
    // 붙은 짧은 옵션 값(-f/path · -C/path)
    const short = w.text.slice(0, 2);
    if (!w.text.startsWith("--") && w.text.length > 2 && takes.has(short)) values.push({ opt: short, word: { ...w, text: w.text.slice(2) } });
  }
  return { plain, values };
}

/** 경로로 볼 단어인가 — 값을 모르는 단어는 못 본다 · 글롭은 앞쪽 고정 부분 */
function pathText(w) {
  if (!w || w.dynamic) return null;
  let t = w.text;
  if (!t) return null;
  if (w.glob) {
    const m = /^[^*?[]*/.exec(t)[0];
    const cut = m.lastIndexOf("/");
    if (cut < 0) return null;
    t = cut === 0 ? "/" : m.slice(0, cut);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  if (/^[^/]*:/.test(t) && !t.startsWith("/")) return null;
  return t;
}

/**
 * 명령 하나 판정 — 됨이면 null, 아니면 위반
 * 순서대로 cd 를 따라가며 cwd 를 바꾼다(근사 — 괄호 서브셸도 이어지는 것으로 본다)
 */
function judgeSimple(cmd, ctx, depth) {
  const check = (w, kind) => {
    const t = pathText(w);
    if (t === null) return null;
    // 상대 경로는 있는 것만(새로 만들 파일은 지금 폴더 안 — 심볼릭 링크로 밖을 가리키는 것만 잡는다)
    if (!t.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(t)) {
      try { (ctx.lstat ?? fs.lstatSync)(P.resolve(ctx.cwd, t)); } catch { return null; }
    }
    return judgePath(t, kind, ctx);
  };
  for (const r of cmd.redirs) {
    const v = check(r.word, r.op === "<" ? "read" : "write");
    if (v) return v;
  }
  let words = cmd.words.slice();
  // 앞의 변수 대입(X=값 명령) — 값을 모르는 대입(X=$(…))이어도 뒤 명령은 본다
  while (words.length && words[0].text.includes("=") && isName(words[0].text.split("=")[0])) words.shift();
  for (let guard = 0; words.length && guard < 16; guard++) {
    const head = words[0];
    if (head.dynamic) return null;
    const name = P.basename(head.text);
    if (ENDERS.has(name)) return null;
    if (RESERVED.has(name)) { words = words.slice(1); continue; }
    if (name === "for" || name === "select") {
      const at = words.findIndex((w) => w.text === "in");
      for (const w of at < 0 ? [] : words.slice(at + 1)) { const v = check(w, "read"); if (v) return v; }
      return null;
    }
    if (name === "case") return null;
    if (["env", "sudo", "nice", "timeout", "ionice", "stdbuf", "xargs", "watch"].includes(name)) {
      const { plain } = splitArgs(name, words.slice(1));
      let rest = plain;
      while (rest.length && (rest[0].text.includes("=") && isName(rest[0].text.split("=")[0]))) rest = rest.slice(1);
      if (name === "timeout" && rest.length) rest = rest.slice(1);
      const idx = rest.length ? words.indexOf(rest[0]) : -1;
      if (idx < 0) return null;
      words = words.slice(idx);
      continue;
    }
    break;
  }
  if (!words.length) return null;
  const head = words[0];
  const name = P.basename(head.text);
  const args = words.slice(1);
  // 실행 파일을 경로로 부르면 그 파일을 읽는 것
  if (head.text.includes("/")) { const v = check(head, "read"); if (v) return v; }
  if (NO_PATH_ARGS.has(name)) return null;
  const { plain, values } = splitArgs(name, args);
  const each = (list, kind) => { for (const w of list) { const v = check(w, kind); if (v) return v; } return null; };
  const optVal = (opts) => values.filter((x) => opts.includes(x.opt)).map((x) => x.word);

  if (name === "cd" || name === "pushd") {
    const target = plain[0];
    if (!target) return null;
    if (target.text === "-" || target.dynamic) return null;
    const v = check(target, "cd");
    if (v) return v;
    const t = pathText(target);
    if (t) ctx.cwd = P.resolve(ctx.cwd, t);
    return null;
  }
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") {
    const hasPattern = values.some((x) => ["-e", "--regexp", "-f", "--file"].includes(x.opt));
    return each(optVal(["-f", "--file"]), "read") ?? each(hasPattern ? plain : plain.slice(1), "read");
  }
  if (name === "sed") {
    const inPlace = args.some((w) => !w.dynamic && /^(-[a-zA-Z]*i|--in-place)/.test(w.text));
    const hasScript = values.some((x) => ["-e", "--expression", "-f", "--file"].includes(x.opt));
    return each(optVal(["-f", "--file"]), "read") ?? each(hasScript ? plain : plain.slice(1), inPlace ? "write" : "read");
  }
  if (["awk", "gawk", "mawk", "nawk"].includes(name)) {
    const hasProg = values.some((x) => ["-f", "--file"].includes(x.opt));
    const files = (hasProg ? plain : plain.slice(1)).filter((w) => !(w.text.includes("=") && isName(w.text.split("=")[0])));
    return each(optVal(["-f", "--file"]), "read") ?? each(files, "read");
  }
  if (INTERP.has(name)) {
    const code = values.find((x) => ["-c", "-e", "-E", "-r", "--eval", "-p", "--print"].includes(x.opt));
    if (code && ["bash", "sh", "zsh", "dash", "ksh"].includes(name)) return judgeCommand(code.word.dynamic ? "" : code.word.text, ctx, depth + 1);
    // 스크립트 파일과 그 인자 — 코드 글(-c·-e) 안에서 여는 파일은 못 본다
    return each(plain, "read");
  }
  if (name === "source" || name === ".") return each(plain.slice(0, 1), "read");
  if (name === "find") {
    const starts = [];
    for (const w of args) { if (!w.dynamic && /^[-(!]/.test(w.text)) break; starts.push(w); }
    const del = args.some((w) => w.text === "-delete");
    const v = each(starts, del ? "write" : "read");
    if (v) return v;
    // -exec … ; 안의 명령
    for (let k = 0; k < args.length; k++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k].text)) continue;
      const end = args.findIndex((w, j) => j > k && (w.text === ";" || w.text === "+"));
      const sub = args.slice(k + 1, end < 0 ? args.length : end).filter((w) => w.text !== "{}");
      const r = judgeSimple({ words: sub, redirs: [] }, ctx, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (WRITE_ALL.has(name)) return each(optVal(["-t", "--target-directory"]), "write") ?? each(plain, "write");
  if (COPY_LIKE.has(name)) {
    const target = optVal(["-t", "--target-directory"]);
    if (target.length) return each(target, "write") ?? each(plain, "read");
    return each(plain.slice(-1), "write") ?? each(plain.slice(0, -1), "read");
  }
  if (name === "ln") {
    const target = optVal(["-t", "--target-directory"]);
    if (target.length) return each(target, "write");
    return plain.length >= 2 ? each(plain.slice(-1), "write") : null;
  }
  if (name === "dd") {
    for (const w of plain) {
      if (w.text.startsWith("if=")) { const v = check({ ...w, text: w.text.slice(3) }, "read"); if (v) return v; }
      if (w.text.startsWith("of=")) { const v = check({ ...w, text: w.text.slice(3) }, "write"); if (v) return v; }
    }
    return null;
  }
  if (name === "tar") {
    return each(optVal(["-C", "--directory"]), "write") ?? each(optVal(["-f", "--file", "-T", "--files-from", "-X", "--exclude-from"]), "read") ?? each(plain, "read");
  }
  if (name === "git") return each(optVal(["-C"]), "read") ?? each(plain, "read");
  if (name === "ssh") return each(optVal(["-i", "-F"]), "read");
  // 그 밖 — 경로처럼 생긴 인자와 옵션 값은 읽기로 본다
  return each(values.map((x) => x.word), "read") ?? each(plain, "read");
}

/** 셸 명령 글 판정 — 됨이면 null */
export function judgeCommand(command, ctx, depth = 0) {
  if (depth > 8 || typeof command !== "string" || !command.trim()) return null;
  const { cmds, subs } = lex(command, ctx);
  for (const cmd of cmds) {
    const v = judgeSimple(cmd, ctx, depth);
    if (v) return v;
  }
  for (const s of subs) {
    const v = judgeCommand(s, { ...ctx }, depth + 1);
    if (v) return v;
  }
  return null;
}

/** 훅 입력 하나 판정 — 됨이면 null */
export function judgeTool(input, opts) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  const ctx = { ...opts, cwd: typeof input?.cwd === "string" && input.cwd.startsWith("/") ? input.cwd : opts.work[0] };
  if (tool === "Bash" || tool === "Monitor") return judgeCommand(ti.command, ctx);
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = ti.file_path ?? ti.notebook_path;
    return typeof file === "string" && file ? judgePath(file, "write", ctx) : null;
  }
  return null;
}

const VERB = { read: "읽으려", write: "쓰려", cd: "그곳으로 이동하려" };
export function reasonText(v, opts) {
  const where = opts.roots.join(" · ");
  const head = v.zone === "readonly"
    ? `[팀원 보호] 실행하지 않았다 — ${v.path} 는 서버 점검용 경로라 읽기만 된다(${VERB[v.kind]} 했다).`
    : `[팀원 보호] 실행하지 않았다 — 프로젝트 밖 ${v.path} 를 ${VERB[v.kind]} 했다.`;
  return `${head} 팀원 Claude 는 프로젝트 폴더(${where})·팀원 홈·임시 폴더(/tmp) 안에서만 읽고 쓰고 이동한다. ` +
    `서버 점검용 시스템 기록(/var/log·journalctl)·/proc·/sys·/etc 는 cd 없이 절대 경로로 읽기만 된다. ` +
    `프로젝트 안에서 할 방법을 쓰고, 꼭 밖이 필요하면 사용자에게 그 이유를 말하라.`;
}

function parseArgs(argv) {
  const roots = [];
  let home = "";
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--root" && argv[k + 1]) roots.push(argv[++k]);
    else if (argv[k] === "--home" && argv[k + 1]) home = argv[++k];
  }
  return { roots, home };
}

/** 일하는 곳 목록 — 실제 경로로 */
export function workDirs({ roots, home }, realpath = fs.realpathSync) {
  const list = [...roots, ...(home ? [home] : []), ...TEMP_DIRS].filter((p) => typeof p === "string" && p.startsWith("/") && p !== "/");
  return [...new Set(list.map((p) => realish(P.resolve(p), realpath)))];
}

async function main() {
  try {
    const { roots, home } = parseArgs(process.argv.slice(2));
    if (!roots.length) return;
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const opts = { roots, home: home ? realish(home) : "", work: workDirs({ roots, home }) };
    const v = judgeTool(input, opts);
    if (!v) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonText(v, opts) },
    }));
  } catch {
    // 판정 못 하면 막지 않는다
  }
}

let self = "";
try { self = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : ""; } catch {}
if (self === import.meta.url) await main();
