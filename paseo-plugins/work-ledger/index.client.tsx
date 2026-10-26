import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createLedgerHeaderButtons, LEDGER_PANEL_ID } from "./client/headerButtons";
import { LedgerPanel } from "./client/ledgerPanel";
import { startHeaderPlacement } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const log = (s: string) => console.log(`[work-ledger] ${s}`);
  const removePanel = client.addWorkspacePanel({
    id: LEDGER_PANEL_ID,
    title: "작업 장부",
    icon: "BookOpen",
    context: "workspace",
    Component: LedgerPanel,
  });
  const header = createLedgerHeaderButtons(client, log);
  // 폰 모양 머리줄 끼워 넣기·넓은 화면 맨 왼쪽(web.ts) — 이 호스트 작업 공간만
  const stopPlacement = startHeaderPlacement(header.has, (workspaceId) => client.openPanel(LEDGER_PANEL_ID, { workspaceId }));
  return () => {
    stopPlacement();
    header.dispose();
    removePanel();
  };
}
