// 플러그인 요청 시간 초과 진단(10-22) — 10-21 18:56~10-22 00:32 PC 데몬에 "Plugin RPC timed out: claude-state-bar.invoke" 871건.
// 데몬은 요청마다 30초를 기다린다(Paseo REQUEST_TIMEOUT_MS). 화면의 기다림 요청은 25초에 답하는데 그보다 늦은 것이 몰려서 끊겼다.
// 데몬·이 프로세스 모두 평소엔 한가했고(60초 CPU 1.7%) 그 순간을 잡을 기록이 없었다 → 다음 발생 때 원인을 가를 세 가지를 남긴다.
//   ① 요청 하나가 27초를 넘기면 이름·걸린 시간 ② 이 프로세스가 0.5초 넘게 멈추면 그 길이와 그때 처리 중이던 요청 ③ 줄에서 오래 기다린 일(waitedLong)
// 기록은 데몬 기록(Plugin output)에 "[diag]" 로 남는다. 동작은 바꾸지 않는다

type Inflight = { name: string; at: number };
const inflight = new Map<number, Inflight>();
let seq = 0;

/** 27초 — 화면 기다림 요청(25초)보다 길고 데몬 한도(30초)보다 짧다. 정상 25초 기다림은 찍지 않는다 */
const SLOW_RPC_MS = 27_000;
/** 0.5초 넘는 멈춤만 — 데몬 이벤트 루프 평소 최대(0.2~0.3초)보다 크다 */
const STALL_MS = 500;
const TICK_MS = 250;

function busyList(now: number): string {
  const list = [...inflight.values()].sort((a, b) => a.at - b.at).slice(0, 4);
  return list.length ? list.map((r) => `${r.name} ${((now - r.at) / 1000).toFixed(1)}s`).join(", ") : "없음";
}

/** 요청 처리 함수를 감싼다 — 처리 중 목록에 넣고, 27초를 넘기면 끝날 때 한 줄 */
export function trackRpc<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const id = ++seq;
    const at = Date.now();
    inflight.set(id, { name, at });
    try {
      return await fn(...args);
    } finally {
      inflight.delete(id);
      const ms = Date.now() - at;
      if (ms > SLOW_RPC_MS) console.log(`[diag] slow rpc ${name} ${ms}ms`);
    }
  };
}

/** 줄에서 오래 기다린 일 — 부르는 쪽이 기준을 정한다 */
export function waitedLong(what: string, ms: number): void {
  console.log(`[diag] ${what} waited ${ms}ms · busy: ${busyList(Date.now())}`);
}

/** 이 프로세스가 멈춘 길이를 잰다 — 0.25초마다 깨어나 늦은 만큼이 0.5초를 넘으면 한 줄. 프로세스 종료를 붙잡지 않는다 */
export function startStallWatch(): () => void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const stalled = now - last - TICK_MS;
    last = now;
    if (stalled > STALL_MS) console.log(`[diag] event loop stalled ${stalled}ms · busy: ${busyList(now)}`);
  }, TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
