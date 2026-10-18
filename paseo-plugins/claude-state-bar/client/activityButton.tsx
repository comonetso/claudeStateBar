import {
  type PluginButton,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import type { ActivityCounts } from "../shared/activity";
import { ACTIVITY_PANEL_ID, KINDS } from "./activityKinds";
import { mergeActivitySplit, openActivitySplit } from "./activitySplit";
import { useActivityOpen } from "./activityVisible";
import { clearMaximizedPane, paintMaximizedPane } from "./paneMaximized";
import { releaseMaximizedPane } from "./paneMaxWatch";
import { currentSettings } from "./sounds";
import { currentWorkspaceFromUrl, isCompactWidth, phonePillsShown, setStyleSheet, watchCompactWidth } from "./web";

/** paseo-plugin.json 의 id — Paseo 가 패널 탭에 이 이름을 붙인다 */
const PLUGIN_ID = "claude-state-bar";
import { RUNNING_COLOR } from "./format";
import type { HeaderButtonSet } from "./usageButton";
import { latestCounts, requestTab, totalOf, useCounts } from "./useCounts";

// 작업 공간 머리줄 단추 "작업 현황"(리규형님 10-05 결정: 돌고 있는 것 수는 머리줄 단추로).
// 확장은 세션 메뉴에 "작업 현황 — 워크플로우 2 · 백그라운드 1 진행 중"을 보인다. 단추 글자 칸이 좁아 합계만 두고,
// 누르면 작업 현황 패널을 연다(돌고 있는 갈래가 있으면 그 탭).

// 단축키 Ctrl+Alt+Shift+W(10-15 리규형님): 단추를 누른 것과 같은 동작. 호스트마다 플러그인이 따로 떠 있어 작업 공간을 맡은 인스턴스의
// 여는 함수를 공용 목록(작업 공간 → 여는 함수)에 적어 두고, 화면 담당 하나가 단 단축키가 지금 작업 공간으로 찾아 부른다
const OPENERS_KEY = "__claudeStateBar_activityOpeners_v1";
const openers = (): Map<string, () => void> =>
  ((globalThis as Record<string, unknown>)[OPENERS_KEY] ??= new Map<string, () => void>()) as Map<string, () => void>;
/** 그 작업 공간의 작업 현황을 머리줄 단추처럼 연다(폰 알약 — phonePills.tsx). 맡은 인스턴스가 없으면 false */
export function openActivityFor(workspaceId: string): boolean {
  const open = openers().get(workspaceId);
  if (!open) return false;
  open();
  return true;
}
/** 지금 보는 작업 공간의 작업 현황을 단추처럼 연다. 맡은 인스턴스가 없으면 false */
export function openActivityHere(): boolean {
  const here = currentWorkspaceFromUrl();
  const open = here ? openers().get(here.workspaceId) : undefined;
  if (!open) return false;
  open();
  return true;
}

/** 확장 세션 메뉴 문구(menu.activityRunning · menu.noneRunning · menu.checking) */
function summaryOf(c: ActivityCounts | null): string {
  if (!c) return "확인 중…";
  const parts = KINDS.filter((k) => c[k.key] > 0).map((k) => `${k.part} ${c[k.key]}`);
  return parts.length ? `${parts.join(" · ")} 진행 중` : "진행 중 없음";
}

// 작업 현황 패널이 열려 있는 동안(최대화로 가려져도) 단추 글자·아이콘을 초록으로(10-14 리규형님 "아이콘만으론 명시적이지 않다 — 글자 색을 초록으로").
// 단추 등록에는 글자 색이 없어 화면 스타일로 칠한다. Paseo 0.11.1 은 플러그인 머리줄 단추의 접근성 이름을 단추 설명(title)
// 그대로 단다(PASEO_UPDATE_CHECK 26번) — 열린 동안만 설명 앞에 표식을 붙이고 그 이름으로 시작하는 단추만 칠한다.
// 웹·데스크톱만(setStyleSheet). 판이 올라 접근성 이름이 바뀌면 초록 글자만 안 나온다(아이콘 초록은 그대로)
const OPEN_TITLE = "작업 현황 (열려 있음)";
const OPEN_STYLE_ID = "claude-state-bar-activity-open";
const OPEN_BUTTON = `[aria-label^="${OPEN_TITLE}"]`;
let paintedOpen: string | null = null;
function paintActivityOpen(green: string): void {
  if (paintedOpen === green) return;
  paintedOpen = green;
  setStyleSheet(OPEN_STYLE_ID, `${OPEN_BUTTON},${OPEN_BUTTON} *{color:${green} !important}${OPEN_BUTTON} svg,${OPEN_BUTTON} svg *{stroke:${green} !important}`);
}

/** 단추 글자: 돌고 있으면 합계, 아니면 이름만(글자 칸이 160px 라 종류별로는 못 넣는다) */
function presentation(c: ActivityCounts | null, open = false): Pick<PluginButton, "label" | "title"> {
  const n = c ? totalOf(c) : 0;
  return { label: n > 0 ? `진행 중 ${n}` : "작업 현황", title: `${open ? OPEN_TITLE : "작업 현황"} — ${summaryOf(c)}` };
}

/**
 * 작업 공간마다 머리줄 단추 하나. 앱이 단추를 보이는 작업 공간에서만 그리므로, 수 읽기는 단추 그림(아이콘 컴포넌트)이
 * 맡는다 — 다른 작업 공간·다른 호스트는 화면에 나올 때까지 읽지 않는다. 작업 공간 목록은 이 호스트의 것을 구독한다.
 * leading: 작업 현황 단추 왼쪽에 둘 단추(사용량, 10-06) — Paseo 는 등록한 순서대로 왼쪽부터 그려서 먼저 등록한다.
 */
export function createActivityButtons(client: PluginClientContext, log: (message: string) => void, leading?: HeaderButtonSet): () => void {
  const registrations = new Map<string, PluginButtonRegistration>();
  const shown = new Map<string, string>();
  let disposed = false;
  let release: (() => void) | undefined;

  const present = (workspaceId: string, counts: ActivityCounts | null, open: boolean) => {
    const next = presentation(counts, open);
    const key = `${next.label}\n${next.title}`;
    if (shown.get(workspaceId) === key) return;
    shown.set(workspaceId, key);
    registrations.get(workspaceId)?.update(next);
  };

  function ActivityIcon({ workspaceId, size, color, theme }: PluginButtonIconProps) {
    const counts = useCounts(workspaceId);
    const running = counts ? totalOf(counts) > 0 : false;
    // 작업 현황 패널이 열려 있으면 늘 초록 — 대화 칸을 최대화해 가려져도(10-14 리규형님). 돌고 있으면서 열려 있으면 도는 아이콘을 초록으로
    const open = useActivityOpen(workspaceId);
    useEffect(() => present(workspaceId, counts, open), [workspaceId, counts, open]);
    // 칸 최대화 단추 주황(10-08) — 테마는 화면 부품만 받아서, 작업 공간 화면에 늘 있는 이 단추가 테마가 바뀔 때마다 칠한다
    useEffect(() => paintMaximizedPane(theme), [theme]);
    useEffect(() => paintActivityOpen(theme.colors.statusSuccess), [theme]);
    return <Icon name={running ? "LoaderCircle" : "Activity"} size={size} color={open ? theme.colors.statusSuccess : running ? RUNNING_COLOR : color} />;
  }

  // 누르면 작업 현황 패널을 바로 연다(작은 창은 두 번 떠 보였다 — 리규형님 10-05). 돌고 있는 갈래가 있으면 그 탭으로.
  // 웹·데스크톱에서 칸이 하나뿐이면 새로고침 없이 왼쪽에 작업 현황 칸을 만든다(activitySplit).
  const openActivity = (workspaceId: string) => {
    const c = latestCounts(workspaceId);
    const running = c ? KINDS.find((k) => c[k.key] > 0) : undefined;
    if (running) requestTab(workspaceId, running.key);
    const here = currentWorkspaceFromUrl();
    if (here?.workspaceId === workspaceId) {
      // 칸 하나를 최대화해 두면 작업 현황 칸이 가려져, 이미 열려 있으면 눌러도 아무 변화가 없었다(10-09 리규형님 "이미 나와 있더라도
      // 전체 화면이면 전체 화면을 풀고 원복") → 최대화부터 푼다. 칸 구조는 그대로라 아래 나누기·열기는 예전과 같다
      releaseMaximizedPane();
      const target = { serverId: here.serverId, workspaceId, pluginId: PLUGIN_ID, panelId: ACTIVITY_PANEL_ID };
      // 좁은 화면(폰 모양)은 칸 하나만 보여 주고 탭 전환도 그 칸 탭만 보여 줘서, 나누면 대화 탭이 사라진다(10-08 리규형님
      // "탭 전환에서 채팅 목록이 아예 안 나타남") → 나누지 않고 같은 칸의 탭으로 연다. 이미 나뉘어 있으면 합친다
      if (isCompactWidth()) mergeActivitySplit(target);
      else if (openActivitySplit({ ...target, percent: currentSettings().activitySplitPercent })) return;
    }
    client.openPanel(ACTIVITY_PANEL_ID, { workspaceId });
  };

  // 아는 작업 공간 — 여는 함수(openActivityFor, 폰 "작업 현황" 알약이 쓴다)는 늘 둔다. 머리줄 단추(사용량·작업 현황)는 폰 알약이
  // 없는 화면에서만 붙인다: 좁은 화면에선 Paseo 가 머리줄 단추를 세로 점 메뉴로 접어 두었고 폰 알약이 같은 일을 해서, 10-18 리규형님
  // "상단 세로 쩜쩜쩜 제거 — 더이상 필요하지 않으니". 화면 폭이 바뀌면 단추만 붙이고 뗀다
  const known = new Set<string>();
  const attachHeader = (workspaceId: string) => {
    if (disposed || registrations.has(workspaceId) || phonePillsShown()) return;
    try {
      leading?.add(workspaceId);
    } catch (error) {
      log(`leading header button ${workspaceId}: ${String(error)}`);
    }
    try {
      registrations.set(
        workspaceId,
        client.addHeaderButton({
          id: "activity",
          workspaceId,
          button: { ...presentation(null), icon: ActivityIcon, behavior: { kind: "action", onPress: () => openActivity(workspaceId) } },
        }),
      );
    } catch (error) {
      log(`header button ${workspaceId}: ${String(error)}`);
    }
  };
  const detachHeader = (workspaceId: string) => {
    leading?.drop(workspaceId);
    registrations.get(workspaceId)?.remove();
    registrations.delete(workspaceId);
    shown.delete(workspaceId);
  };
  const add = (workspaceId: string) => {
    if (disposed) return;
    if (!known.has(workspaceId)) {
      known.add(workspaceId);
      openers().set(workspaceId, () => openActivity(workspaceId));
    }
    attachHeader(workspaceId);
  };
  const drop = (workspaceId: string) => {
    if (known.delete(workspaceId)) openers().delete(workspaceId);
    detachHeader(workspaceId);
  };
  const stopWidth = watchCompactWidth(() => {
    for (const id of known) {
      if (phonePillsShown()) detachHeader(id);
      else attachHeader(id);
    }
  });

  type Page = { entries: { id: string }[]; pageInfo: { nextCursor: string | null; hasMore: boolean } };
  // 한 번에 오는 것은 첫 묶음(200개)뿐이라 다음 묶음까지 마저 읽어 맞춘다. 재연결 때 오는 새 목록에도 같은 방식으로
  // 있는 것은 붙이고 없어진 것은 뗀다(첫 목록과 그 뒤 변경만 듣던 것 — Codex 검토 10-05)
  let generation = 0;
  const reconcile = async (first: Page) => {
    const mine = ++generation;
    const ids = new Set(first.entries.map((w) => w.id));
    let page = first.pageInfo;
    while (page.hasMore && page.nextCursor && !disposed) {
      const next = await client.paseo.workspaces.list({ page: { limit: 200, cursor: page.nextCursor } });
      for (const w of next.entries) ids.add(w.id);
      page = next.pageInfo;
    }
    if (disposed || mine !== generation) return;
    for (const id of ids) add(id);
    for (const id of [...known]) if (!ids.has(id)) drop(id);
  };

  void (async () => {
    try {
      const list = await client.paseo.workspaces.list({ subscribe: {} });
      if (disposed) {
        void list.subscription.release();
        return;
      }
      await reconcile(list);
      const stopSnapshots = list.subscription.subscribe({
        snapshot: (snap) => void reconcile(snap).catch((error) => log(`workspace resync failed: ${String(error)}`)),
        update: () => {},
      });
      const stop = client.paseo.workspaces.subscribe((update) => {
        if (update.kind === "upsert") add(update.workspace.id);
        else if (update.kind === "remove") drop(update.id);
      });
      release = () => {
        stop();
        stopSnapshots();
        void list.subscription.release();
      };
      log(`header buttons on ${registrations.size}/${known.size} workspaces`);
    } catch (error) {
      log(`workspace subscribe failed: ${String(error)}`);
    }
  })();

  return () => {
    disposed = true;
    release?.();
    stopWidth();
    for (const id of [...known]) drop(id);
    leading?.dispose?.();
    clearMaximizedPane();
    paintedOpen = null;
    setStyleSheet(OPEN_STYLE_ID, null);
  };
}
