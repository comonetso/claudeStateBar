import { rename } from "node:fs/promises";

/**
 * 임시 파일을 제자리로 바꿔 끼운다. Windows 는 바꿀 파일을 백신 등이 잠깐 열고 있으면 EPERM·EACCES 로 거절한다
 * (10-15 리규형님: 프로젝트 이름 바꾸기가 PC·폰에서 한 번씩 "EPERM: operation not permitted, rename …projects.json.<pid>.tmp" — 다시 하면 됐다).
 * npm 의 graceful-fs(polyfills.js rename)와 같은 간격 — 0ms 부터 10ms 씩 늘려 100ms 까지, 60초 안 — 으로 다시 한다.
 * graceful-fs 는 대상 파일이 없을 때만 다시 하지만 우리는 덮어쓸 때 났으므로 덮어쓰기도 다시 한다. 다른 운영체제는 한 번만.
 * 잠금을 쥔 채 부르는 곳은 maxMs 를 그 잠금의 상대 대기보다 짧게 준다(account.ts — 실행기들이 같은 잠금을 5초까지만 기다린다)
 */
export async function renameRetry(from: string, to: string, opts: { maxMs?: number; beforeAttempt?: () => void } = {}): Promise<void> {
  if (process.platform !== "win32") { opts.beforeAttempt?.(); return rename(from, to); }
  const maxMs = opts.maxMs ?? 60_000;
  const start = Date.now();
  let backoff = 0;
  for (;;) {
    try {
      opts.beforeAttempt?.();
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || Date.now() - start >= maxMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      if (backoff < 100) backoff += 10;
    }
  }
}

// 동기 쓰기를 비동기 재시도로 바꾸는 호출자는 읽기→임시 쓰기→rename 전체를 이 안에서 실행한다.
// 같은 파일의 고정 임시 이름을 동시에 쓰거나 read-modify-write 갱신을 잃지 않게 한다.
const writing = new Map<string, Promise<unknown>>();
export function serializeFileWrite<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (writing.get(file) ?? Promise.resolve()).catch(() => {}).then(run);
  writing.set(file, next);
  void next.finally(() => { if (writing.get(file) === next) writing.delete(file); }).catch(() => {});
  return next;
}
