//
// runtime.mjs — live-consult 실행의 **권위 runtime 상태** + steer 요청 큐
//
// 무엇을 푸는 모듈인가
//   `live-consult run` 이 도는 동안, **다른 프로세스**(`live-consult steer`)가
//   "지금 이 턴에 이 말을 끼워 넣어라"를 전달해야 한다. 두 프로세스는 메모리를 공유하지
//   않으므로 디스크가 유일한 통로다. 이 파일은 그 통로의 규약이다.
//
// ══════════════════════════════════════════════════════════════════════════
// 🔴 설계의 핵심 — 권위 상태를 왜 `.log/` 에 두지 않는가
// ══════════════════════════════════════════════════════════════════════════
//   `docs/codex_rescue/.log/` 는 **Codex 자신의 workspace-write 샌드박스 안**이다.
//   즉 감시 대상인 Codex 가 그 파일을 지우거나 고칠 수 있다. 스킬도 그 디렉토리를
//   "비권위 UI telemetry" 로 못박아 두었다
//   (`src/providers/codexRescue/runDiscovery.ts` 파일 상단 주석 · send.sh 1236행).
//
//   소켓 포트·nonce·PID 는 **제어 정보**다. 이게 조작되면 steer 가 엉뚱한 실행으로
//   흘러가거나, 죽은 실행을 살아 있는 것으로 오인한다. 그래서:
//     · 권위 상태 → OS 임시 디렉토리 아래 **실행별 디렉토리** (workspace 밖)
//     · `.log/<stamp>_live.json` → **UI 용 비민감 필드만** 복제 (writeLiveMirror)
//
//   POSIX 에서는 `/tmp` 가 공유 디렉토리라 0o700/0o600 이 실질 방어선이다.
//   Windows 의 `os.tmpdir()` 은 `%LOCALAPPDATA%\Temp` 로 이미 사용자별 경로라
//   경로 자체가 1차 격리다(mode 비트는 Windows 에서 사실상 무시된다).
//
// ══════════════════════════════════════════════════════════════════════════
// 🔴 쓰기 소유권 규칙 — 이걸 어기면 경합이 되살아난다
// ══════════════════════════════════════════════════════════════════════════
//   · `state.json`  → **run 프로세스만 쓴다.** steer 프로세스는 읽기 전용.
//   · `steer/`      → **steer 프로세스가 쓰고(생성만), run 프로세스가 읽는다.**
//   · `taken/`·`outcome/` → run 프로세스만 쓴다.
//
//   그래서 `enqueueSteer()` 는 **state.json 을 건드리지 않는다.** seq 를 state 에
//   기록하려 들면 두 프로세스가 같은 파일을 read-modify-write 하게 되고, 그 순간
//   원자성이 깨진다. seq 는 큐 디렉토리에서 파생되고, `state.steerSeq` 는 run 이
//   drain 한 뒤에 갱신하는 **사본**일 뿐이다.
//
// ══════════════════════════════════════════════════════════════════════════
// 다루는 경합 (Codex 자문이 지목한 것들)
// ══════════════════════════════════════════════════════════════════════════
//   1. 완료 직전 steer — 가장 흔하다. active 를 읽은 직후 턴이 끝나면 서버가
//      `{"code":-32600,"message":"no active turn to steer"}` 로 거부한다(실측).
//      → **성공으로 위장하지 않는다.** recordSteerOutcome() 으로 원문째 남기고
//        listUndeliveredSteer() 로 호출자가 FOLLOWUP 후보로 회수한다.
//   2. stale run 오염 — stamp 만 믿지 않는다. checkSteerable() 이
//      stamp·host·nonce·threadId·pid 생존·phase 를 **전부** 대조한다.
//   3. 동시 도착 — 단일 큐에서 seq 순 직렬 처리. 같은 nonce 재전송은 O_EXCL 로 차단.
//   4. 크래시 — phase 를 failed 로. 수락 여부가 불명확하면 outcome 을 'unknown' 으로.
//
// 검증 근거(2026-08-25 실측): `C:\Users\bluec\AppData\Local\Temp\codex-steer-fixture\
// 2026-08-25T12-11-27-190Z\rpc.jsonl` — steer 수락은 `{result:{turnId}}`,
// 턴 종료 후 재시도는 `{error:{code:-32600,message:"no active turn to steer"}}`.
//
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ══════════════════════════════════════════════════════════════════════════
// 0. 상수 · 조절값
// ══════════════════════════════════════════════════════════════════════════

