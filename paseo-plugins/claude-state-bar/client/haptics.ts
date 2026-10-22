import { currentSettings } from "./sounds";

// 폰 앱에서 누를 때 짧은 진동(10-21 리규형님 — 알약·받아쓰기 X·연필·올리기·프로젝트 고르기 "햅틱 반응이 좀 일어났으면").
// 단추마다 붙이지 않고 화면 전체의 누르기 확정(click, 캡처 단계) 하나를 받아 대상이면 폰 앱 PaseoShell.haptic() 을 부른다.
// 누르는 순간(pointerdown)이 아니라 click 인 것은 프로젝트 목록을 스크롤하려고 항목 위에 손만 대도 울리지 않게(Claude 판단) —
// Paseo 단추(react-native-web Pressable)는 click 에서 onPress 를 부르므로 단추가 동작하면 진동도 온다.
// 대상(리규형님 버튼 "입력창 둘레 단추 전부"): 입력창 위 알약 줄([data-csb-track])의 단추 · 입력창 영역(testID message-input-root) 안 단추
// — 받아쓰기 취소·전사 삽입·전사 삽입 후 보내기·첨부·모델 선택·받아쓰기 시작·보내기·중지 · 플러그인 프로젝트 목록의 "○○ 열기"
// (testID csb-project-open, projectsList.tsx). 이름표가 아니라 자리로 골라 Paseo 언어와 상관없다. 꺼진 단추는 울리지 않는다.
// 폰 앱이 haptic 을 줄 때만(옛 앱·PC 화면은 아무 일 없음) · 설정 hapticPhone(처음 켬). 플러그인이 호스트마다 실려도 페이지에 받는 곳은
// 하나(전역 허브) — 한 번 누름에 진동 한 번.
export const HAPTIC_TARGETS = [
  '[data-csb-track] [role="button"]',
  "[data-csb-track] button",
  '[data-testid="message-input-root"] [role="button"]',
  '[data-testid="message-input-root"] button',
  '[data-testid="csb-project-open"]',
].join(",");
const HUB_VERSION = 1;

type El = { closest?: (selector: string) => El | null; getAttribute?: (name: string) => string | null; disabled?: boolean };
type Listener = (event: { target?: unknown }) => void;
type Doc = { addEventListener?: (type: string, fn: Listener, capture: boolean) => void; removeEventListener?: (type: string, fn: Listener, capture: boolean) => void };
type Hub = { version: number; owners: Set<() => boolean>; stop: () => void };
type Global = { document?: Doc; PaseoShell?: { haptic?: () => unknown }; __claudeStateBar_haptics?: Hub };

/** 누른 곳이 진동 대상 단추 안인가 — 꺼진 단추(aria-disabled·disabled)는 아니다 */
export function hapticTarget(target: unknown): boolean {
  const el = (target as El | null)?.closest?.(HAPTIC_TARGETS);
  if (!el) return false;
  return el.getAttribute?.("aria-disabled") !== "true" && el.disabled !== true;
}

/** 연결마다 소유권 하나. 마지막 연결이 내려갈 때 받는 곳을 뗀다 */
export function startHaptics(log: (message: string) => void): () => void {
  const g = globalThis as Global;
  const doc = g.document;
  if (!doc?.addEventListener) return () => {};
  const enabled = () => currentSettings().hapticPhone !== false;
  let hub = g.__claudeStateBar_haptics;
  // 옛 판 허브면 받는 곳만 바꿔 끼우고 소유자 목록은 이어받는다(옛 연결이 내려갈 때 같은 목록에서 빠진다)
  const owners = hub?.owners ?? new Set<() => boolean>();
  if (hub && hub.version < HUB_VERSION) {
    hub.stop();
    hub = undefined;
  }
  if (!hub) {
    const onClick: Listener = (event) => {
      const shell = g.PaseoShell;
      if (typeof shell?.haptic !== "function") return;
      if (![...owners].some((on) => on())) return;
      if (!hapticTarget(event.target)) return;
      try {
        shell.haptic();
      } catch {
        // 앱이 거절해도 누르기는 그대로 간다
      }
    };
    doc.addEventListener("click", onClick, true);
    hub = { version: HUB_VERSION, owners, stop: () => doc.removeEventListener?.("click", onClick, true) };
    g.__claudeStateBar_haptics = hub;
  }
  const mine = hub;
  mine.owners.add(enabled);
  log(`haptics: on (phone app haptic ${typeof g.PaseoShell?.haptic === "function" ? "yes" : "no"})`);
  return () => {
    mine.owners.delete(enabled);
    if (!mine.owners.size && g.__claudeStateBar_haptics === mine) {
      mine.stop();
      delete g.__claudeStateBar_haptics;
    }
  };
}
