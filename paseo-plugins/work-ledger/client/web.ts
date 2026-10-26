import { Platform } from "react-native";

// 이 플러그인은 DOM 라이브러리 없이 타입 검사한다 — 이 파일이 쓰는 것만 선언한다(Paseo 규칙: DOM 은 client/web.ts 한 곳)
declare const document: any;
declare const location: any;
declare const getComputedStyle: any;
declare const MutationObserver: any;

// 머리줄 장부 단추 자리 잡기(10-26 리규형님 버튼):
// - 폰 모양: Paseo 는 플러그인 머리줄 단추를 "워크스페이스 작업(⋯)" 메뉴 안에 넣는다 → 탭 전환("1") 왼쪽에 단추를 끼워 넣는다.
//   Paseo 가 머리줄 모양을 바꾸면 끼울 자리를 못 찾아 아무것도 안 하고, ⋯ 안의 단추는 그대로 남는다
// - 넓은 화면: Paseo 머리줄 단추 그대로 — 작업 현황 오른쪽(10-26 리규형님 "맨 오른쪽이 더 좋아, 작업 현황 옆이라 친숙해").
//   맨 왼쪽으로 옮기는 안은 버림(단추 감싸개가 display:contents 라 order 도 안 먹었다)
// 이 PC 호스트의 작업 공간에서만(서버 프로젝트는 그 서버에 장부 플러그인이 붙을 때까지 없음)

const BUTTON_ID = "work-ledger-header-button";
const TITLE = "작업 장부";
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';

function currentWorkspaceId(): string | null {
  const m = String(location?.pathname ?? "").match(/\/workspace\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 호스트가 여럿이면 호스트마다 이 플러그인이 하나씩 떠 같은 문서를 본다 — 단추마다 만든 쪽 표식을 달고 자기 것만 지운다.
// 표식 없이 하나의 id 로 찾던 때는 다른 호스트 쪽이 남의 단추를 지워 둘이 번갈아 넣고 지우며 멈추지 않았다(10-26 Codex 리뷰)
function placePhoneButton(owner: string, isOurs: (id: string) => boolean, open: (id: string) => void) {
  const anchor = document.querySelector('[data-testid="workspace-tab-switcher-trigger"]');
  const existing = document.querySelector(`[data-ledger-owner="${owner}"]`);
  const workspaceId = currentWorkspaceId();
  if (!anchor || !workspaceId || !isOurs(workspaceId)) {
    existing?.remove();
    return;
  }
  if (existing && existing.nextElementSibling === anchor && existing.dataset.workspace === workspaceId) return;
  existing?.remove();
  const s = getComputedStyle(anchor);
  const btn = document.createElement("div");
  btn.id = `${BUTTON_ID}-${owner}`;
  btn.dataset.ledgerOwner = owner;
  btn.dataset.workspace = workspaceId;
  btn.setAttribute("role", "button");
  btn.setAttribute("aria-label", TITLE);
  btn.setAttribute("title", TITLE);
  btn.tabIndex = 0;
  btn.innerHTML = ICON;
  Object.assign(btn.style, {
    width: s.width, height: s.height, borderRadius: s.borderRadius, color: s.color,
    borderWidth: s.borderWidth, borderStyle: s.borderStyle, borderColor: s.borderColor,
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: "0",
    marginRight: s.marginLeft && s.marginLeft !== "0px" ? s.marginLeft : "4px",
  });
  const go = (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    open(workspaceId);
  };
  btn.addEventListener("click", go);
  btn.addEventListener("keydown", (e: any) => {
    if (e.key === "Enter" || e.key === " ") go(e);
  });
  anchor.parentElement.insertBefore(btn, anchor);
}

export function startHeaderPlacement(isOurs: (id: string) => boolean, open: (id: string) => void): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const owner = Math.random().toString(36).slice(2, 10);
  let queued = false;
  let stopped = false;
  const run = () => {
    queued = false;
    if (stopped) return;
    try {
      placePhoneButton(owner, isOurs, open);
    } catch {
      // 머리줄 모양이 바뀌었으면 조용히 물러난다 — ⋯ 안 단추가 남는다
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(run, 50);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  schedule();
  return () => {
    stopped = true;
    observer.disconnect();
    document.querySelector(`[data-ledger-owner="${owner}"]`)?.remove();
  };
}
