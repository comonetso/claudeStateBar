// 10-17 리규형님 결정: 화면이 가려진 동안 목록 갱신(데몬 RPC)을 멈추고, 다시 보이면 바로 한 번 읽는다 — 가려진 탭도
// 무언가 돌고 있으면 2초마다 목록을 받았다(웹은 중계를 거쳐 콜어드민 회선 20M 을 나눠 쓴다).
// 소리 대기 요청은 여기 걸지 않는다(가려져 있어도 울려야 한다). document 가 없는 폰 앱은 늘 보이는 것으로 본다.
declare const document:
  | { visibilityState?: string; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void }
  | undefined;

export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** 화면이 다시 보이는 순간마다 fn 을 부른다. 해제 함수를 돌려준다 */
export function onPageVisible(fn: () => void): () => void {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
  const handler = () => {
    if (document.visibilityState === "visible") fn();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
