#!/usr/bin/env node
// work-ledger — 프로젝트별 작업 장부 명령. 사람과 어떤 AI 든 이 명령 하나로 장부를 읽고 쓴다.
//
// 데이터 = git 저장소(비공개 GitHub 권장). 할 일 하나 = 마크다운 파일 하나:
//   projects/<프로젝트>/items/<YYYY-MM-DD>-<4자>.md
// 파일은 덧붙이기만 한다 — 상태·메모는 "## 기록" 아래 한 줄씩 늘어나고 지우지 않는다.
// 그래서 두 기계가 같은 항목에 동시에 써도 git 의 merge=union 으로 줄만 합쳐진다.
// 현재 상태 = 시각순으로 마지막 상태 줄.
//
// 설정: ~/.work-ledger/config.json {"dataDir": "...", "owner": "리규형님", "timeZone": "Asia/Seoul"}
//       또는 환경변수 WORK_LEDGER_DIR. 없으면 ~/work-ledger-data.
// 의존성 없음(Node 18+).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.WORK_LEDGER_HOME || path.join(os.homedir(), ".work-ledger");

// 상태 — 화면·명령이 같은 이름을 쓴다
export const STATES = ["제안", "할 일", "진행 중", "끝냄", "확인됨", "보류", "버림"];
const OPEN_STATES = new Set(["제안", "할 일", "진행 중", "끝냄", "보류"]);
// "묶음" 줄 = 이 항목이 어느 대작업·중작업 아래인지(내용 = 부모 번호, "-" 면 묶음 풂). 마지막 줄이 이긴다.
// 사람이 맥락 단위로 보게 큰 작업 하나 아래 고친 것들을 단다(10-26 리규형님 — 조각마다 항목이라 목록이 너무 길었다)
// "설명" 줄 = 사람이 ? 를 눌러 보는 자세한 설명(마지막 줄이 이긴다). 줄바꿈은 \n 두 글자로 담는다
// "내 메모" 줄 = 사람만 쓰는 메모(큰 작업 · 프로젝트). AI 는 읽기만. 마지막 줄이 현재 메모, 빈 줄이면 지움(10-26 리규형님)
// "바뀜" 줄 = 정했던 것이 바뀐 기록(전 → 후 — 이유). 화면에서는 ? 팝업의 "바뀐 것" 칸에만 보인다(10-26 리규형님)
// "대작업" 줄 = 이 항목이 대작업(오래 가는 줄기 — 작업 장부·상태바 플러그인 같은 것)이다. 대작업 > 중작업(요청 하나) > 세부(고친 조각)
// 세 단(10-26 리규형님). 대작업은 상태가 없고 화면·목록에 아래 중작업 요약만 보인다. 내용 "-" 면 대작업을 그만둔다
// "검증" = AI 끝냄의 검증 범위(10-27 리규형님 — 확인됨은 사람 전용, AI 가 끝까지 검증한 일은 "AI 검증 완료"로 확인 대기에서 빠진다):
//   "AI" = 범위 전부 AI 가 검증 · "확인: <질문>" = AI 가 볼 수 없는 것이 남음(사람에게 그 질문만). 끝냄이 아닌 상태가 되면 사라진다
// "현황" = 대작업·프로젝트의 지금 위치 요약(AI·사람 모두 씀, 마지막 것이 보인다) — 장부 탭 첫 화면 "지금 어디까지"
const LOG_KINDS = new Set([...STATES, "메모", "제목", "묶음", "설명", "내 메모", "바뀜", "대작업", "검증", "현황"]);
const STATE_ALIASES = {
  suggest: "제안", todo: "할 일", doing: "진행 중", wip: "진행 중", done: "끝냄",
  confirmed: "확인됨", ok: "확인됨", hold: "보류", drop: "버림", dropped: "버림",
  "할일": "할 일", "진행중": "진행 중", "확인": "확인됨",
};