/** 상태 파일 스키마 버전. 필드를 깨는 변경이 있으면 올린다. */
export const SCHEMA = 1;

/** 계약에 명시된 phase 전이값. 이 밖의 값은 writeState 가 거부한다. */
export const PHASES = Object.freeze(['starting', 'active', 'finalizing', 'done', 'failed']);

/**
 * steer 전달 결과. 3값인 이유는 "모르는 상태"를 성공/실패로 뭉개지 않기 위해서다.
 *   delivered — 서버가 `{result:{turnId}}` 로 수락했다
 *   rejected  — 서버가 명시적으로 거부했다 (예: -32600 no active turn to steer)
 *   unknown   — 요청은 보냈는데 응답 전에 연결이 끊겼거나 프로세스가 죽었다.
 *               🔴 이걸 delivered 로 올리지 마라. 중복 전달보다 누락 보고가 낫다.
 */
export const OUTCOMES = Object.freeze(['delivered', 'rejected', 'unknown']);

/**
 * 🔴 여기 있는 수치는 **정책값이 아니라 알고리즘 상한**이며, 근거를 한 줄씩 남긴다.
 *    폴링 주기·타임아웃·유예 시간 같은 정책성 수치는 이 모듈이 정하지 않는다 —
 *    필요하면 호출자가 넘긴다(이 파일에 기본 폴링 루프가 없는 이유다).
 *    모든 공개 함수가 `opts` 로 아래 값을 덮어쓸 수 있다.
 */
export const TUNABLES = Object.freeze({
    // Windows 에서 rename 이 EPERM/EBUSY 로 튕기는 건 백신·인덱서가 파일을 잠깐
    // 잡을 때 생기는 **일시적** 실패다. 영구 실패와 구분하려면 몇 번은 다시 해봐야 한다.
    // ⬜ 결정 필요: 아래 두 값은 실측이 아니라 "일시적 잠금은 수십 ms 안에 풀린다"는
    //    통념에 기댄 임의 상한이다. 운영에서 문제가 되면 호출자 옵션으로 승격해야 한다.
    renameRetries: 5,
    renameRetryMs: 20,
    // seq 예약 충돌 시 위로 훑을 상한. 한 실행의 steer 가 이보다 많을 일이 없다는 가정.
    // 넘으면 조용히 뭉개지 않고 throw 한다 — 조용한 seq 붕괴가 훨씬 위험하다.
    seqProbeLimit: 10000
});

/** 상태 디렉토리 루트. 실행별 디렉토리가 이 아래에 생긴다. */
const ROOT_DIRNAME = 'live-consult';

// ══════════════════════════════════════════════════════════════════════════
// 1. 경로
// ══════════════════════════════════════════════════════════════════════════

/**
 * stamp 는 경로 조각이 된다. 검증 없이 join 하면 `..` 하나로 임시 디렉토리 밖을
 * 짚을 수 있다. 실제 stamp 형식은 `260825_174748` 이므로 아래 문자 집합으로 충분하다.
 */
function assertStamp(stamp) {
    if (typeof stamp !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(stamp)) {
        throw new Error('runtime: 잘못된 stamp (허용: 영숫자·밑줄·하이픈 1~64자): ' + JSON.stringify(stamp));
    }
    return stamp;
}

/**
 * 실행별 **디렉토리** 경로를 돌려준다 (파일이 아니다).
 * 계약: "OS 임시 디렉토리 아래. workspace 밖."
 * 안에 state.json · steer/ · taken/ · outcome/ · seq/ 가 들어간다.
 */
export function runtimePath(stamp) {
    assertStamp(stamp);
    return path.join(os.tmpdir(), ROOT_DIRNAME, stamp);
}

/** 권위 상태 파일. run 프로세스만 쓴다. */
export function statePath(stamp) {
    return path.join(runtimePath(stamp), 'state.json');
}

/** steer 요청 큐. 파일명이 nonce 해시라 O_EXCL 생성 자체가 중복 차단이 된다. */
export function steerDirPath(stamp) {
    return path.join(runtimePath(stamp), 'steer');
}

