// 무중단 작업 상태 파일(10-16 리규형님 "Mesa 를 쉬지 않게" — docs/paseo-plugin-tools/NONSTOP_IMPL_SPEC.md §1).
// 실행기·장부 명령·턴 끝 문지기·kicker·감독자가 함께 쓰는 공용 모듈. 파일마다 작성자는 하나다.
// 🔴 감독자 플러그인 폴더에는 배포 때 이 파일을 그대로 복사한다(Paseo 컴파일러가 플러그인 폴더 밖 import 를 막는다).
//    고치면 두 곳이 같아야 한다 — 정본은 claude-rc-relay/workstate.mjs.
// node 내장 모듈만 쓴다.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATES = ["ready", "waiting_provider", "waiting_external", "waiting_human", "completed", "paused"];
/**
 * 같은 사용량 창인지 — 초기화 시각(초)이 60초 안이면 같다. 창이 바뀌면 5시간(주간은 며칠) 뛰므로 섞이지 않는다.
 * 정확히 같은 값을 요구하면 신호마다 소수점이 흔들리는 경우(시험 장치)에 같은 창을 다른 창으로 본다
 */
export const sameWindow = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 60;
export const validId = (id) => /^[A-Za-z0-9-]{1,64}$/.test(String(id ?? ""));

// ── 경로(10-18 정리) — 실행기(relay.mjs)·kicker·문지기·감독자가 따로 적던 Paseo 홈·파일 이름의 정본. 한 곳만 고치면 모두 같은 파일을 본다 ──
/** Paseo 홈 — PASEO_HOME, 없으면 ~/.paseo */
export const paseoHome = (env = process.env) => env.PASEO_HOME || join(homedir(), ".paseo");
/** 무중단 작업 상태 폴더 — <Paseo 홈>/claude-work */
export const workRootOf = (home) => join(home, "claude-work");
export const workRoot = (env = process.env) => workRootOf(paseoHome(env));
/** 실행기 기록 — <Paseo 홈>/claude-rc-relay.log(kicker 도 같은 파일에 쓴다) */
export const relayLogFile = (home) => join(home, "claude-rc-relay.log");
/** 자동 전환 시험 덮어쓰기 파일(rotation.mjs readRotationTest) */
export const rotationTestFile = (home) => join(home, "claude-rc-relay-test.json");
/** 개인 계정 포함 스위치 파일 — <Paseo 홈>/claude-rc-relay-personal.json. 있으면 켜짐 */
export const personalSwitchFile = (home) => join(home, "claude-rc-relay-personal.json");
/** 같은 파일을 상태 폴더 기준으로(root = <Paseo 홈>/claude-work) */
export const personalSwitchPath = (root) => personalSwitchFile(dirname(root));
/** 넘김 안내 폴더·파일 — 대화 번호가 올바를 때만 경로를 준다(rotation.mjs saveHandoff/takeHandoff · resume-kicker.mjs) */
export const handoffDir = (home) => join(home, "claude-rc-relay-handoff");
export const handoffFile = (home, agentId) => (validId(agentId) ? join(handoffDir(home), `${agentId}.json`) : null);
/** PC 팀 계정 설정 동기화 스크립트(실행기가 CLAUDE_CONFIG_DIR 로 띄울 때 한 번 돌린다) */
export const teamSyncScript = () => join(homedir(), ".local", "bin", "claude-team-sync.js");
/** Claude 설정 폴더 — CLAUDE_CONFIG_DIR, 없으면 ~/.claude */
export const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
/** 옛 Remote Control 보관 상태 폴더 — PASEO_HOME 을 보지 않는 것은 예전 그대로다. 10-10 부터 RC 를 꺼 둬 쓰지 않는 경로(relay.mjs REMOTE_CONTROL) */
export const legacyRcStateDir = () => join(homedir(), ".paseo", "claude-rc-state");

/**
 * 직원 데몬(울타리 안 팀원 — /team/paseo)인지. 감독자는 직원 데몬에서 하지 않는다(claude-state-bar sound.ts isTeamDaemon 과 같은 판정).
 * 실행기도 이 판정 하나로 직원이면 계정 바꾸기·넘김·무중단 기록·자동 전환·계정 감시를 끈다(relay.mjs · rotation.mjs createRotation —
 * 10-18 C7 에서 TEAM_UID 만 보던 자동 전환을 이것으로 모았다. 실서버 직원 유닛은 두 표식을 늘 같이 줘서 동작 차이는 없다)
 */
