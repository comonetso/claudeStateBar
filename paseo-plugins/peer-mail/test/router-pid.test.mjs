// router-pid.test.mjs — 중계기 "한 대만" 판정과 살아 있다는 표시(10-26). 실제 Paseo·우편함을 쓰지 않는다(임시 폴더).
//   node --test test/router-pid.test.mjs        (paseo-plugins/peer-mail 폴더에서)
//
// router.test.mjs 와 같은 방식으로 원본 router.mjs 의 두 구간을 그대로 잘라 격리된 vm 에 넣는다.
//   ① "// ── 한 대만: router.pid" ~ "// ── 상태 파일"     ② "// 살아 있다는 표시" ~ "}, BEAT_MS).unref();"
// 파일은 실제 임시 폴더에 쓰고 시각도 실제로 바꾼다. 가짜는 번호 살아 있음(process.kill)·기다리기(Atomics.wait)·끝내기뿐이다.
// 🔴 router.mjs 의 위 표식 줄을 바꾸면 이 시험도 맞춰라(못 찾으면 이 파일이 처음부터 실패한다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "runtime", "router.mjs"), "utf8");
function between(from, to, src = SRC) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b <= a) throw new Error("router.mjs marker moved: " + from + " … " + to);
  return src.slice(a, b);
}
const CLAIM = between("// ── 한 대만: router.pid", "// ── 상태 파일");
const BEAT = between("// 살아 있다는 표시", "}, BEAT_MS).unref();") + "}, BEAT_MS);";
// 대조군 — 10-26 전 판정(번호가 살아 있기만 하면 끝냈다)
const OLD_CLAIM = `const PID = path.join(ROUTER_DIR, "router.pid");
try {
  const old = Number(fs.readFileSync(PID, "utf8"));
  if (old && old !== process.pid) {
    try {
      process.kill(old, 0);
      log("another router is running (pid " + old + ") — exiting");
      process.exit(0);
    } catch {
      /* 죽은 기록 */
    }
  }
} catch {
  /* 없음 */
}
fs.writeFileSync(PID, String(process.pid));`;

const ME = 4242;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "peer-mail-pid-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let caseNo = 0;
class Exit extends Error {
  constructor(code) {
    super("exit " + code);
    this.code = code;
  }
}

// alive: 살아 있는 번호 집합 · onWait: 기다리는 동안 일어날 일
function claim({ code = CLAIM, pidFile, ageMs, alive = [], onWait } = {}) {
  const dir = path.join(TMP, "case" + ++caseNo);
  fs.mkdirSync(dir);
  const PID = path.join(dir, "router.pid");
  if (pidFile !== undefined) {
    fs.writeFileSync(PID, String(pidFile));
    if (ageMs !== undefined) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(PID, t, t);
    }
  }
  const logs = [];
  const live = new Set(alive);
  let waits = 0;
  // 진짜 process.exit 는 그 자리에서 프로세스가 끝난다 — 가짜는 예외로 멈추는데, 옛 코드처럼 try 안에서 부르면 catch 가 삼키고
  // 다음 줄을 더 돈다. 그래서 처음 부른 순간의 번호 파일을 결과로 삼는다
  let exit = null;
  let exitOwner = null;
  const ownerNow = () => (fs.existsSync(PID) ? Number(fs.readFileSync(PID, "utf8")) : null);
  const ctx = vm.createContext({
    path,
    fs,
    ROUTER_DIR: dir,
    log: (m) => logs.push(m),
    process: {
      pid: ME,
      kill(pid, sig) {
        if (sig !== 0) throw new Error("only signal 0 expected");
        if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      },
      exit(c) {
        if (exit === null) {
          exit = c;
          exitOwner = ownerNow();
        }
        throw new Exit(c);
      },
    },
    Atomics: {
      wait() {
        waits++;
        if (onWait) onWait({ PID, live });
        return "timed-out";
      },
    },
    SharedArrayBuffer,
    Int32Array,
    Date,
    Number,
    String,
    Infinity,
  });
  try {
    new vm.Script(code, { filename: "router.mjs(claim)" }).runInContext(ctx);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
  }
  const owner = exit === null ? ownerNow() : exitOwner;
  return { exit, owner, logs, waits };
}

test("파일 없음 → 자기 번호를 쓴다", () => {
  const r = claim();
  assert.equal(r.exit, null);
  assert.equal(r.owner, ME);
  assert.equal(r.waits, 0);
});

