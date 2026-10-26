import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

// 작업 공간마다 머리줄 "작업 장부" 단추 — 누르면 그 작업 공간에 장부 탭을 연다(10-26 리규형님: index.html 을 매번 열지 않게, PC·폰 같은 자리).
// Paseo 는 머리줄 플러그인 단추를 앞에서부터 셋(폭 1100 미만·폰은 하나)만 보이고 나머지를 ⋯ 로 접는다 —
// 그래서 상태바 플러그인의 "대표 배치 가져오기"를 설정 화면으로 옮겨 자리를 냈다. 폰에서는 이 단추 하나만 보인다.
// 작업 공간 목록 구독은 상태바 activityButton.tsx 와 같은 방식(첫 묶음 뒤 다음 묶음까지 · 재연결 새 목록 맞추기).

export const LEDGER_PANEL_ID = "ledger";

type Page = { entries: { id: string }[]; pageInfo: { nextCursor: string | null; hasMore: boolean } };

export type LedgerHeader = { dispose: () => void; has: (workspaceId: string) => boolean };

export function createLedgerHeaderButtons(client: PluginClientContext, log: (s: string) => void): LedgerHeader {
  const registrations = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let release: (() => void) | null = null;

  const add = (workspaceId: string) => {
    if (disposed || registrations.has(workspaceId)) return;
    try {
      registrations.set(
        workspaceId,
        client.addHeaderButton({
          id: "work-ledger",
          workspaceId,
          button: {
            title: "작업 장부",
            icon: "BookOpen",
            behavior: { kind: "action", onPress: () => client.openPanel(LEDGER_PANEL_ID, { workspaceId }) },
          },
        }),
      );
    } catch (error) {
      log(`header button ${workspaceId}: ${String(error)}`);
    }
  };
  const drop = (workspaceId: string) => {
    registrations.get(workspaceId)?.remove();
    registrations.delete(workspaceId);
  };

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
      // 다음 쪽을 기다리는 동안 꺼졌으면 여기서 구독을 돌려준다 — 이 뒤 구독은 dispose 가 못 거둔다(10-26 Codex 리뷰)
      if (disposed) {
        void list.subscription.release();
        return;
      }
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
    } catch (error) {
      log(`workspace subscribe failed: ${String(error)}`);
    }
  })();

  return {
    has: (workspaceId) => registrations.has(workspaceId),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        release?.();
      } catch (error) {
        log(`cleanup failed: ${String(error)}`);
      }
      for (const id of [...registrations.keys()]) drop(id);
    },
  };
}