/**
 * drain 된 항목 표시. 🔴 steer/ 원본을 지우거나 옮기지 않고 **별도 마커**를 쓰는 이유:
 * 원본이 사라지면 같은 nonce 재전송이 O_EXCL 을 통과해 버려 중복 차단이 깨진다.
 */
function takenDirPath(stamp) {
    return path.join(runtimePath(stamp), 'taken');
}

/** 전달 결과 + 원문 보존. 미전달분 회수(listUndeliveredSteer)의 근거가 된다. */
function outcomeDirPath(stamp) {
    return path.join(runtimePath(stamp), 'outcome');
}

/** seq 예약 마커. 빈 파일을 O_EXCL 로 만들어 번호를 선점한다. */
function seqDirPath(stamp) {
    return path.join(runtimePath(stamp), 'seq');
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 저수준 유틸 — 원자적 쓰기
// ══════════════════════════════════════════════════════════════════════════

/** 128비트 난수 hex. 스키마의 "128비트 난수 hex" 를 그대로 만족한다. */
export function makeNonce() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * nonce 는 외부(다른 프로세스의 CLI 인자)에서 들어올 수 있어 파일명으로 그대로 쓰면
 * 위험하다. 해시로 고정 길이·안전 문자로 만든다. 32자면 충돌 걱정이 없다.
 */
function nonceKey(nonce) {
    if (typeof nonce !== 'string' || nonce.length === 0) {
        throw new Error('runtime: nonce 가 비어 있다');
    }
    return crypto.createHash('sha256').update(nonce, 'utf8').digest('hex').slice(0, 32);
}

async function ensureDir(dir) {
    // mode 는 POSIX 에서만 의미가 있다. Windows 는 tmpdir 경로 자체가 사용자별이라 무해.
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * 같은 디렉토리에 tmp 를 쓰고 rename 한다. 읽는 쪽이 **반쯤 쓰인 파일을 보면 안 된다.**
 * send.sh 의 write_status(1254~1272행)가 쓰는 방식과 같은 계열이다.
 *
 * 🔴 tmp 를 같은 디렉토리에 두는 게 중요하다. 다른 볼륨에 두면 rename 이 복사+삭제로
 *    풀려 원자성이 사라진다.
 */
async function atomicWriteFile(filePath, data, opts = {}) {
    const retries = opts.renameRetries ?? TUNABLES.renameRetries;
    const retryMs = opts.renameRetryMs ?? TUNABLES.renameRetryMs;
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    const tmp = path.join(dir, path.basename(filePath) + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex'));
    await fsp.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            // Node 의 rename 은 Windows 에서도 기존 파일을 덮어쓴다(MOVEFILE_REPLACE_EXISTING).
            await fsp.rename(tmp, filePath);
            return;
        } catch (e) {
            lastErr = e;
            // EPERM/EBUSY 는 일시적 잠금일 가능성이 있어 다시 해본다. 그 외는 즉시 포기.
            if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') && i < retries) {
                await sleep(retryMs);
                continue;
            }
            break;
        }
    }
    // 실패했으면 tmp 를 남기지 않는다 — 임시 디렉토리에 쓰레기가 쌓이면 다음 스캔을 오염시킨다.
    await fsp.rm(tmp, { force: true }).catch(() => { });
    throw lastErr;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function readJsonOrNull(filePath) {
    let raw;
    try {
        raw = await fsp.readFile(filePath, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') { return null; }
        throw e;
    }
    // 🔴 파싱 실패를 null 로 삼키지 않는다. "상태 없음" 과 "상태가 깨졌음" 은 전혀 다른
    //    사건이고, 후자를 조용히 넘기면 steer 가 엉뚱한 실행으로 흘러갈 수 있다.
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error('runtime: 상태/큐 파일이 유효한 JSON 이 아니다: ' + filePath + ' — ' + e.message);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. 권위 상태 — write / read / patch
// ══════════════════════════════════════════════════════════════════════════

/**
 * 권위 runtime 상태를 원자적으로 교체한다. **run 프로세스만 부른다.**
 *
 * state 스키마 (계약):
 *   { schema, stamp, nonce, host, pid, port, threadId, activeTurnId,
 *     phase, steerSeq, startedAt }
 *
 * schema·stamp·host·pid 는 넘기지 않으면 채워 준다. 나머지는 호출자 몫이다
 * (특히 nonce 는 실행을 식별하는 값이라 이 함수가 지어내지 않는다 —
 *  run 이 시작할 때 makeNonce() 로 한 번 만들어 계속 들고 다녀야 한다).
 */
export async function writeState(stamp, state, opts = {}) {
    assertStamp(stamp);
    if (!state || typeof state !== 'object') {
        throw new Error('runtime: state 객체가 필요하다');
    }
    if (state.stamp !== undefined && state.stamp !== stamp) {
        // 인자와 본문이 어긋나면 어느 쪽이 진짜인지 알 수 없다. 조용히 고르지 않는다.
        throw new Error('runtime: state.stamp(' + state.stamp + ') 가 인자 stamp(' + stamp + ') 와 다르다');
    }
    if (state.phase !== undefined && !PHASES.includes(state.phase)) {
        throw new Error('runtime: 알 수 없는 phase: ' + JSON.stringify(state.phase) + ' (허용: ' + PHASES.join('|') + ')');
    }
    if (typeof state.nonce !== 'string' || state.nonce.length === 0) {
        // nonce 없이 쓰면 stale 판별이 stamp 재사용에 뚫린다. 처음부터 막는다.
        throw new Error('runtime: state.nonce 가 필요하다 (makeNonce() 로 실행 시작 시 한 번 만든다)');
    }
    const full = {
        schema: SCHEMA,
        ...state,
        stamp,
        host: state.host ?? os.hostname(),
        pid: state.pid ?? process.pid
    };
    await atomicWriteFile(statePath(stamp), JSON.stringify(full, null, 2) + '\n', opts);
}

/**
 * 권위 상태를 읽는다. 없으면 null.
 * rename 순간에 겹쳐 읽어도 반쯤 쓰인 내용은 절대 보이지 않는다(atomicWriteFile 참조).
 */
export async function readState(stamp) {
    assertStamp(stamp);
    return await readJsonOrNull(statePath(stamp));
}

/**
 * 상태 일부만 갱신한다. **run 프로세스 전용** — 소유권 규칙상 이 read-modify-write 를
 * 동시에 하는 프로세스가 없기 때문에 안전하다. steer 쪽에서 부르면 안 된다.
 */
export async function patchState(stamp, patch, opts = {}) {
    const cur = await readState(stamp);
    if (!cur) {
        throw new Error('runtime: 갱신할 상태가 없다 (writeState 가 먼저다): ' + stamp);
    }
    return await writeState(stamp, { ...cur, ...patch }, opts);
}

/** phase 전환 단축. 크래시 경로에서 markFailed 로도 쓴다. */
export async function setPhase(stamp, phase, extra = {}, opts = {}) {
    if (!PHASES.includes(phase)) {
        throw new Error('runtime: 알 수 없는 phase: ' + JSON.stringify(phase));
    }
    return await patchState(stamp, { phase, ...extra }, opts);
}

// ══════════════════════════════════════════════════════════════════════════
// 4. stale 판별 — "stamp 만 믿지 마라"
// ══════════════════════════════════════════════════════════════════════════

/**
 * PID 생존 확인. signal 0 은 신호를 보내지 않고 존재만 확인한다.
 * ESRCH = 없음, EPERM = 있지만 내 권한 밖(= 살아 있음).
 *
 * 🔴 한계: OS 는 PID 를 재사용한다. PID 만으로는 "그 실행"인지 확신할 수 없다.
 *    그래서 checkSteerable() 은 nonce·startedAt 까지 함께 본다. PID 는 보조 신호다.
 */
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) { return false; }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return !!(e && e.code === 'EPERM');
    }
}