test("죽은 번호 → 기다리지 않고 넘겨받는다", () => {
  const r = claim({ pidFile: 777, ageMs: 5_000 });
  assert.equal(r.exit, null);
  assert.equal(r.owner, ME);
  assert.equal(r.waits, 0);
});

test("살아 있고 표시가 최근 → 끝낸다(파일 그대로)", () => {
  const r = claim({ pidFile: 777, ageMs: 10_000, alive: [777] });
  assert.equal(r.exit, 0);
  assert.equal(r.owner, 777);
  assert.equal(r.waits, 0);
});

test("살아 있지만 표시가 오래됐고 기다려도 그대로 → 번호 재사용으로 보고 넘겨받는다", () => {
  const r = claim({ pidFile: 777, ageMs: 10 * 60_000, alive: [777] });
  assert.equal(r.exit, null);
  assert.equal(r.owner, ME);
  assert.equal(r.waits, 1);
  assert.ok(r.logs.some((m) => m.includes("taking over")), r.logs.join("\n"));
});

test("표시가 오래됐지만 기다리는 동안 진짜 중계기가 다시 쓰면 → 끝낸다(절전에서 막 깬 경우)", () => {
  const r = claim({
    pidFile: 777,
    ageMs: 10 * 60_000,
    alive: [777],
    onWait: ({ PID }) => {
      const now = new Date();
      fs.utimesSync(PID, now, now);
    },
  });
  assert.equal(r.exit, 0);
  assert.equal(r.owner, 777);
  assert.equal(r.waits, 1);
});

test("표시가 오래됐고 기다리는 동안 옛 중계기가 끝나면 → 넘겨받는다(다시 불러오기 겹침)", () => {
  const r = claim({
    pidFile: 777,
    ageMs: 10 * 60_000,
    alive: [777],
    onWait: ({ PID, live }) => {
      live.delete(777);
      fs.unlinkSync(PID);
    },
  });
  assert.equal(r.exit, null);
  assert.equal(r.owner, ME);
});

test("대조군: 고치기 전 판정은 번호가 재사용되면 끝내 버린다", () => {
  const r = claim({ code: OLD_CLAIM, pidFile: 777, ageMs: 10 * 60_000, alive: [777] });
  assert.equal(r.exit, 0);
  assert.equal(r.owner, 777);
});

// ② 살아 있다는 표시 — setInterval 콜백만 꺼내 한 번 돌린다
function beat({ pidFile, ageMs } = {}) {
  const dir = path.join(TMP, "beat" + ++caseNo);
  fs.mkdirSync(dir);
  const PID = path.join(dir, "router.pid");
  if (pidFile !== undefined) {
    fs.writeFileSync(PID, String(pidFile));
    const t = new Date(Date.now() - (ageMs ?? 0));
    fs.utimesSync(PID, t, t);
  }
  let tick = null;
  let stopped = 0;
  const logs = [];
  const ctx = vm.createContext({
    fs,
    PID,
    BEAT_MS: 30_000,
    log: (m) => logs.push(m),
    shutdown: () => {
      stopped++;
    },
    setInterval: (fn) => {
      tick = fn;
      return 0;
    },
    process: { pid: ME },
    Number,
    String,
    Date,
  });
  new vm.Script(BEAT, { filename: "router.mjs(beat)" }).runInContext(ctx);
  assert.equal(typeof tick, "function");
  tick();
  const owner = fs.existsSync(PID) ? Number(fs.readFileSync(PID, "utf8")) : null;
  const age = fs.existsSync(PID) ? Date.now() - fs.statSync(PID).mtimeMs : null;
  return { owner, age, stopped, logs };
}

test("표시: 자기 번호면 파일 시각을 새로 쓴다", () => {
  const r = beat({ pidFile: ME, ageMs: 5 * 60_000 });
  assert.equal(r.owner, ME);
  assert.ok(r.age < 10_000, "age " + r.age);
  assert.equal(r.stopped, 0);
});

test("표시: 다른 중계기가 넘겨받았으면 끝낸다(파일은 건드리지 않는다)", () => {
  const r = beat({ pidFile: 9999, ageMs: 5 * 60_000 });
  assert.equal(r.owner, 9999);
  assert.ok(r.age > 60_000);
  assert.equal(r.stopped, 1);
});

test("표시: 파일이 지워졌으면 자기 번호로 다시 쓴다", () => {
  const r = beat();
  assert.equal(r.owner, ME);
  assert.equal(r.stopped, 0);
});