// ── 설정 ────────────────────────────────────────────────
export { CONFIG_DIR };
export function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8")); } catch {}
  const dataDir = process.env.WORK_LEDGER_DIR || cfg.dataDir || path.join(os.homedir(), "work-ledger-data");
  return {
    dataDir: path.resolve(dataDir),
    owner: cfg.owner || "사람",
    timeZone: cfg.timeZone || "Asia/Seoul",
    push: cfg.push !== false && process.env.WORK_LEDGER_NO_PUSH !== "1",
    projectsFile: process.env.WORK_LEDGER_PROJECTS || cfg.projectsFile || null,
    enabledProjects: Array.isArray(cfg.enabledProjects) ? cfg.enabledProjects : [], // 훅이 도는 프로젝트(ledger on)
  };
}
function saveConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const f = path.join(CONFIG_DIR, "config.json");
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  fs.writeFileSync(f, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`, "utf8");
}

// ── 활동 기록 ────────────────────────────────────────────
// 장부를 쓸 때마다 "어느 대화가·언제·어느 프로젝트에" 한 줄. 훅이 이번 차례에 기록이 있었는지 본다.
// 이 기계에만 두고 git 에 넣지 않는다.
const ACTIVITY = path.join(CONFIG_DIR, "activity.log");
function sessionOfCaller() {
  const e = process.env;
  return String(e.WORK_LEDGER_SESSION || e.CLAUDE_CODE_SESSION_ID || e.CODEX_THREAD_ID || e.CODEX_SESSION_ID || "").replace(/[^\w.-]/g, "");
}
function noteActivity(project, action) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY, `${Date.now()}\t${sessionOfCaller()}\t${project}\t${oneLine(action)}\n`, "utf8");
  } catch {}
}
export function activitySince(t) {
  let raw = "";
  try { raw = fs.readFileSync(ACTIVITY, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n").slice(-2000)) {
    const [ms, session, project, action] = line.split("\t");
    if (Number(ms) >= t) out.push({ t: Number(ms), session, project, action });
  }
  return out;
}
export function unpushedCount(cfg) {
  const r = spawnSync("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: cfg.dataDir, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

// ── 시각 ────────────────────────────────────────────────
function stamp(cfg, d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: cfg.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// ── 누가 쓰는가 ──────────────────────────────────────────
// AI 안에서 부르면 환경변수로 안다. 사람은 설정의 owner.
function agentName() {
  const e = process.env;
  if (e.WORK_LEDGER_AGENT) return e.WORK_LEDGER_AGENT;
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return "Claude";
  if (Object.keys(e).some((k) => k.startsWith("CODEX_"))) return "Codex";
  if (e.GEMINI_CLI) return "Gemini";
  if (e.PASEO_AGENT_ID) return "AI";
  return null;
}

// ── 프로젝트 이름 ────────────────────────────────────────
// 폴더 이름이 아니라 Paseo 프로젝트 관리 화면의 이름을 쓴다(10-26 리규형님).
// 1) 지금 폴더의 본 저장소 폴더(작업 트리면 본 저장소)를 구하고
// 2) 프로젝트 목록에서 그 폴더를 품는 가장 가까운 프로젝트의 이름을 쓴다 — 하위 작업 공간은 본 프로젝트로 묶인다
// 3) 목록에 없으면 폴더 이름
const PROJECT_LISTS = [
  path.join(os.homedir(), ".paseo", "plugin-data", "claude-state-bar", "project-list", "projects.json"),
];
function repoRootOf(cwd) {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status === 0 && r.stdout.trim()) {
    const common = path.resolve(r.stdout.trim());
    return path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "");
  }
  return path.resolve(cwd);
}
function normPath(p) {
  let s = String(p || "");
  const remote = s.match(/^vscode-remote:\/\/[^/]+(\/.*)$/);
  if (remote) s = remote[1];
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}
function projectList(cfg) {
  for (const f of [cfg?.projectsFile, ...PROJECT_LISTS].filter(Boolean)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const arr = Array.isArray(j) ? j : j.projects;
      if (Array.isArray(arr)) return arr.filter((p) => p && p.name && p.rootPath);
    } catch {}
  }
  return [];
}
export function projectNameFor(dir, list) {
  const target = normPath(dir);
  let best = null;
  for (const p of list) {
    const root = normPath(p.rootPath);
    if (!root || (target !== root && !target.startsWith(`${root}/`))) continue;
    if (!best || root.length > best.len) best = { name: p.name, len: root.length };
  }
  return best ? best.name : null;
}
export function detectProject(cfg, cwd = process.cwd()) {
  const root = repoRootOf(cwd);
  const list = projectList(cfg);
  return safeName(projectNameFor(root, list) || projectNameFor(cwd, list) || path.basename(root));
}
function safeName(s) {
  // 폴더 이름으로 못 쓰는 글자만 뺀다(띄어쓰기는 그대로 — 프로젝트 이름 그대로 보이게)
  return String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().replace(/\.+$/, "") || "기타";
}

// ── 항목 파일 ────────────────────────────────────────────
function oneLine(s) {
  return String(s ?? "").replace(/\r?\n+/g, " / ").replace(/ · /g, " ・ ").trim();
}
function newId(cfg, dir) {
  const day = stamp(cfg).slice(0, 10);
  for (;;) {
    const id = `${day}-${crypto.randomBytes(3).toString("base64url").replace(/[-_]/g, "x").slice(0, 4).toLowerCase()}`;
    if (!fs.existsSync(path.join(dir, `${id}.md`))) return id;
  }
}
function descText(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").trim().replace(/\n/g, "\\n");
}
function logLine(cfg, who, kind, text) {
  return `- ${stamp(cfg)} · ${oneLine(who)} · ${kind} · ${oneLine(text)}`;
}
export function parseItem(file, project) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const id = path.basename(file, ".md");
  let title = (raw.match(/^# (.+)$/m) || [, id])[1].trim();
  const log = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) · ([^·]*?) · ([^·]+?) · ?(.*)$/);
    if (!m || !LOG_KINDS.has(m[3].trim())) continue;
    log.push({ at: m[1], who: m[2].trim(), kind: m[3].trim(), text: m[4].trim() });
  }
  log.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // union 병합 뒤 순서가 섞여도 시각으로 바로잡는다
  let state = "할 일";
  let parent = null;
  let desc = "";
  let memo = "";
  let area = false;
  let wasArea = false; // 없앤 대작업(ledger area --end) — 화면·개수에서 뺀다(10-27 Codex 의견)
  // 시작 = 처음 "진행 중"이 된 때, 완료 = 마지막 "끝냄" 시각(그 뒤 다시 진행 중이 되면 비운다) — 화면에 보인다(10-26 리규형님)
  let started = "";
  let finished = "";
  let verify = null; // { ai: true } | { ask: "질문" } — 끝냄일 때만
  let summary = null; // { text, at } — 대작업 현황
  for (const e of log) {
    if (e.kind === "검증") verify = e.text === "AI" ? { ai: true } : { ask: e.text.replace(/^확인:\s*/, "") };
    if (e.kind === "현황") summary = e.text ? { text: e.text.replace(/\\n/g, "\n"), at: e.at } : null;
    if (STATES.includes(e.kind)) {
      verify = null; // 상태가 바뀌면 지난 검증은 끝 — 새 끝냄의 검증 줄은 바로 뒤에 붙는다
      state = e.kind;
      if (e.kind === "진행 중") { if (!started) started = e.at; finished = ""; }
      if (e.kind === "끝냄") finished = e.at;
      if (e.kind === "할 일" || e.kind === "제안") finished = "";
    }
    if (e.kind === "제목" && e.text) title = e.text;
    if (e.kind === "묶음") parent = e.text && e.text !== "-" ? e.text : null;
    if (e.kind === "설명") desc = e.text.replace(/\\n/g, "\n");
    if (e.kind === "내 메모") memo = e.text.replace(/\\n/g, "\n");
    if (e.kind === "대작업") { area = e.text !== "-"; wasArea = true; }
  }
  const created = log[0]?.at || `${id.slice(0, 10)} 00:00:00`;
  const updated = log[log.length - 1]?.at || created;
  return { id, project, title, state, created, updated, log, file, parent, desc, memo, area, wasArea: wasArea && !area, started, finished, verify, summary };
}
// 대작업 시작 = 아래 중작업·세부 전체에서 가장 이른 "진행 중" — 없으면 가장 이른 등록을 "기록 시작"으로(10-27 Codex 의견: 바로 아래만 보면
// 옮겨 온 시각을 실제 시작처럼 읽는다. 작업 장부가 14:51 로 나왔지만 실제 첫 진행은 04:32)
export function areaSince(area, all) {
  const mids = all.filter((x) => x.parent === area.id && !x.area);
  const desc = [...mids, ...all.filter((x) => mids.some((m) => m.id === x.parent))];
  const real = desc.map((x) => x.started).filter(Boolean).sort()[0];
  if (real) return { at: real, label: "시작" };
  const first = desc.map((x) => x.created).filter(Boolean).sort()[0];
  return first ? { at: first, label: "기록 시작" } : null;
}
// 화면(장부 탭·HTML)에 넘길 모양 — 없앤 대작업은 빼고, 대작업에는 시작 시각(since)을 붙인다. 두 화면이 같은 계산을 쓰게 여기 한 곳에서
export function forScreen(items) {
  const live = items.filter((it) => !it.wasArea);
  return live.map(({ file, ...r }) => (r.area ? { ...r, since: areaSince(r, live) } : r));
}
export function loadAll(cfg) {
  const root = path.join(cfg.dataDir, "projects");
  const items = [];
  if (!fs.existsSync(root)) return items;
  for (const project of fs.readdirSync(root)) {
    const dir = path.join(root, project, "items");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md")) items.push(parseItem(path.join(dir, f), project));
    }
  }
  return items;
}
function findItem(cfg, ref) {
  const all = loadAll(cfg);
  const hit = all.filter((it) => it.id === ref || it.id.endsWith(`-${ref}`) || it.id.endsWith(ref));
  if (hit.length === 1) return hit[0];
  if (!hit.length) fail(`항목을 못 찾았습니다: ${ref}  (ledger list 로 번호를 확인하세요)`);
  fail(`번호가 여러 항목에 맞습니다: ${ref} → ${hit.map((h) => h.id).join(", ")}`);
}

// ── git ─────────────────────────────────────────────────
function git(cfg, args, opts = {}) {
  return spawnSync("git", args, { cwd: cfg.dataDir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true, ...opts });
}
function ensureRepo(cfg) {
  if (!fs.existsSync(path.join(cfg.dataDir, ".git"))) {
    fail(`장부 저장소가 없습니다: ${cfg.dataDir}\n  비공개 저장소를 받아 두고 ~/.work-ledger/config.json 의 dataDir 로 가리키세요(ledger init 참고).`);
  }
}
function hasRemote(cfg) {
  const r = git(cfg, ["remote"]);
  return r.status === 0 && r.stdout.trim().length > 0;
}
function commitAndPush(cfg, files, message) {
  git(cfg, ["add", "--", ...files]);
  const c = git(cfg, ["commit", "-q", "-m", message, "--", ...files]);
  if (c.status !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
    warn(`커밋 실패 — 파일은 저장됐습니다. 다음 ledger sync 가 커밋해 올립니다.\n${c.stderr.trim()}`);
  }
  if (!cfg.push || !hasRemote(cfg)) return;
  // 올리기는 뒤에서 — 명령은 바로 끝나고, 실패해도 PC 커밋은 남아 다음 sync 가 올린다
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "ledger.mjs"), "sync", "--quiet"], {
    cwd: cfg.dataDir, detached: true, stdio: "ignore", env: process.env, windowsHide: true, // 없으면 Windows 가 기록마다 빈 콘솔 창을 띄움(10-26)
  });
  child.unref();
}
function sync(cfg, quiet) {
  ensureRepo(cfg);
  if (!hasRemote(cfg)) { if (!quiet) say("원격 저장소가 없어 올리지 않습니다(PC 에만 저장)."); return 0; }
  const lockFile = path.join(cfg.dataDir, ".git", "work-ledger-sync.lock");
  // 잠금을 못 잡은 요청은 "한 번 더" 표시만 남긴다 — 잠금을 쥔 쪽이 끝내기 전에 보고 다시 올린다
  // (앞선 sync 가 올릴 HEAD 를 정한 뒤 생긴 커밋이 다음 기록 때까지 PC 에만 남던 것, 10-26 Codex 리뷰)
  const againFile = path.join(cfg.dataDir, ".git", "work-ledger-sync.again");
  try { fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" }); } catch {
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs < 120000) { fs.writeFileSync(againFile, String(Date.now())); if (!quiet) say("다른 동기화가 진행 중입니다 — 끝나면 그쪽이 한 번 더 올립니다."); return 0; }
      fs.rmSync(lockFile); fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    } catch { try { fs.writeFileSync(againFile, String(Date.now())); } catch {} return 0; }
  }
  try {
    const branch = (git(cfg, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "main").trim();
    for (let round = 0; round < 5; round++) {
      try { fs.rmSync(againFile); } catch {}
      // 커밋이 실패해 파일만 남은 기록(commitAndPush 경고)을 여기서 커밋한다
      const st = git(cfg, ["status", "--porcelain", "--", "projects"]);
      if (st.status === 0 && st.stdout.trim()) {
        git(cfg, ["add", "--", "projects"]);
        const c = git(cfg, ["commit", "-q", "-m", "ledger: 남은 기록 커밋", "--", "projects"]);
        if (c.status !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) { warn(`남은 기록 커밋 실패 — 손으로 확인이 필요합니다(${cfg.dataDir}).\n${c.stderr.trim()}`); return 1; }
      }
      const remoteHas = git(cfg, ["ls-remote", "--heads", "origin", branch]);
      if (remoteHas.status !== 0) { if (!quiet) warn(`원격에 닿지 않습니다 — PC 커밋은 남아 있습니다.\n${remoteHas.stderr.trim()}`); return 1; }
      if (remoteHas.stdout.trim()) {
        const pull = git(cfg, ["pull", "--no-rebase", "--no-edit", "-q", "origin", branch]);
        if (pull.status !== 0) { warn(`받기 실패 — 손으로 확인이 필요합니다(${cfg.dataDir}).\n${(pull.stdout + pull.stderr).trim()}`); return 1; }
      }
      const push = git(cfg, ["push", "-q", "-u", "origin", branch]);
      if (push.status !== 0) { warn(`올리기 실패 — PC 커밋은 남아 있습니다.\n${push.stderr.trim()}`); return 1; }
      if (!fs.existsSync(againFile)) break;
    }
    if (!quiet) say("동기화했습니다.");
    return 0;
  } finally {
    try { fs.rmSync(lockFile); } catch {}
  }
}

// ── 출력 ────────────────────────────────────────────────
function say(s) { process.stdout.write(`${s}\n`); }
function warn(s) { process.stderr.write(`⚠ ${s}\n`); }
function fail(s) { process.stderr.write(`✖ ${s}\n`); process.exit(1); }

const ICON = { "제안": "◇", "할 일": "☐", "진행 중": "▶", "끝냄": "◐", "확인됨": "☑", "보류": "‖", "버림": "✕" };
function shortId(id) { return id.slice(-4); }
function describe(it) {
  const v = it.state === "끝냄" && it.verify ? (it.verify.ai ? " (AI 검증 완료)" : ` (직접 확인: ${it.verify.ask})`) : "";
  return `${ICON[it.state] || "·"} ${shortId(it.id)}  [${it.state}]  ${it.title}${v}`;
}

// ── 인자 ────────────────────────────────────────────────
const FLAG_ONLY = new Set(["verified", "closed", "json", "all", "clear", "quiet"]);
function parseArgs(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) opt[k] = v;
      // 값 없는 선택지는 뒤 낱말을 먹지 않는다(--verified 끝냄 처럼 써도 "끝냄"이 상태로 남게)
      else if (!FLAG_ONLY.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}
function normState(s) {
  const k = String(s || "").trim();
  const st = STATE_ALIASES[k.toLowerCase()] || STATE_ALIASES[k] || k;
  if (!STATES.includes(st)) fail(`모르는 상태입니다: ${s}  (쓸 수 있는 것: ${STATES.join(" · ")})`);
  return st;
}
function whoFor(cfg, opt) {
  const agent = agentName();
  if (opt.by) {
    // 기록에 남는 모양(oneLine)으로 비교한다 — 끝 공백 하나로 사람 이름이 그대로 저장되던 것(10-26 Codex 리뷰)
    const by = oneLine(String(opt.by));
    if (agent && by === oneLine(cfg.owner)) fail(`AI 안에서는 "${cfg.owner}" 이름으로 쓸 수 없습니다.`);
    return by;
  }
  return agent || cfg.owner;
}
// 사람만 찍는 "확인됨" · 근거가 있어야 하는 AI 의 "끝냄" — 상태 바꾸기와 새 항목의 처음 상태(add --state)에 같이 건다
function checkStateAllowed(cfg, state, why) {
  const agent = agentName();
  if (state === "확인됨" && agent) fail(`"확인됨"은 ${cfg.owner}만 찍습니다. AI 는 "끝냄"까지만 — 근거를 붙여 주세요.`);
  if (state === "끝냄" && agent && !why) fail('"끝냄"에는 무엇으로 확인했는지 근거가 필요합니다: --why "시험 12개 통과 · 화면 확인"');
}

// ── 명령 ────────────────────────────────────────────────
function cmdAdd(cfg, pos, opt, defaultState) {
  ensureRepo(cfg);
  const titles = pos.filter(Boolean);
  if (!titles.length) fail('제목을 주세요: ledger add "할 일 제목"');
  const under = opt.under ? parentFor(cfg, opt.under) : null;
  const project = under ? under.project : safeName(opt.project || detectProject(cfg));
  const dir = path.join(cfg.dataDir, "projects", project, "items");
  fs.mkdirSync(dir, { recursive: true });
  const state = opt.state ? normState(opt.state) : defaultState;
  const why = opt.why ? oneLine(opt.why) : "";
  checkStateAllowed(cfg, state, why);
  const who = whoFor(cfg, opt);
  const files = [];
  for (const title of titles) {
    const id = newId(cfg, dir);
    const where = [opt.chat ? `대화 ${oneLine(opt.chat)}` : "", opt.note ? oneLine(opt.note) : "", why].filter(Boolean).join(" — ");
    const body = [
      `# ${oneLine(title)}`,
      `<!-- work-ledger item ${id} · 아래 기록은 덧붙이기만 한다 -->`,
      "",
      "## 기록",
      logLine(cfg, who, state, where),
      ...(under ? [logLine(cfg, who, "묶음", under.id)] : []),
      ...(opt.desc && opt.desc !== true ? [logLine(cfg, who, "설명", descText(opt.desc))] : []),
      "",
    ].join("\n");
    const file = path.join(dir, `${id}.md`);
    fs.writeFileSync(file, body, "utf8");
    files.push(file);
    say(`${under ? "  └ " : ""}${ICON[state]} ${shortId(id)}  [${state}]  ${oneLine(title)}   (${under ? `${shortId(under.id)} 아래 · ` : ""}${project})`);
  }
  // 확인됨·끝냄 중작업에 새 세부가 붙으면 그 중작업을 다시 연다 — 확인은 그때까지의 범위였다(10-27 Codex 의견: 확인된 tatt 아래 pqqo 가
  // 화면에선 확인 단추 없이, AI 안내에선 아예 빠졌다). 이전 확인 기록은 그대로 남는다
  if (under && !under.area && ["확인됨", "끝냄"].includes(under.state)) {
    fs.appendFileSync(under.file, `${logLine(cfg, who, "진행 중", `새 세부 ${titles.length}건 추가로 다시 엶(이전 ${under.state} 범위 밖)`)}\n`, "utf8");
    files.push(under.file);
    say(`  ↺ ${shortId(under.id)}  ${under.state} → 진행 중  ${under.title}`);
  }
  commitAndPush(cfg, files, `ledger: ${state} ${titles.length}건 (${project})`);
  noteActivity(project, `add ${state} ${titles.length}`);
  rebuildQuiet(cfg);
}
// 세 단까지 — 대작업 아래 = 중작업, 중작업 아래 = 세부. 세부 아래에는 달지 않는다(10-26 리규형님 대작업 > 중작업 > 세부)
function parentFor(cfg, ref) {
  const all = loadAll(cfg);
  const p = findItem(cfg, ref);
  if (!p.area && p.parent && all.find((x) => x.id === p.parent && !x.area)) fail(`${shortId(p.id)} 는 이미 ${shortId(p.parent)} 의 세부입니다 — 대작업이나 중작업 번호를 주세요.`);
  return p;
}
/** 항목의 단 — 0 대작업 · 1 중작업(대작업 아래, 또는 아직 대작업이 없는 요청) · 2 세부 */
function levelOf(it, all) {
  if (it.area) return 0;
  if (!it.parent) return 1;
  const p = all.find((x) => x.id === it.parent);
  if (!p) return 1;
  return p.area ? 1 : 2;
}
// 대작업 만들기 — ledger area "작업 장부(work-ledger)" [--desc "…"]
function cmdArea(cfg, pos, opt) {
  ensureRepo(cfg);
  // ledger area --end <번호> — 대작업을 없앤다(10-26 리규형님: 주제 아닌 대작업 정리). 아래에 열린 일이 남으면 거부
  if (opt.end) {
    const it = findItem(cfg, opt.end === true ? pos[0] : opt.end);
    if (!it.area) fail(`${shortId(it.id)} 는 대작업이 아닙니다.`);
    const left = loadAll(cfg).filter((x) => x.parent === it.id && OPEN_STATES.has(x.state));
    if (left.length) fail(`${shortId(it.id)} 아래에 열린 일 ${left.length}개가 남았습니다 — 먼저 ledger move 로 옮기세요.`);
    const who = whoFor(cfg, opt);
    fs.appendFileSync(it.file, `${logLine(cfg, who, "대작업", "-")}\n${logLine(cfg, who, "버림", "대작업 없앰")}\n`, "utf8");
    say(`대작업 없앰: ${shortId(it.id)}  ${it.title}`);
    commitAndPush(cfg, [it.file], `ledger: 대작업 없앰 ${it.id}`);
    noteActivity(it.project, "area-end");
    rebuildQuiet(cfg);
    return;
  }
  const title = pos.filter(Boolean).join(" ");
  if (!title) fail('대작업 이름을 주세요: ledger area "작업 장부(work-ledger)"');
  const project = safeName(opt.project || detectProject(cfg));
  const dir = path.join(cfg.dataDir, "projects", project, "items");
  fs.mkdirSync(dir, { recursive: true });
  const who = whoFor(cfg, opt);
  const id = newId(cfg, dir);
  const body = [
    `# ${oneLine(title)}`,
    `<!-- work-ledger item ${id} · 아래 기록은 덧붙이기만 한다 -->`,
    "",
    "## 기록",
    logLine(cfg, who, "대작업", ""),
    ...(opt.desc && opt.desc !== true ? [logLine(cfg, who, "설명", descText(opt.desc))] : []),
    "",
  ].join("\n");
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, body, "utf8");
  say(`■ ${shortId(id)}  [대작업]  ${oneLine(title)}   (${project})`);
  commitAndPush(cfg, [file], `ledger: 대작업 ${id} (${project})`);
  noteActivity(project, "area");
  rebuildQuiet(cfg);
}
// 프로젝트 메모 = projects/<프로젝트>/project.md 의 마지막 "내 메모" 줄(덧붙이기만)
function projectMemoFile(cfg, project) {
  return path.join(cfg.dataDir, "projects", project, "project.md");
}
export function projectMemo(cfg, project) {
  const file = projectMemoFile(cfg, project);
  if (!fs.existsSync(file)) return "";
  let memo = "";
  const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n")
    .map((l) => l.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) · ([^·]*?) · 내 메모 · ?(.*)$/)).filter(Boolean)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const m of lines) memo = m[3].trim().replace(/\\n/g, "\n");
  return memo;
}
/** 프로젝트 현황(마지막 "현황" 줄) — { text, at } 또는 null */
export function projectSummary(cfg, project) {
  const file = projectMemoFile(cfg, project);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n")
    .map((l) => l.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) · ([^·]*?) · 현황 · ?(.*)$/)).filter(Boolean)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const m = lines[lines.length - 1];
  return m && m[3].trim() ? { text: m[3].trim().replace(/\\n/g, "\n"), at: m[1] } : null;
}
// 현황 요약 — ledger summary project "글" | -   ·   ledger summary <대작업 번호> "글" | -
// 지금 되는 것·남은 것·다음 후보를 사람 말로 몇 줄. 덧붙이기만 하고 마지막 것이 장부 탭 첫 화면에 보인다(10-27 리규형님 — Codex 시안 "지금 어디까지")
function cmdSummary(cfg, pos, opt) {
  ensureRepo(cfg);
  const [ref, ...rest] = pos;
  if (!ref) fail('ledger summary project "지금 되는 것·남은 것·다음 후보" | -    또는    ledger summary <대작업 번호> "글" | -');
  let text = rest.join(" ");
  if (text === "-") text = fs.readFileSync(0, "utf8");
  if (!text.trim()) fail("현황 글을 주세요.");
  text = descText(text);
  let file;
  let project;
  let label;
  if (ref === "project") {
    project = safeName(opt.project || detectProject(cfg, opt.cwd || process.cwd()));
    file = projectMemoFile(cfg, project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${project} — 프로젝트 메모\n<!-- work-ledger project memo · 아래 기록은 덧붙이기만 한다 -->\n\n## 기록\n`, "utf8");
    label = `프로젝트 ${project}`;
  } else {
    const it = findItem(cfg, ref);
    if (!it.area) fail(`${shortId(it.id)} 는 대작업이 아닙니다 — 현황은 대작업이나 project 에만 씁니다(중작업은 설명·기록으로).`);
    file = it.file;
    project = it.project;
    label = `${shortId(it.id)} ${it.title}`;
  }
  fs.appendFileSync(file, `${logLine(cfg, whoFor(cfg, opt), "현황", text)}\n`, "utf8");
  say(`현황 저장: ${label}`);
  commitAndPush(cfg, [file], `ledger: 현황 ${ref === "project" ? project : ref}`);
  noteActivity(project, `현황 ${ref}`);
  rebuildQuiet(cfg);
}
// 사람만 쓰는 메모 — ledger memo <번호> "글" | -    ·    ledger memo project "글" | -   (- 면 표준 입력, --clear 면 지움)
function cmdMemo(cfg, pos, opt) {
  ensureRepo(cfg);
  if (agentName()) fail(`내 메모는 ${cfg.owner}만 씁니다. AI 는 읽기만 — 남길 말은 ledger note 로.`);
  const [ref, ...rest] = pos;
  if (!ref) fail('ledger memo <번호> "글" | -    또는    ledger memo project "글" | -   (--clear 로 지우기)');
  let text = opt.clear ? "" : rest.join(" ");
  if (!opt.clear && (text === "-" || !text)) text = text === "-" ? fs.readFileSync(0, "utf8") : fail("메모 글을 주세요(지우려면 --clear)");
  text = descText(text);
  let file;
  let project;
  let label;
  if (ref === "project") {
    project = safeName(opt.project || detectProject(cfg, opt.cwd || process.cwd()));
    file = projectMemoFile(cfg, project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${project} — 프로젝트 메모\n<!-- work-ledger project memo · 아래 기록은 덧붙이기만 한다 -->\n\n## 기록\n`, "utf8");
    label = `프로젝트 ${project}`;
  } else {
    const it = findItem(cfg, ref);
    file = it.file;
    project = it.project;
    label = `${shortId(it.id)} ${it.title}`;
  }
  fs.appendFileSync(file, `${logLine(cfg, whoFor(cfg, opt), "내 메모", text)}\n`, "utf8");
  say(`${text ? "내 메모 저장" : "내 메모 지움"}: ${label}`);
  commitAndPush(cfg, [file], `ledger: 내 메모 ${ref === "project" ? project : ref}`);
  noteActivity(project, `내 메모 ${ref}`);
  rebuildQuiet(cfg);
}
// 사람이 ? 를 눌러 보는 자세한 설명 — 무엇을·왜·어떻게·결과. 여러 줄 가능(인자 안 줄바꿈, 또는 "-" 면 표준 입력)
function cmdDescribe(cfg, pos, opt) {
  ensureRepo(cfg);
  const [ref, ...rest] = pos;
  let text = rest.join(" ");
  if (text === "-" || (!text && opt.stdin)) text = fs.readFileSync(0, "utf8");
  text = descText(text);
  if (!ref || !text) fail('ledger describe <번호> "자세한 설명(여러 줄 가능)"   — 표준 입력으로 주려면 마지막 인자를 - 로');
  const it = findItem(cfg, ref);
  fs.appendFileSync(it.file, `${logLine(cfg, whoFor(cfg, opt), "설명", text)}\n`, "utf8");
  say(`설명: ${shortId(it.id)}  ${it.title}`);
  commitAndPush(cfg, [it.file], `ledger: 설명 ${it.id}`);
  noteActivity(it.project, `설명 ${it.id}`);
  rebuildQuiet(cfg);
}
function cmdMove(cfg, pos, opt) {
  ensureRepo(cfg);
  const refs = pos.filter(Boolean);
  if (!refs.length || (!opt.under && !opt.top)) fail("ledger move <번호> [번호...] --under <대작업 또는 중작업 번호>   또는   --top (묶음 풀기)");
  const under = opt.under ? parentFor(cfg, opt.under) : null;
  const all = loadAll(cfg);
  const who = whoFor(cfg, opt);
  const files = [];
  for (const ref of refs) {
    const it = findItem(cfg, ref);
    if (under && it.id === under.id) fail(`자기 아래로는 옮길 수 없습니다: ${shortId(it.id)}`);
    if (it.area) fail(`${shortId(it.id)} 는 대작업입니다 — 대작업은 옮기지 않습니다.`);
    // 중작업은 세부를 데리고 대작업 아래로 옮길 수 있다. 중작업 아래(세부 자리)로는 세부 없는 것만
    if (under && !under.area && all.some((x) => x.parent === it.id)) fail(`${shortId(it.id)} 는 세부를 가진 중작업입니다 — 세부 자리로는 옮길 수 없습니다(대작업 아래로는 됩니다).`);
    const target = under ? under.id : "-";
    if ((it.parent || "-") === target) { say(`이미 그 자리입니다: ${describe(it)}`); continue; }
    fs.appendFileSync(it.file, `${logLine(cfg, who, "묶음", target)}\n`, "utf8");
    files.push(it.file);
    say(under ? `  └ ${describe(it)}   → ${shortId(under.id)} ${under.title}` : `${describe(it)}   → 묶음 풂`);
  }
  if (!files.length) return;
  commitAndPush(cfg, files, `ledger: 묶음 ${files.length}건`);
  noteActivity(under ? under.project : detectProject(cfg), `move ${files.length}`);
  rebuildQuiet(cfg);
}
function cmdStatus(cfg, pos, opt) {
  ensureRepo(cfg);
  let [ref, st, ...rest] = pos;
  if (!ref || !st) fail('ledger status <번호> <상태> [--why "근거"]');
  // 따옴표 없이 친 "진행 중"·"할 일" 은 두 낱말로 갈라져 들어온다 — 붙여서 상태면 그렇게 읽는다
  if (!STATES.includes(st) && rest.length && STATES.includes(`${st} ${rest[0]}`)) st = `${st} ${rest.shift()}`;
  const it = findItem(cfg, ref);
  if (it.area) fail(`${shortId(it.id)} 는 대작업입니다 — 대작업은 상태가 없습니다(아래 중작업의 상태를 바꾸세요).`);
  const state = normState(st);
  const why = oneLine(opt.why ?? rest.join(" "));
  checkStateAllowed(cfg, state, why);
  // 검증 범위(끝냄에만): --verified = AI 가 범위 전부 검증 · --ask "질문" = 사람만 볼 수 있는 것이 남음
  const ask = typeof opt.ask === "string" ? oneLine(opt.ask) : "";
  if ((opt.verified || opt.ask) && state !== "끝냄") fail("--verified·--ask 는 끝냄과 함께만 씁니다.");
  if (opt.verified && opt.ask) fail("--verified 와 --ask 중 하나만 — 사람이 볼 것이 남았으면 --ask 입니다.");
  if (opt.ask && !ask) fail('--ask 에는 리규형님께 드릴 질문을 쉬운 말로: --ask "폰에서 길게 눌러 복사가 되는지 봐 주세요"');
  if (state === it.state && !why) { say(`이미 ${state}입니다: ${describe(it)}`); return; }
  const who = whoFor(cfg, opt);
  const verifyLine = opt.verified ? `${logLine(cfg, who, "검증", "AI")}\n` : ask ? `${logLine(cfg, who, "검증", `확인: ${ask}`)}\n` : "";
  fs.appendFileSync(it.file, `${logLine(cfg, who, state, why)}\n${verifyLine}`, "utf8");
  say(`${ICON[state]} ${shortId(it.id)}  ${it.state} → ${state}${opt.verified ? " (AI 검증 완료)" : ask ? ` (직접 확인: ${ask})` : ""}  ${it.title}`);
  const files = [it.file];
  // 사람은 중작업에서 한 번만 확인한다 — 그 아래 끝난 세부도 같이 확인됨(남은 세부는 그대로 둔다)
  if (state === "확인됨") {
    for (const ch of loadAll(cfg).filter((x) => x.parent === it.id && x.state === "끝냄")) {
      fs.appendFileSync(ch.file, `${logLine(cfg, who, "확인됨", `중작업 ${shortId(it.id)} 확인`)}\n`, "utf8");
      files.push(ch.file);
      say(`  └ ${ICON["확인됨"]} ${shortId(ch.id)}  끝냄 → 확인됨  ${ch.title}`);
    }
  }
  commitAndPush(cfg, files, `ledger: ${state} ${it.id}${files.length > 1 ? ` (+세부 ${files.length - 1})` : ""}`);
  noteActivity(it.project, `status ${state} ${it.id}`);
  rebuildQuiet(cfg);
}
function cmdNote(cfg, pos, opt, kind = "메모") {
  ensureRepo(cfg);
  const [ref, ...rest] = pos;
  const text = oneLine(rest.join(" "));
  if (!ref || !text) fail(kind === "제목" ? 'ledger rename <번호> "새 제목"' : kind === "바뀜" ? 'ledger change <번호> "전 → 후" --why "이유"' : 'ledger note <번호> "메모"');
  const it = findItem(cfg, ref);
  const why = kind === "바뀜" && typeof opt.why === "string" ? oneLine(opt.why) : "";
  fs.appendFileSync(it.file, `${logLine(cfg, whoFor(cfg, opt), kind, why ? `${text} — 이유: ${why}` : text)}\n`, "utf8");
  say(`${kind}: ${shortId(it.id)}  ${kind === "제목" ? `${it.title} → ${text}` : it.title}`);
  commitAndPush(cfg, [it.file], `ledger: ${kind} ${it.id}`);
  noteActivity(it.project, `${kind} ${it.id}`);
  rebuildQuiet(cfg);
}
function cmdList(cfg, opt) {
  let all = loadAll(cfg);
  const project = opt.all ? null : safeName(opt.project || detectProject(cfg));
  if (project) all = all.filter((it) => it.project === project);
  all = all.filter((it) => !it.wasArea); // 없앤 대작업은 끝낸 일이 아니다
  let items = opt.closed ? all : all.filter((it) => OPEN_STATES.has(it.state));
  const order = { "끝냄": 0, "진행 중": 1, "할 일": 2, "제안": 3, "보류": 4, "확인됨": 5, "버림": 6 };
  const byOrder = (a, b) => (order[a.state] - order[b.state]) || (a.updated < b.updated ? 1 : -1);
  items.sort(byOrder);
  if (opt.json) { say(JSON.stringify(items.map(({ file, ...r }) => r), null, 2)); return; }
  const behind = unpushedCount(cfg);
  if (behind) say(`⚠ GitHub 에 아직 못 올린 기록 ${behind}개 — ledger sync`);
  if (!items.length) { say(project ? `${project}: 남은 일이 없습니다.` : "남은 일이 없습니다."); return; }
  // 대작업 → 중작업 → 세부(10-26 리규형님 세 단). 아래가 남았으면 닫힌 중작업도 머리로 보인다. 대작업은 상태 없이 요약만
  const byId = new Map(all.map((x) => [x.id, x]));
  const midOf = (it) => (levelOf(it, all) === 2 ? byId.get(it.parent) : it);
  const areaOf = (mid) => (mid.parent && byId.get(mid.parent)?.area ? byId.get(mid.parent) : null);
  const groups = new Map(); // 대작업 id("" = 대작업 없음) → Map(중작업 id → 중작업)
  for (const it of items) {
    if (it.area) continue;
    const mid = midOf(it);
    const key = areaOf(mid)?.id ?? "";
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(mid.id, mid);
  }
  const tm = (it) => `${it.started ? ` · 시작 ${it.started.slice(5, 16)}` : ""}${it.finished ? ` · 끝 ${it.finished.slice(5, 16)}` : ""}`;
  // 대작업은 만든 순서로 고정(10-27 리규형님 버튼 — 확인할 때마다 자리가 바뀌던 것). 대작업 없음은 맨 아래
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : byId.get(a).created < byId.get(b).created ? -1 : 1));
  let last = null;
  for (const key of keys) {
    const mids = [...groups.get(key).values()].sort(byOrder);
    const proj = key ? byId.get(key).project : mids[0].project;
    if (!project && proj !== last) { say(`\n■ ${proj}`); last = proj; }
    if (key) {
      const a = byId.get(key);
      const under = all.filter((x) => x.parent === a.id && !x.area);
      // 끝냄 중 AI 가 범위 전부 검증한 것은 "AI 검증"으로 따로 — 확인 대기는 사람이 볼 것만(10-27 리규형님)
      const keyOf = (x) => (x.state === "끝냄" && x.verify?.ai ? "AI 검증" : x.state);
      const counts = ["끝냄", "진행 중", "할 일", "제안", "보류", "AI 검증"].map((s) => [s, under.filter((x) => keyOf(x) === s).length]).filter(([, n]) => n);
      const since = areaSince(a, all);
      say(`\n▣ ${shortId(a.id)}  ${a.title}${counts.length ? `   (${counts.map(([s, n]) => `${s === "끝냄" ? "확인 대기" : s} ${n}`).join(" · ")})` : ""}${since ? ` · ${since.label} ${since.at.slice(5, 16)}` : ""}`);
    } else say("\n▣ (대작업 없음)");
    for (const m of mids) {
      const allKids = all.filter((x) => x.parent === m.id);
      const done = allKids.filter((x) => ["끝냄", "확인됨", "버림"].includes(x.state)).length;
      say(`  ${describe(m)}${tm(m)}${allKids.length ? `   (세부 ${done}/${allKids.length})` : ""}`);
      for (const k of items.filter((x) => x.parent === m.id).sort(byOrder)) say(`      └ ${describe(k)}${tm(k)}`);
    }
  }
}
function cmdShow(cfg, pos) {
  const it = findItem(cfg, pos[0] || fail("ledger show <번호>"));
  say(`${describe(it)}   (${it.project})`);
  for (const e of it.log) say(`   ${e.at} · ${e.who} · ${e.kind}${e.text ? ` · ${e.text}` : ""}`);
}
function cmdSkip(cfg, pos, opt) {
  // 이번 차례에 장부에 적을 것이 없다는 표시 — 훅이 본다. 장부(git)에는 남기지 않는다.
  const why = oneLine(opt.why ?? pos.join(" "));
  if (!why) fail('ledger skip "이유" — 예: ledger skip "질문에 답만 함"');
  noteActivity(detectProject(cfg), `skip ${why}`);
  say(`기록 없음 표시: ${why}`);
}
function cmdInit(cfg, opt) {
  // 데이터 저장소 기본 틀 + 이 기계 설정
  const dataDir = path.resolve(opt.dir || cfg.dataDir);
  if (!fs.existsSync(path.join(dataDir, ".git"))) fail(`먼저 비공개 저장소를 받아 두세요: git clone <주소> "${dataDir}"`);
  fs.mkdirSync(path.join(dataDir, "projects"), { recursive: true });
  const put = (name, text) => { const f = path.join(dataDir, name); if (!fs.existsSync(f)) { fs.writeFileSync(f, text, "utf8"); say(`만듦: ${name}`); } };
  put(".gitattributes", "# 항목 파일은 덧붙이기만 한다 — 두 기계가 동시에 써도 줄을 합친다\nprojects/**/*.md merge=union\n");
  put(".gitignore", "_site/\n");
  put("projects/.gitkeep", "");
  const tpl = [path.join(SCRIPT_DIR, "templates"), path.join(SCRIPT_DIR, "..", "templates")]
    .map((d) => path.join(d, "data-README.md")).find((f) => fs.existsSync(f));
  if (tpl) put("README.md", fs.readFileSync(tpl, "utf8"));
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const cfgFile = path.join(CONFIG_DIR, "config.json");
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch {}
  const next = { ...cur, dataDir, owner: opt.owner || cur.owner || cfg.owner, timeZone: cur.timeZone || cfg.timeZone };
  fs.writeFileSync(cfgFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  say(`설정: ${cfgFile}`);
  const c = { ...cfg, dataDir };
  commitAndPush(c, [".gitattributes", ".gitignore", "projects/.gitkeep", "README.md"], "ledger: 장부 시작");
}

function cmdOnOff(cfg, opt, on) {
  const project = safeName(opt.project || detectProject(cfg));
  const set = new Set(cfg.enabledProjects);
  if (on) set.add(project); else set.delete(project);
  saveConfig({ enabledProjects: [...set] });
  say(on ? `켰습니다: ${project} — 이 프로젝트 대화에서 장부 훅이 돕니다.` : `껐습니다: ${project}`);
  say(`켜진 프로젝트: ${[...set].join(", ") || "없음"}`);
}
function cmdView(cfg, opt) {
  // 화면(Paseo 장부 탭)용 — 이 폴더의 프로젝트 장부 전체를 JSON 한 번으로
  const project = safeName(opt.project || detectProject(cfg, opt.cwd || process.cwd()));
  let items = [];
  let error = null;
  if (fs.existsSync(path.join(cfg.dataDir, ".git"))) items = forScreen(loadAll(cfg).filter((it) => it.project === project));
  else error = `장부 저장소가 없습니다: ${cfg.dataDir}`;
  say(JSON.stringify({ project, enabled: cfg.enabledProjects.includes(project), owner: cfg.owner, behind: error ? 0 : unpushedCount(cfg), builtAt: stamp(cfg), error, items, projectMemo: error ? "" : projectMemo(cfg, project), projectSummary: error ? null : projectSummary(cfg, project) }));
}
function cmdInstall(cfg, opt) {
  // 명령·훅을 고정 위치(~/.work-ledger/app)에 두고 짧은 이름(~/bin/ledger)을 만든다
  const app = path.join(CONFIG_DIR, "app");
  fs.mkdirSync(path.join(app, "templates"), { recursive: true });
  for (const f of fs.readdirSync(SCRIPT_DIR)) if (f.endsWith(".mjs")) fs.copyFileSync(path.join(SCRIPT_DIR, f), path.join(app, f));
  const tpl = path.join(SCRIPT_DIR, "..", "templates");
  if (fs.existsSync(tpl)) for (const f of fs.readdirSync(tpl)) fs.copyFileSync(path.join(tpl, f), path.join(app, "templates", f));
  const bin = path.join(os.homedir(), "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fwd = (p) => p.split(path.sep).join("/");
  const target = fwd(path.join(app, "ledger.mjs"));
  fs.writeFileSync(path.join(bin, "ledger"), `#!/bin/sh${"\n"}exec node "${target}" "$@"${"\n"}`, { mode: 0o755 });
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "ledger.cmd"), `@node "${target}" %*${"\r\n"}`);
  say(`설치: ${app}`);
  say(`짧은 이름: ${path.join(bin, "ledger")}`);
  say(`훅 명령: node "${fwd(path.join(app, "hook.mjs"))}" session-start|prompt|stop`);
}