/**
 * 이 상태로 steer 를 보내도 되는가. stale run 오염 방지의 관문이다.
 *
 * @param state  readState() 결과
 * @param expect { stamp, host?, nonce?, threadId?, requirePhase? }
 *               host 는 넘기지 않으면 os.hostname() 과 비교한다.
 *               nonce·threadId 는 호출자가 아는 경우에만 대조한다(모르면 건너뛴다).
 *               requirePhase 기본값은 'active' — 계약이 "phase === 'active'" 를 요구한다.
 * @returns { ok, reasons[], state }
 *
 * 🔴 여기서 **시간 기반 판정(heartbeat stale)을 하지 않는다.** "몇 초 안 움직이면 죽은
 *    것으로 본다" 는 유예 시간이 필요한데, 그 숫자에 근거가 없다. 근거 없는 유예값을
 *    박았다가 사고가 난 전례가 있어서 의도적으로 뺐다.
 *    ⬜ 결정 필요: 시간 기반 판정이 필요해지면 호출자가 임계치를 넘기는 형태로 추가한다.
 */
export function checkSteerable(state, expect = {}) {
    const reasons = [];
    if (!state) {
        return { ok: false, reasons: ['상태 파일이 없다 (실행 중이 아니거나 이미 정리됨)'], state: null };
    }
    if (state.schema !== SCHEMA) {
        reasons.push('스키마 버전 불일치: 파일 ' + state.schema + ' vs 기대 ' + SCHEMA);
    }
    if (expect.stamp !== undefined && state.stamp !== expect.stamp) {
        reasons.push('stamp 불일치: ' + state.stamp + ' vs ' + expect.stamp);
    }
    const wantHost = expect.host ?? os.hostname();
    if (state.host !== wantHost) {
        // 같은 stamp 가 다른 머신에서도 만들어질 수 있다. 임시 디렉토리가 공유되는
        // 환경(네트워크 홈 등)에서 남의 실행을 조종하는 사고를 막는다.
        reasons.push('host 불일치: ' + state.host + ' vs ' + wantHost);
    }
    if (expect.nonce !== undefined && state.nonce !== expect.nonce) {
        reasons.push('실행 nonce 불일치 (같은 stamp 의 다른 실행이다)');
    }
    if (expect.threadId !== undefined && state.threadId !== expect.threadId) {
        reasons.push('threadId 불일치: ' + state.threadId + ' vs ' + expect.threadId);
    }
    if (!isPidAlive(state.pid)) {
        reasons.push('pid ' + state.pid + ' 가 살아 있지 않다 (크래시했거나 이미 끝났다)');
    }
    const requirePhase = expect.requirePhase === undefined ? 'active' : expect.requirePhase;
    if (requirePhase !== null && state.phase !== requirePhase) {
        reasons.push('phase 가 ' + JSON.stringify(state.phase) + ' 다 (필요: ' + JSON.stringify(requirePhase) + ')');
    }
    return { ok: reasons.length === 0, reasons, state };
}

