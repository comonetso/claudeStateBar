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
export const workRoot = (env = process.env) => join(env.PASEO_HOME || join(homedir(), ".paseo"), "claude-work");

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
 * 실행기(relay.mjs·launch.mjs)의 관측·이행 기록기. 팀 좌석을 쓰는 대화(rotation active)와 등록한 대화만 쓴다 — 그 밖의 대화엔 파일을 만들지 않는다.
 * 쓰기 실패는 한 번만 기록하고 Claude 입출력 전달·넘김을 막지 않는다(무중단 기획 §3-5). 새 세대가 관측을 가져가면 이 실행기는 쓰기를 멈춘다
 */
export function workRecorder({ agentId, log = () => {}, env = process.env, ephemeral = false }) {
  const root = workRoot(env);
  if (ephemeral || !validId(agentId)) return { root, registered: false, record: null, onTransition: null, flush() {} };
  const registered = isRegistered(root, agentId);
  const failed = new Set();
  const fail = (what) => (e) => { if (!failed.has(what)) { failed.add(what); log(`work state ${what} write failed: ${e?.code ?? e?.message ?? e}`); } };
  let stale = false;
  const writer = serialWriter((snap) => {
    if (stale || (!snap.active && !registered)) return;
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
