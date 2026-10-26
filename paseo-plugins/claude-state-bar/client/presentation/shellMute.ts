// 폰 앱(PaseoShell, F:/workspace/phonegapProject/Paseo) 음소거 단추를 따라간다(10-15 리규형님 — 깜빡 켜 둔 채 미팅에 들어가면
// 소리가 울려서). 처음 값은 `window.PaseoShell.isMuted()`, 바뀌면 앱이 `paseoshell:mute` 이벤트(detail.muted)를 보낸다
// (앱 ShellBridge.kt MUTE_EVENT — 그쪽 대화와 맞춘 약속). 앱 밖(PC·브라우저)은 늘 false.
// 음소거면 끝남 소리·읽기 소리를 모두 내지 않고, 이 화면은 소리 후보에서 빠져 다른 화면이 울린다(soundScreen → PC 데몬 choose).
// 페이지에 하나 — 플러그인을 다시 읽어도(호스트마다 따로 실려도) 같은 상태를 쓴다.

type ShellBridge = { isMuted?: () => boolean };
type MuteEvent = { detail?: { muted?: unknown } };
type MuteHub = { muted: boolean; listeners: Set<() => void> };

function muteHub(): MuteHub {
  const g = globalThis as {
    __claudeStateBar_shellMute_v1?: MuteHub;
    PaseoShell?: ShellBridge;
    addEventListener?: (type: string, fn: (event: MuteEvent) => void) => void;
  };
  if (g.__claudeStateBar_shellMute_v1) return g.__claudeStateBar_shellMute_v1;
  const h: MuteHub = { muted: false, listeners: new Set() };
  g.__claudeStateBar_shellMute_v1 = h;
  try {
    h.muted = g.PaseoShell?.isMuted?.() === true;
  } catch {
    h.muted = false;
  }
  g.addEventListener?.("paseoshell:mute", (event) => {
    const next = event?.detail?.muted === true;
    if (h.muted === next) return;
    h.muted = next;
    for (const f of [...h.listeners]) {
      try {
        f();
      } catch {
        /* 듣는 쪽 오류가 다른 쪽을 막지 않게 */
      }
    }
  });
  return h;
}

/** 폰 앱 음소거 중인가 */
export function shellMuted(): boolean {
  return muteHub().muted;
}

/** 음소거가 바뀔 때마다 부른다. 돌려준 함수로 그만 듣는다 */
export function watchShellMute(listener: () => void): () => void {
  const h = muteHub();
  h.listeners.add(listener);
  return () => {
    h.listeners.delete(listener);
  };
}