// ══════════════════════════════════════════════════════════════════════════
// 5. steer 큐
// ══════════════════════════════════════════════════════════════════════════

/**
 * seq 를 원자적으로 선점한다. `seq/<0001>` 빈 파일을 O_EXCL(wx) 로 만드는 데
 * 성공한 프로세스가 그 번호의 주인이다. 여러 steer 가 동시에 들어와도 번호가 겹치지 않는다.
 *
 * 이미 쓰인 번호는 파일로 남아 있으므로 drain 이 지나가도 카운터가 되돌아가지 않는다
 * (메모리 카운터나 "큐에 남은 개수 + 1" 방식이 무너지는 지점이다).
 */
async function reserveSeq(stamp, opts = {}) {
    const limit = opts.seqProbeLimit ?? TUNABLES.seqProbeLimit;
    const dir = seqDirPath(stamp);
    await ensureDir(dir);
    let start = 1;
    try {
        const used = await fsp.readdir(dir);
        let max = 0;
        for (const name of used) {
            const n = Number.parseInt(name, 10);
            if (Number.isInteger(n) && n > max) { max = n; }
        }
        start = max + 1;
    } catch { /* 디렉토리가 막 만들어졌으면 비어 있다 — start=1 */ }

    for (let seq = start; seq < start + limit; seq++) {
        const marker = path.join(dir, String(seq).padStart(6, '0'));
        try {
            await fsp.writeFile(marker, '', { flag: 'wx', mode: 0o600 });
            return seq;
        } catch (e) {
            if (e && e.code === 'EEXIST') { continue; }   // 다른 프로세스가 선점했다
            throw e;
        }
    }
    // 조용히 뭉개지 않는다. seq 붕괴는 나중에 순서 뒤집힘으로 나타나 추적이 매우 어렵다.
    throw new Error('runtime: seq 예약이 ' + limit + '회 연속 충돌했다 (' + stamp + ')');
}

