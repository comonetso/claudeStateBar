import { watch, type FSWatcher, type WatchListener } from "node:fs";

/** 생성 실패는 호출자의 기존 catch로, 생성 후 오류는 여기로 받는다. 새 재시도 주기는 만들지 않는다. */
export function watchSafe(target: string, listener: WatchListener<string>, failed: () => void = () => {}): FSWatcher {
  const watcher = watch(target, listener);
  watcher.on("error", () => { watcher.close(); failed(); });
  return watcher;
}
