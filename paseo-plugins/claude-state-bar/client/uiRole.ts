import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { SoundSettings } from "../shared/settings";
import { offlineProjectsStatus } from "../shared/offlineProjects";
import type { Usage } from "./usageFooter";

export interface UiProvider {
  settings(): SoundSettings;
  usage(): Promise<Usage>;
  // 그 데몬의 사용량 기억을 건너뛰고 새로 받게 한다(10-17 — web.ts forceUsageRefresh)
  refreshUsage?(): Promise<boolean | null>;
  openSettings(): void;
}
export interface UiCandidate {
  kind: "pc" | "fallback";
  provider: UiProvider;
  start(): () => void;
}
type Candidate = UiCandidate & { stop?: () => void };
interface Hub {
  candidates: Set<Candidate>;
  selected?: Candidate;
  listeners: Set<() => void>;
  changing: boolean;
}
const KEY = "__claudeStateBar_uiRole_v1";
function hub(): Hub {
  const root = globalThis as unknown as Record<string, Hub | undefined>;
  return root[KEY] ??= { candidates: new Set(), listeners: new Set(), changing: false };
}
export function uiProvider(): UiProvider | undefined { return hub().selected?.provider; }
export function isOfflineFallback(): boolean { return hub().selected?.kind === "fallback"; }
export function onUiRole(listener: () => void): () => void {
  const h = hub(); h.listeners.add(listener); return () => h.listeners.delete(listener);
}
function choose(): void {
  const h = hub();
  if (h.changing) return;
  h.changing = true;
  try {
    for (;;) {
      const next = [...h.candidates].find(c => c.kind === "pc") ?? [...h.candidates].find(c => c.kind === "fallback");
      if (next === h.selected) break;
      const old = h.selected;
      h.selected = undefined;
      old?.stop?.(); old && (old.stop = undefined);
      // 이전 역할의 화면·단축키·받아쓰기 감싸기를 먼저 걷고, 다음 하나만 붙인다.
      h.selected = next;
      try { if (next) next.stop = next.start(); }
      catch (error) { if (next) h.candidates.delete(next); h.selected = undefined; console.warn("[claude-state-bar] UI role failed", error); }
      for (const listener of [...h.listeners]) { try { listener(); } catch { /* 다른 인스턴스는 계속 */ } }
    }
  } finally { h.changing = false; }
}
// Paseo 0.11.1 PluginCatalogSync는 offline에 removeHost -> cleanup을 부른다. 별도 PC 타임아웃을 만들지 않는다.
export function registerUiRole(input: UiCandidate): () => void {
  const candidate = { ...input };
  hub().candidates.add(candidate); choose();
  return () => { hub().candidates.delete(candidate); choose(); };
}
// 서버에 사본이 나중에 도착/교체되어도 표식을 다시 읽는다. PC 부재 판정용 폴링이 아니다.
// 실패 뒤 재요청은 기존 client/projectsData.ts WAIT_RETRY_MS와 같은 값이다.
const WAIT_RETRY_MS = 30_000;
export function startFallbackCandidate(client: PluginClientContext, candidate: UiCandidate): () => void {
  let stopped = false, withdraw: (() => void) | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let wakeRetry: (() => void) | undefined;
  void (async () => {
    let known: number | null | undefined;
    while (!stopped) {
      try {
        const status = await client.rpc(offlineProjectsStatus, known === undefined ? {} : { mtimeMs: known });
        if (stopped) return;
        known = status.mtimeMs;
        if (status.eligible && !withdraw) withdraw = registerUiRole(candidate);
        else if (!status.eligible && withdraw) { withdraw(); withdraw = undefined; }
      } catch {
        if (stopped) return;
        await new Promise<void>(resolve => { wakeRetry = resolve; retry = setTimeout(resolve, WAIT_RETRY_MS); });
        retry = undefined; wakeRetry = undefined;
      }
    }
  })();
  return () => { stopped = true; clearTimeout(retry); wakeRetry?.(); withdraw?.(); };
}