// ── 화면 ────────────────────────────────────────────────
async function buildHtml(cfg) {
  const { renderHtml } = await import("./render.mjs");
  const items = forScreen(loadAll(cfg));
  const out = path.join(cfg.dataDir, "_site", "index.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderHtml(items, { builtAt: stamp(cfg), owner: cfg.owner }), "utf8");
  return out;
}
function rebuildQuiet(cfg) {
  buildHtml(cfg).catch((e) => warn(`화면 만들기 실패: ${e.message}`));
}
function openFile(file) {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", file]]
    : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const HELP = `work-ledger — 프로젝트별 작업 장부

  ledger area "대작업 이름" [--desc 설명]                          대작업(오래 가는 줄기) 만들기 — 상태 없음
  ledger area --end <번호>                                       대작업 없애기(아래 열린 일을 먼저 옮겨야 함)
  ledger add "요청" --under <대작업 번호> [--desc 설명]           그 대작업 아래 중작업(요청 하나) 추가
  ledger add "조각" --under <중작업 번호>                         그 중작업 아래 세부(고친 조각) 추가
  ledger add "제목" [--note 메모] [--chat 대화] [--state 상태]   묶음 없이 추가(여럿 가능)
  ledger describe <번호> "자세한 설명" | -                         설명 넣기·바꾸기(- 면 표준 입력, 여러 줄)
  ledger memo <번호> "글" | -  ·  ledger memo project "글" | -     내 메모(사람만 · 중작업·프로젝트, --clear 지움)
  ledger move <번호...> --under <대작업|중작업 번호> | --top      옮기기(중작업은 세부를 데리고 대작업 아래로)·묶음 풀기
  ledger suggest "제목" ["제목"...]                              AI 제안 넣기(사람이 채택)
  ledger status <번호> <상태> [--why 근거] [--verified | --ask "질문"]  상태 바꾸기 — 끝냄에 --verified = AI 가 범위 전부 검증(확인 대기에서 빠짐), --ask = 사람만 볼 것이 남음
  ledger summary project|<대작업 번호> "글" | -                   현황(지금 되는 것·남은 것·다음 후보) — 장부 탭 첫 화면
  ledger note <번호> "메모"                                        메모 덧붙이기
  ledger rename <번호> "새 제목"                                   제목 바꾸기
  ledger change <번호> "전 → 후" --why "이유"                      정했던 것이 바뀐 기록(? 팝업 "바뀐 것" 칸)
  ledger list [--all] [--closed] [--project 이름] [--json]        남은 일 보기(기본: 지금 프로젝트)
  ledger show <번호>                                              한 항목의 기록 전체
  ledger skip "이유"                                              이번엔 적을 것 없음(훅용)
  ledger html [--open]                                            보기 화면 만들기·열기
  ledger sync                                                     GitHub 와 맞추기
  ledger init [--dir 폴더] [--owner 이름]                          장부 저장소 틀·이 기계 설정
  ledger on | off [--project 이름]                                이 프로젝트에서 장부 훅 켜기·끄기
  ledger install                                                  명령·훅을 ~/.work-ledger/app 에 설치

상태: ${STATES.join(" · ")}
  · "끝냄"을 AI 가 찍을 때는 --why 근거 필수 · "확인됨"은 사람만(중작업을 확인하면 끝난 세부도 같이)
묶음: 대작업(줄기) > 중작업(사람 요청 하나) > 세부(그 안에서 고친 것) — 세 단까지. 대작업은 상태 없이 아래 요약만
시각: 시작 = 처음 "진행 중", 끝 = 마지막 "끝냄" — 목록·화면에 보인다
번호: 항목 이름 끝 4자(예 a7k2)로 충분합니다.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const cfg = loadConfig();
  switch (cmd) {
    case "add": return cmdAdd(cfg, pos, opt, "할 일");
    case "area": return cmdArea(cfg, pos, opt);
    case "suggest": return cmdAdd(cfg, pos, { ...opt, state: "제안" }, "제안");
    case "status": case "st": return cmdStatus(cfg, pos, opt);
    case "note": return cmdNote(cfg, pos, opt, "메모");
    case "move": case "mv": return cmdMove(cfg, pos, opt);
    case "describe": case "desc": return cmdDescribe(cfg, pos, opt);
    case "memo": return cmdMemo(cfg, pos, opt);
    case "summary": return cmdSummary(cfg, pos, opt);
    case "rename": return cmdNote(cfg, pos, opt, "제목");
    case "change": return cmdNote(cfg, pos, opt, "바뀜");
    case "list": case "ls": return cmdList(cfg, opt);
    case "show": return cmdShow(cfg, pos);
    case "skip": return cmdSkip(cfg, pos, opt);
    case "sync": process.exitCode = sync(cfg, !!opt.quiet); return;
    case "init": return cmdInit(cfg, opt);
    case "on": return cmdOnOff(cfg, opt, true);
    case "off": return cmdOnOff(cfg, opt, false);
    case "install": return cmdInstall(cfg, opt);
    case "view": return cmdView(cfg, opt);
    case "html": {
      ensureRepo(cfg);
      const out = await buildHtml(cfg);
      say(`화면: ${out}`);
      if (opt.open) openFile(out);
      return;
    }
    case undefined: case "help": case "-h": case "--help": say(HELP); return;
    default: fail(`모르는 명령입니다: ${cmd}\n\n${HELP}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e.stack || String(e)));
}
