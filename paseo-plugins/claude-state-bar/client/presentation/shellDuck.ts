// 따라 읽기 중 다른 소리 줄이기(10-16 리규형님 — 유튜브 같은 다른 앱 소리를 낮추고 따라 읽기를 앞에). 폰 앱(PaseoShell,
// F:/workspace/phonegapProject/Paseo)에 `window.PaseoShell.duckOthers(on)` 로 알리면 앱이 안드로이드 오디오 포커스
// (잠깐 줄이기)로 다른 앱을 낮췄다 되돌린다 — 그쪽 대화와 peer_mail 로 맞추는 약속. 앱 밖(PC·브라우저)은 함수가 없어 아무것도 안 한다.
// 페이지에 하나 — 플러그인이 호스트마다 따로 실려도 한쪽의 "됐어"가 다른 쪽의 "줄여"를 덮지 않게, 줄여 달라는 쪽이 하나라도 있으면 유지한다.

type ShellBridge = { duckOthers?: (on: boolean) => unknown };
type DuckHub = { owners: Set<string>; sent: boolean };

function duckHub(): DuckHub {
  const g = globalThis as { __claudeStateBar_shellDuck_v1?: DuckHub };
  return (g.__claudeStateBar_shellDuck_v1 ??= { owners: new Set(), sent: false });
}

/** 폰 앱이 다른 소리 줄이기를 받을 수 있는가 */
export function shellCanDuck(): boolean {
  return typeof (globalThis as { PaseoShell?: ShellBridge }).PaseoShell?.duckOthers === "function";
}

/** owner 의 바람을 바꾼다. 페이지 전체의 바람이 바뀔 때만 앱에 알린다 */
export function setShellDuck(owner: string, on: boolean, log?: (message: string) => void): void {
  const h = duckHub();
  if (on) h.owners.add(owner);
  else h.owners.delete(owner);
  const want = h.owners.size > 0;
  if (want === h.sent) return;
  const shell = (globalThis as { PaseoShell?: ShellBridge }).PaseoShell;
  if (typeof shell?.duckOthers !== "function") return;
  try {
    shell.duckOthers(want);
    h.sent = want;
    log?.(`follow read: 다른 소리 줄이기 ${want ? "켬" : "끔"}(폰 앱)`);
  } catch (error) {
    log?.(`follow read: 다른 소리 줄이기 알림 실패 ${String(error)}`);
  }
}
