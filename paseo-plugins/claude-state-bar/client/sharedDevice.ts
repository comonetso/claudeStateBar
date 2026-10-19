import { runCleanups } from "./cleanup";

type Stop = () => void;
export type SharedDevice = {
  version?: number;
  stop: Stop | null;
  refresh?: Stop | null;
  running?: { version: number; stop: Stop };
};

function stopDevice(hub: SharedDevice): void {
  const stop = hub.stop;
  hub.stop = null;
  hub.refresh = null;
  delete hub.running;
  if (stop) runCleanups([stop]);
}

/** version은 옛 코드용 최고 판 표식, running은 실제 실행 판·정지 함수다.
 * 옛 코드가 stop만 갈아 끼운 경우도 함수 동일성으로 감지해 넘겨받는다. 등록 목록은 보존한다. */
export function joinSharedDevice(hub: SharedDevice, version: number, start: () => void, leave: () => boolean, empty?: () => boolean): Stop {
  if (!hub.stop || hub.running?.stop !== hub.stop || hub.running.version < version) {
    stopDevice(hub);
    hub.version = Math.max(hub.version ?? 0, version);
    start();
    if (hub.stop) {
      hub.running = { version, stop: hub.stop };
      // 옛 turnRead/DOCK 해제는 자기 판이 아니면 refresh만 부른다.
      // 마지막 옛 등록도 새 장치를 멈출 수 있게 이 공용 출구에서 확인한다.
      const refresh = hub.refresh;
      hub.refresh = () => { if (empty?.()) stopDevice(hub); else refresh?.(); };
    }
  } else hub.refresh?.();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (leave()) stopDevice(hub);
    else hub.refresh?.();
  };
}