export const isStaffDaemon = (env = process.env) => !!env.TEAM_UID || env.PASEO_HOME === "/team/paseo";

/**
 * 실행기·감독자·문지기가 Claude 에 넣는 말의 머리. 감독자는 이 머리로 "누가 넣은 말인지"를 가른다(rotation.mjs mainInputKind ·
 * supervisor.mjs WAKE_MARK·RESUME_MARK·USAGE_MARK) — 한쪽만 바꾸면 감독자가 이어 달리기 말을 못 알아본다. 바이트까지 바꾸지 마라
 */
export const MARK = Object.freeze({
  rotation: "[rotation]",
  resume: "[rotation] 자동 이어 달리기",
  supervisor: "[supervisor]",
  usage: "[supervisor:usage]",
  peerMail: "[peer_mail/",
});
/** 이어 달리기 말 끝에 붙는 넘김 이행 번호 꼬리(resume-kicker.mjs 가 붙이고 supervisor.mjs 가 찾는다) */
export const transitionTag = (tid) => `(이행 ${tid})`;

/**
 * 계정별 5시간 사용률 기준(10-17 저녁 리규형님 — "개인 계정 맥스는 팀의 2배라" 개인을 5% 높게).
 * idle = 쉬는 틈에 다른 계정으로 넘기는 기준(실행기 rotation.mjs · 문지기 양보) · warn = 감독자가 "새 서브를 더 띄우지 말고
 * 돌던 것만 마무리"라고 경고하는 기준(Mesa 가 스스로 재서 판단하지 않게 — 리규형님 "감독자가 전달")
 */
export const PERSONAL_SEAT = "claude";
export const TEAM_SEAT_IDS = ["claude-yeogiaen", "claude-hrg"];
export const SEAT_PCT = { team: { idle: 85, warn: 80 }, personal: { idle: 90, warn: 85 } };
export const seatKind = (id) => (id === PERSONAL_SEAT ? "personal" : TEAM_SEAT_IDS.includes(id) ? "team" : null);
export const idlePctOf = (id) => SEAT_PCT[seatKind(id)]?.idle ?? null;
export const warnPctOf = (id) => SEAT_PCT[seatKind(id)]?.warn ?? null;
export const SEAT_LABEL = { claude: "개인", "claude-yeogiaen": "팀(como)", "claude-hrg": "팀(hrg)" };
// 좌석 목록의 정본은 여기 하나다 — rotation.mjs TEAM_PROVIDER_IDS·PERSONAL_PROVIDER_ID 와 stop-gate.mjs TEAM_SEATS 는 이 배열을 다시 내보낸다
// (10-17 문지기 쪽 목록이 따로 있다 빠져 99% 강제 넘김까지 밀린 사고 — stop-gate.mjs judge 주석)

/**
 * 쉬는 틈에 끝나길 기다리지 않는 작업 종류(10-15 리규형님: 서브에이전트·워크플로우만 기다림) — 셸 명령과 감시.
 * rotation.mjs NOT_WAITED_TASK_TYPES 가 이 배열이다. Stop 훅 입력은 친근한 이름(shell·monitor)으로 와서 문지기는 둘을 더해 본다
 */
export const NOT_WAITED_TASK_TYPES = ["local_bash", "monitor_mcp", "monitor_ws"];
export const NOT_WAITED_HOOK_TYPES = [...NOT_WAITED_TASK_TYPES, "shell", "monitor"];

export function paths(root) {
  const per = (sub) => (id) => (validId(id) ? join(root, sub, `${id}.json`) : null);
  return {
    root,
    registry: join(root, "registry.json"),
    pool: join(root, "pool.json"),
    events: join(root, "events.jsonl"),
    work: per("work"),
    observe: per("observe"),
    gate: per("gate"),
    supervisor: per("supervisor"),
    transitionDir: (id) => (validId(id) ? join(root, "transition", id) : null),
    transition: (id, tid) => (validId(id) && validId(tid) ? join(root, "transition", id, `${tid}.json`) : null),
  };
}

/** 읽기 — 없으면 {missing}, 깨졌으면 {error}(덮어쓰지 않으려고 "없음"과 구분한다), 있으면 {value} */
export function readJson(file) {
  if (!file) return { error: "bad-path" };
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { return e?.code === "ENOENT" ? { missing: true } : { error: e?.code ?? "read" }; }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { value } : { error: "shape" };
  } catch { return { error: "parse" }; }
}