/**
 * steer 요청을 큐에 넣는다. **steer 프로세스가 부른다.**
 * state.json 은 건드리지 않는다(쓰기 소유권 규칙).
 *
 * @param  {string} stamp
 * @param  {{text:string, source?:string, nonce?:string}} req
 *         nonce 를 안 주면 makeNonce() 로 만든다. 재전송을 막고 싶으면 **호출자가
 *         같은 nonce 를 다시 보내면 된다** — 두 번째부터는 큐에 쌓이지 않는다.
 * @returns {{seq:number, nonce:string, duplicate:boolean}}
 *         duplicate=true 면 이미 들어와 있던 요청이고, seq 는 그 최초 요청의 번호다.
 */
export async function enqueueSteer(stamp, req = {}, opts = {}) {
    assertStamp(stamp);
    const text = req.text;
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('runtime: steer text 가 비어 있다');
    }
    const nonce = req.nonce ?? makeNonce();
    const key = nonceKey(nonce);
    const dir = steerDirPath(stamp);
    await ensureDir(dir);
    const file = path.join(dir, key + '.json');

    // 빠른 경로: 이미 있으면 seq 를 낭비하지 않고 바로 돌려준다.
    const existing = await readJsonOrNull(file);
    if (existing) {
        return { seq: existing.seq, nonce, duplicate: true };
    }

    const seq = await reserveSeq(stamp, opts);
    const payload = {
        seq,
        text,
        source: req.source ?? 'unknown',
        nonce,
        at: new Date().toISOString(),
        from: { host: os.hostname(), pid: process.pid }
    };
    try {
        // 🔴 wx(O_EXCL) 가 중복 차단의 전부다. 검사-후-쓰기(TOCTOU)로는 동시 도착을 못 막는다.
        //    여기서는 atomicWriteFile 을 쓰지 않는다 — rename 은 기존 파일을 덮어써서
        //    "이미 있으면 실패" 라는 성질을 잃기 때문이다.
        await fsp.writeFile(file, JSON.stringify(payload) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (e) {
        if (e && e.code === 'EEXIST') {
            // 빠른 경로 확인과 이 쓰기 사이에 다른 프로세스가 같은 nonce 로 들어왔다.
            // 예약한 seq 는 구멍으로 남지만 순서에는 영향이 없어 무해하다.
            const now = await readJsonOrNull(file);
            return { seq: now ? now.seq : seq, nonce, duplicate: true };
        }
        throw e;
    }
    return { seq, nonce, duplicate: false };
}

/**
 * 아직 안 가져간 steer 요청을 seq 오름차순으로 모두 꺼낸다. **run 프로세스가 부른다.**
 * 꺼낸 항목은 taken 마커로 표시되어 다음 drain 에 다시 나오지 않는다.
 *
 * 반환값에 원문(text)이 그대로 들어 있다 — 전달에 실패해도 호출자가 FOLLOWUP 후보로
 * 넘길 수 있어야 하므로 이 모듈은 원문을 절대 버리지 않는다.
 *
 * @returns {Array<{seq, text, source, nonce, at}>}
 */
export async function drainSteer(stamp) {
    assertStamp(stamp);
    const dir = steerDirPath(stamp);
    let names;
    try {
        names = await fsp.readdir(dir);
    } catch (e) {
        if (e && e.code === 'ENOENT') { return []; }  // 아직 아무도 steer 를 안 보냈다
        throw e;
    }
    const takenDir = takenDirPath(stamp);
    let taken = new Set();
    try {
        taken = new Set(await fsp.readdir(takenDir));
    } catch { /* 없으면 아무것도 안 가져간 것 */ }

    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        const key = name.slice(0, -'.json'.length);
        if (taken.has(key)) { continue; }
        const item = await readJsonOrNull(path.join(dir, name));
        if (!item) { continue; }  // 읽는 사이에 사라졌다 — 다음 drain 에서 다시 본다
        out.push(item);
    }
    // seq 순 직렬 처리. 파일 목록 순서(OS 마다 다르다)에 기대지 않는다.
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    // 표시는 **읽기가 다 끝난 뒤** 한다. 중간에 죽으면 표시 안 된 항목이 다음 drain 에
    // 다시 나온다 — at-least-once. 반대(먼저 표시)로 하면 유실이라 더 나쁘다.
    if (out.length > 0) {
        await ensureDir(takenDir);
        for (const item of out) {
            const marker = path.join(takenDir, nonceKey(item.nonce));
            try {
                await fsp.writeFile(marker, String(item.seq), { flag: 'wx', mode: 0o600 });
            } catch (e) {
                if (!e || e.code !== 'EEXIST') { throw e; }
            }
        }
    }
    return out;
}

