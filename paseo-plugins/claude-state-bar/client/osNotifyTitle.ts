import { alertNameOfWorkspace } from "./headerTitles";
import { joinSharedDevice, type SharedDevice } from "./sharedDevice";

// PC 화면 알림(Paseo 가 브라우저·데스크톱 앱으로 띄우는 "Agent finished" 같은 알림) 제목 끝에 프로젝트 이름을 붙인다
// (10-21 리규형님 "어떤 플젝인지 표시" · 모양 "Agent finished — 이름 - 카테고리", 폰 알림 "질문 — 이름 - 카테고리"와 같다).
// Paseo 화면은 알림을 띄울 때마다 globalThis.Notification(브라우저) 또는 window.paseoDesktop.notification.sendNotification
// (데스크톱 앱)을 그때 꺼내 쓰고, 알림 data 에 workspaceId 를 싣는다(Paseo 0.12.0 sendOsNotification) — 그 둘을 감싸
// workspaceId 로 이름을 찾는다. 이름을 모르면 원래 제목 그대로. 기기마다 플러그인이 실려도 페이지에 하나만 감싸고, 끝나면 되돌린다.
// 데스크톱 앱이 그 기능을 잠가 두었으면(바꾸기 막힘) 그 창은 그대로 둔다 — 기록만 남긴다

const VERSION = 1;
type Hub = SharedDevice & { users: Set<object> };
function hub(): Hub {
  const g = globalThis as Record<string, unknown>;
  return (g.__claudeStateBar_osNotifyTitle_v1 ??= { users: new Set(), stop: null }) as Hub;
}

/** 제목 끝에 " — 이름" — 이름을 모르거나 이미 붙어 있으면 그대로 */
export function namedTitle(title: unknown, data: unknown, nameOf: (workspaceId: string) => string | null): unknown {
  if (typeof title !== "string") return title;
  const id = data && typeof data === "object" ? (data as { workspaceId?: unknown }).workspaceId : undefined;
  const name = typeof id === "string" && id ? nameOf(id) : null;
  if (!name || title.endsWith(` — ${name}`)) return title;
  return `${title} — ${name}`;
}

type NotificationCtor = new (title: unknown, options?: { data?: unknown }) => object;
type DesktopNotify = { sendNotification?: (n: unknown) => unknown };

export function startOsNotifyTitle(log: (message: string) => void, nameOf: (workspaceId: string) => string | null = alertNameOfWorkspace): () => void {
  const h = hub();
  const token = {};
  h.users.add(token);
  return joinSharedDevice(h, VERSION, () => {
    const g = globalThis as Record<string, unknown>;
    const undo: (() => void)[] = [];
    const Original = g.Notification as NotificationCtor | undefined;
    if (typeof Original === "function") {
      // 정적 속성(permission·requestPermission)은 물려받는다 — Paseo 가 권한을 물을 때도 같은 것을 본다
      const Named = class extends Original {
        constructor(title: unknown, options?: { data?: unknown }) {
          super(namedTitle(title, options?.data, nameOf), options);
        }
      };
      g.Notification = Named;
      undo.push(() => { if (g.Notification === Named) g.Notification = Original; });
    }
    const desktop = (g.paseoDesktop as { notification?: DesktopNotify } | undefined)?.notification;
    const send = desktop?.sendNotification;
    if (desktop && typeof send === "function") {
      const named = (n: unknown) => send.call(desktop, n && typeof n === "object" ? { ...(n as object), title: namedTitle((n as { title?: unknown }).title, (n as { data?: unknown }).data, nameOf) } : n);
      try { desktop.sendNotification = named; } catch { /* 잠긴 객체 — 아래에서 확인한다 */ }
      if (desktop.sendNotification === named) undo.push(() => { try { desktop.sendNotification = send; } catch { /* 되돌리기 실패는 다음 새로고침에 풀린다 */ } });
      else log("os notify title: desktop app notification is locked — only browser notifications get the project name");
    }
    h.stop = () => { for (const fn of undo.reverse()) fn(); };
  }, () => { h.users.delete(token); return !h.users.size; });
}