let tmpSeq = 0;
/** 같은 폴더 임시 파일 → rename(찢어진 JSON 을 남기지 않는다). Windows 에서 읽는 쪽이 잠깐 잡고 있으면 몇 번 다시 한다 */
export function writeJson(file, value) {
  if (!file) throw Error("bad path");
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) { try { unlinkSync(tmp); } catch { /* 이미 없음 */ } throw e; }
      const until = Date.now() + 15 * (i + 1);
      while (Date.now() < until) { /* 짧게 기다린다 — 동기 경로라 잠들 수 없다 */ }
    }
  }
}

export function removeFile(file) {
  try { unlinkSync(file); return true; } catch { return false; }
}

/** 사건 기록 한 줄 — 1MB 를 넘으면 events.1.jsonl 로 돌린다(하나만 남김). 실패는 조용히 */
export const EVENTS_MAX = 1024 * 1024;
export function appendEvent(root, event) {
  try {
    const file = paths(root).events;
    mkdirSync(root, { recursive: true });
    try { if (statSync(file).size > EVENTS_MAX) renameSync(file, join(root, "events.1.jsonl")); } catch { /* 처음 */ }
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch { /* 기록 실패는 동작에 영향을 주지 않는다 */ }
}

// ── 등록(registry) — 문지기·감독자가 다루는 대화. 사람 지시로만 바꾼다 ──
export function readRegistry(root) {
  const r = readJson(paths(root).registry);
  if (r.missing) return { agents: {}, autoSend: false };
  if (r.error) return { error: r.error, agents: {}, autoSend: false };
  const agents = r.value.agents && typeof r.value.agents === "object" ? r.value.agents : {};
  return { agents, autoSend: r.value.autoSend === true };
}
export function isRegistered(root, agentId) {
  const reg = readRegistry(root);
  return !reg.error && validId(agentId) && Object.hasOwn(reg.agents, agentId);
}
export function updateRegistry(root, change) {
  const file = paths(root).registry;
  const r = readJson(file);
  if (r.error) throw Error(`registry unreadable (${r.error}) — not overwriting`);
  const doc = r.missing ? { v: 1, agents: {}, autoSend: false } : { v: 1, agents: {}, autoSend: false, ...r.value };
  change(doc);
  writeJson(file, doc);
  return doc;
}

// ── 장부(work) ──
const text = (v, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const future = (iso, now) => typeof iso === "string" && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > now;

/** 상태별 필수 칸 — 빠진 칸 이름 목록(없으면 []) */
export function missingFields(work, now = Date.now()) {
  if (!work || !STATES.includes(work.state)) return ["state"];
  const miss = [];
  if (work.state === "ready" && !text(work.next)) miss.push("next");
  if (work.state === "waiting_external") {
    if (!text(work.external?.ref)) miss.push("external.ref");
    if (!future(work.external?.recheckAt, now)) miss.push("external.recheckAt(미래 시각)");
  }
  if (work.state === "waiting_human" && !text(work.human?.question)) miss.push("human.question");
  if (work.state === "completed") {
    if (!text(work.completed?.criteria)) miss.push("completed.criteria");
    if (!text(work.completed?.evidence)) miss.push("completed.evidence");
  }
  if (work.state === "paused" && !text(work.note)) miss.push("note");
  return miss;
}

// ── 관측(observe) — 실행기 세대 검증 ──
/** 옛 실행기가 새 실행기의 관측을 덮지 않게 — 파일이 다른 세대이고 그 세대가 나보다 늦게 시작했으면 쓰지 않는다 */
export function writeObserve(root, agentId, snapshot) {
  const file = paths(root).observe(agentId);
  if (!file) return "bad-id";
  const cur = readJson(file);
  if (cur.value && cur.value.runGen !== snapshot.runGen && Number(cur.value.startedAtMs) > Number(snapshot.startedAtMs)) return "stale";
  writeJson(file, snapshot);
  return "ok";
}

/**
 * 쓰기를 다음 차례(setImmediate)로 미뤄 한 번에 하나만 — 그사이 여러 번 바뀌면 마지막 값만 쓴다(중간 값·대기열 없음).
 * 실행기는 Claude 출력을 넘기는 자리에서 부르므로 그 자리에서 디스크를 기다리지 않게 한다.
 * flush() 는 프로세스가 끝나기 직전에 남은 값을 바로 쓴다
 */
export function serialWriter(write, onError = () => {}) {
  let pending = null, scheduled = false;
  const drain = () => {
    scheduled = false;
    const value = pending; pending = null;
    if (value === null) return;
    try { write(value); } catch (e) { onError(e); }
  };
  const push = (value) => {
    pending = value;
    if (!scheduled) { scheduled = true; setImmediate(drain); }
  };
  push.flush = drain;
  return push;
}

// ── 이행(transition) ──
export const TRANSITION_OPEN = ["prepared", "committed", "dispatching", "unknown"];
export function listTransitions(root, agentId) {
  const dir = paths(root).transitionDir(agentId);
  if (!dir) return [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names.map((n) => readJson(join(dir, n)).value).filter(Boolean).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
/** 끝난 이행은 최근 것만 남긴다(파일 누적 방지) */
export const TRANSITION_KEEP = 10;
export function pruneTransitions(root, agentId) {
  const list = listTransitions(root, agentId);
  const closed = list.filter((t) => !TRANSITION_OPEN.includes(t.state));
  for (const t of closed.slice(0, Math.max(0, closed.length - TRANSITION_KEEP))) removeFile(paths(root).transition(agentId, t.tid));
}
export function writeTransition(root, agentId, t) {
  writeJson(paths(root).transition(agentId, t.tid), { ...t, updatedAt: new Date().toISOString() });
}
export function readTransition(root, agentId, tid) {
  return readJson(paths(root).transition(agentId, tid)).value ?? null;
}

/**
 * 실행기(relay.mjs — 10-18 부터 실행기는 이것 하나)의 관측·이행 기록기. 팀 좌석을 쓰는 대화(rotation active)와 등록한 대화만 쓴다 — 그 밖의 대화엔 파일을 만들지 않는다.
 * 쓰기 실패는 한 번만 기록하고 Claude 입출력 전달·넘김을 막지 않는다(무중단 기획 §3-5). 새 세대가 관측을 가져가면 이 실행기는 쓰기를 멈춘다
 */
export function workRecorder({ agentId, log = () => {}, env = process.env, ephemeral = false }) {
  const root = workRoot(env);
  if (ephemeral || !validId(agentId)) return { root, registered: false, record: null, onTransition: null, flush() {} };
  const registered = isRegistered(root, agentId);
  const failed = new Set();
  const fail = (what) => (e) => { if (!failed.has(what)) { failed.add(what); log(`work state ${what} write failed: ${e?.code ?? e?.message ?? e}`); } };
  let stale = false;
  // 등록 여부는 쓸 때마다 다시 본다 — 떠 있는 동안 등록된 대화도 관측을 쓰게(10-18 Mesa d30c37a7: 실행기가 등록 6분 전에 떠
  // 관측을 한 줄도 안 써서 감독자가 백그라운드 대기를 멈춤으로 보고 알림을 세 번 보냈다). 등록 파일은 작아 읽기 부담이 없다
  const writer = serialWriter((snap) => {
    if (stale || (!snap.active && !isRegistered(root, agentId))) return;
    if (writeObserve(root, agentId, snap) === "stale") { stale = true; log("work state observe — a newer launcher owns this agent, stopped writing"); }
  }, fail("observe"));
  const onTransition = (t) => {
    try { writeTransition(root, agentId, t); } catch (e) { fail("transition")(e); }
    appendEvent(root, { kind: "transition", agentId, tid: t.tid, state: t.state, from: t.from, to: t.to, reason: t.reason, owner: t.owner });
    if (!TRANSITION_OPEN.includes(t.state)) pruneTransitions(root, agentId);
  };
  return { root, registered, record: writer, onTransition, flush: () => writer.flush() };
}

/** 보관된 대화의 파일을 지운다(감독자가 archived 때) */
export function forgetAgent(root, agentId) {
  const p = paths(root);
  for (const f of [p.work(agentId), p.observe(agentId), p.gate(agentId), p.supervisor(agentId)]) if (f) removeFile(f);
  const dir = p.transitionDir(agentId);
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 없음 */ } }
}

/** 프로세스가 살아 있는지(0 신호) — 권한 없음(EPERM)은 살아 있는 것으로 본다 */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}