/**
 * steer 를 실제로 서버에 넘긴 결과를 기록한다. **run 프로세스가 부른다.**
 *
 * 🔴 성공으로 위장하지 마라. 서버가 `-32600 no active turn to steer` 로 거부했으면
 *    outcome='rejected' 로, 응답을 못 본 채 끊겼으면 'unknown' 으로 남긴다.
 *    원문(text)을 함께 저장해 두어야 호출자가 FOLLOWUP 후보로 되살릴 수 있다.
 *
 * @param {{nonce:string, outcome:'delivered'|'rejected'|'unknown', seq?:number,
 *          text?:string, turnId?:string, error?:{code?:number, message?:string}}} rec
 */
export async function recordSteerOutcome(stamp, rec = {}, opts = {}) {
    assertStamp(stamp);
    if (!OUTCOMES.includes(rec.outcome)) {
        throw new Error('runtime: 알 수 없는 outcome: ' + JSON.stringify(rec.outcome) + ' (허용: ' + OUTCOMES.join('|') + ')');
    }
    const key = nonceKey(rec.nonce);
    const file = path.join(outcomeDirPath(stamp), key + '.json');
    // 원문이 안 넘어왔으면 큐에서 되찾아 온다 — 원문 유실이 이 모듈에서 가장 나쁜 결과다.
    let text = rec.text;
    if (text === undefined) {
        const q = await readJsonOrNull(path.join(steerDirPath(stamp), key + '.json'));
        text = q ? q.text : undefined;
    }
    const payload = {
        seq: rec.seq,
        nonce: rec.nonce,
        outcome: rec.outcome,
        text,
        turnId: rec.turnId,
        error: rec.error,
        at: new Date().toISOString()
    };
    // 같은 nonce 를 재판정할 수 있어야 하므로(unknown → delivered 정정) 덮어쓰기가 맞다.
    await atomicWriteFile(file, JSON.stringify(payload) + '\n', opts);
}

