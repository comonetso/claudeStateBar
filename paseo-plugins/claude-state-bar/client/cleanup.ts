/** 한 해제의 실패가 뒤 해제를 막지 않게 한다. 오류 보고 자체가 실패해도 계속한다. */
export function runCleanups(cleanups: readonly (() => void)[], onError?: (error: unknown) => void): void {
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (error) {
      try { onError?.(error); } catch { /* 다음 해제 계속 */ }
    }
  }
}
