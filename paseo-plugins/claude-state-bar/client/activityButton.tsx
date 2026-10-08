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
import { clearMaximizedPane, paintMaximizedPane } from "./paneMaximized";
import { currentSettings } from "./sounds";
import { currentWorkspaceFromUrl, isCompactWidth } from "./web";

/** paseo-plugin.json 의 id — Paseo 가 패널 탭에 이 이름을 붙인다 */
const PLUGIN_ID = "claude-state-bar";
import { RUNNING_COLOR } from "./format";
import type { HeaderButtonSet } from "./usageButton";
import { latestCounts, requestTab, totalOf, useCounts } from "./useCounts";

// 작업 공간 머리줄 단추 "작업 현황"(리규형님 10-05 결정: 돌고 있는 것 수는 머리줄 단추로).
// 확장은 세션 메뉴에 "작업 현황 — 워크플로우 2 · 백그라운드 1 진행 중"을 보인다. 단추 글자 칸이 좁아 합계만 두고,
// 누르면 작업 현황 패널을 연다(돌고 있는 갈래가 있으면 그 탭).

/** 확장 세션 메뉴 문구(menu.activityRunning · menu.noneRunning · menu.checking) */
function summaryOf(c: ActivityCounts | null): string {
  if (!c) return "확인 중…";
  const parts = KINDS.filter((k) => c[k.key] > 0).map((k) => `${k.part} ${c[k.key]}`);
  return parts.length ? `${parts.join(" · ")} 진행 중` : "진행 중 없음";
}

/** 단추 글자: 돌고 있으면 합계, 아니면 이름만(글자 칸이 160px 라 종류별로는 못 넣는다) */
function presentation(c: ActivityCounts | null): Pick<PluginButton, "label" | "title"> {
  const n = c ? totalOf(c) : 0;
  return { label: n > 0 ? `진행 중 ${n}` : "작업 현황", title: `작업 현황 — ${summaryOf(c)}` };
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

  const present = (workspaceId: string, counts: ActivityCounts | null) => {
    const next = presentation(counts);
    const key = `${next.label}\n${next.title}`;
    if (shown.get(workspaceId) === key) return;
    shown.set(workspaceId, key);
    registrations.get(workspaceId)?.update(next);
  };

  function ActivityIcon({ workspaceId, size, color, theme }: PluginButtonIconProps) {
    const counts = useCounts(workspaceId);
    const running = counts ? totalOf(counts) > 0 : false;
    useEffect(() => present(workspaceId, counts), [workspaceId, counts]);
    // 칸 최대화 단추 주황(10-08) — 테마는 화면 부품만 받아서, 작업 공간 화면에 늘 있는 이 단추가 테마가 바뀔 때마다 칠한다
    useEffect(() => paintMaximizedPane(theme), [theme]);
    return <Icon name={running ? "LoaderCircle" : "Activity"} size={size} color={running ? RUNNING_COLOR : color} />;
  }

  // 누르면 작업 현황 패널을 바로 연다(작은 창은 두 번 떠 보였다 — 리규형님 10-05). 돌고 있는 갈래가 있으면 그 탭으로.
  // 웹·데스크톱에서 칸이 하나뿐이면 새로고침 없이 왼쪽에 작업 현황 칸을 만든다(activitySplit).
  const openActivity = (workspaceId: string) => {
    const c = latestCounts(workspaceId);
    const running = c ? KINDS.find((k) => c[k.key] > 0) : undefined;
    if (running) requestTab(workspaceId, running.key);
    const here = currentWorkspaceFromUrl();
    if (here?.workspaceId === workspaceId) {
      const target = { serverId: here.serverId, workspaceId, pluginId: PLUGIN_ID, panelId: ACTIVITY_PANEL_ID };
      // 좁은 화면(폰 모양)은 칸 하나만 보여 주고 탭 전환도 그 칸 탭만 보여 줘서, 나누면 대화 탭이 사라진다(10-08 리규형님
      // "탭 전환에서 채팅 목록이 아예 안 나타남") → 나누지 않고 같은 칸의 탭으로 연다. 이미 나뉘어 있으면 합친다
      if (isCompactWidth()) mergeActivitySplit(target);
      else if (openActivitySplit({ ...target, percent: currentSettings().activitySplitPercent })) return;
    }
    client.openPanel(ACTIVITY_PANEL_ID, { workspaceId });
  };

  const add = (workspaceId: string) => {
    if (disposed || registrations.has(workspaceId)) return;
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
  const drop = (workspaceId: string) => {
    leading?.drop(workspaceId);
    registrations.get(workspaceId)?.remove();
    registrations.delete(workspaceId);
    shown.delete(workspaceId);
  };

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
    for (const id of [...registrations.keys()]) if (!ids.has(id)) drop(id);
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
      log(`header buttons on ${registrations.size} workspaces`);
    } catch (error) {
      log(`workspace subscribe failed: ${String(error)}`);
    }
  })();

  return () => {
    disposed = true;
    release?.();
    for (const id of [...registrations.keys()]) drop(id);
    leading?.dispose?.();
    clearMaximizedPane();
  };
}
