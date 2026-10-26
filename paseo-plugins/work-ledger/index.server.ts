import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleConfirm, handleMemo, handleView } from "./server/ledger";
import { confirmItem, saveMemo, viewLedger } from "./shared/ledger";

export default function contribute(server: PluginServerContext) {
  server.handle(viewLedger, handleView);
  server.handle(confirmItem, handleConfirm);
  server.handle(saveMemo, handleMemo);
  return () => {};
}