/** 기록된 전달 결과 전체를 seq 순으로 돌려준다. */
export async function listSteerOutcomes(stamp) {
    assertStamp(stamp);
    const dir = outcomeDirPath(stamp);
    let names;
    try {
        names = await fsp.readdir(dir);
    } catch (e) {
        if (e && e.code === 'ENOENT') { return []; }
        throw e;
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        const rec = await readJsonOrNull(path.join(dir, name));
        if (rec) { out.push(rec); }
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
}

/**
 * **전달되지 않은 steer 원문**을 seq 순으로 돌려준다.
 * 호출자(run 의 마무리 단계)가 이걸 기존 FOLLOWUP 후보로 넘긴다.
 *
 * 판정: outcome 이 'delivered' 인 것만 전달됨으로 본다.
 *   · 'rejected'      → 미전달 (완료 직전 steer 등)
 *   · 'unknown'       → 미전달로 취급. 🔴 모르면 누락 쪽으로 기운다. 중복 전달이
 *                       사용자에게 보이는 것보다 조용한 유실이 훨씬 나쁘다.
 *   · 기록 자체가 없음 → 미전달 ('no-record')
 */
export async function listUndeliveredSteer(stamp) {
    assertStamp(stamp);
    const dir = steerDirPath(stamp);
    let names;
    try {
        names = await fsp.readdir(dir);
    } catch (e) {
        if (e && e.code === 'ENOENT') { return []; }
        throw e;
    }
    const outcomes = new Map();
    for (const rec of await listSteerOutcomes(stamp)) {
        outcomes.set(nonceKey(rec.nonce), rec);
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        const item = await readJsonOrNull(path.join(dir, name));
        if (!item) { continue; }
        const rec = outcomes.get(name.slice(0, -'.json'.length));
        if (rec && rec.outcome === 'delivered') { continue; }
        out.push({
            seq: item.seq,
            text: item.text,
            source: item.source,
            nonce: item.nonce,
            at: item.at,
            outcome: rec ? rec.outcome : 'no-record',
            error: rec ? rec.error : undefined
        });
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 6. 비권위 UI 미러
// ══════════════════════════════════════════════════════════════════════════

/**
 * `.log/<stamp>_live.json` 에 **UI 용 비민감 필드만** 복제한다.
 *
 * 🔴 port·pid·nonce·cwd 는 절대 넣지 마라. `.log/` 는 Codex 의 workspace-write 안이라
 *    거기 있는 값은 조작 가능하고, 제어 정보가 새면 steer 통로가 뚫린다.
 *    복제 스키마는 계약에 고정되어 있다:
 *      { schema, transport:"app-server", active, turnId, steerCount, lastSteerAt }
 *
 * 실패해도 던지지 않는다 — 비권위 telemetry 때문에 본 작업이 죽으면 안 된다.
 * @returns {boolean} 실제로 썼는지
 */
export async function writeLiveMirror(logDir, stamp, fields = {}, opts = {}) {
    try {
        assertStamp(stamp);
        const payload = {
            schema: SCHEMA,
            transport: 'app-server',
            active: !!fields.active,
            turnId: fields.turnId ?? null,
            steerCount: Number.isInteger(fields.steerCount) ? fields.steerCount : 0,
            lastSteerAt: fields.lastSteerAt ?? null
        };
        await atomicWriteFile(path.join(logDir, stamp + '_live.json'), JSON.stringify(payload) + '\n', opts);
        return true;
    } catch {
        return false;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 7. 정리
// ══════════════════════════════════════════════════════════════════════════

/**
 * 실행별 디렉토리를 통째로 지운다. run 이 정상 종료할 때 부른다.
 *
 * ⬜ 결정 필요: **자동 GC 를 넣지 않았다.** "며칠 지난 디렉토리를 지운다" 같은 정책은
 *    보관 기간이라는 근거 없는 수치가 필요하고, 미전달 steer 원문이 감사 자료라
 *    함부로 지우면 안 된다. 오래된 실행 정리 정책은 호출자/사용자가 정할 몫이다.
 */
export async function cleanupRuntime(stamp) {
    assertStamp(stamp);
    await fsp.rm(runtimePath(stamp), { recursive: true, force: true });
}

/**
 * 크래시 경로에서 부른다. 상태를 failed 로 내리고, 아직 판정이 없는 steer 를
 * 전부 'unknown' 으로 확정한다 — "수락 여부가 불명확하면 unknown" 규칙.
 *
 * 프로세스가 정말 급사하면 이것도 못 부른다. 그 경우는 읽는 쪽의 checkSteerable() 이
 * pid 생존으로 걸러낸다(이중 방어).
 */
export async function markFailed(stamp, info = {}, opts = {}) {
    try {
        await setPhase(stamp, 'failed', { failedAt: new Date().toISOString(), error: info.error }, opts);
    } catch { /* 상태 파일이 없을 수도 있다 — 아래 unknown 확정은 그래도 시도한다 */ }
    const pending = await listUndeliveredSteer(stamp).catch(() => []);
    for (const item of pending) {
        if (item.outcome === 'no-record') {
            await recordSteerOutcome(stamp, {
                seq: item.seq,
                nonce: item.nonce,
                outcome: 'unknown',
                text: item.text,
                error: { message: '실행이 비정상 종료해 전달 여부를 확인하지 못했다' }
            }, opts).catch(() => { });
        }
    }
}

// 동기 버전이 필요한 곳(프로세스 exit 훅 등)을 위한 최소 헬퍼.
// exit 훅에서는 await 가 돌지 않으므로 동기 읽기가 유일한 수단이다.
export function readStateSync(stamp) {
    assertStamp(stamp);
    try {
        return JSON.parse(fs.readFileSync(statePath(stamp), 'utf8'));
    } catch (e) {
        if (e && e.code === 'ENOENT') { return null; }
        throw e;
    }
}
