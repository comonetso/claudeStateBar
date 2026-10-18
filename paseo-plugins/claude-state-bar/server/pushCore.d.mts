// pushCore.mjs 의 타입(TS 쪽 push.ts·soundEvents 연결이 쓴다). 동작은 pushCore.mjs 가 정본이다.
export declare const PUSH_ROUTE_FILE: string;
export declare const FCM_KEY_FILE: string;
export declare const PUSH_TOKENS_FILE: string;
export declare const PHONE_ACK_WAIT_MS: number;
export declare const RAISE_TIMEOUT_MS: number;
export declare const COMMIT_TIMEOUT_MS: number;
export declare const PC_WAIT_CAP_MS: number;
export declare const WAIT_POLL_MS: number;

export type CentralRoute = { url: string; originId: string; secret: string };
export type PushRoute = { mode: "legacy" | "central" | "off"; central: CentralRoute | null; error: string | null };
export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export declare function within(ms: number): AbortSignal;
export declare function readPushRoute(dir: string): Promise<PushRoute>;

export type LegacyResult = {
  sent: number;
  total: number;
  skipped: string | null;
  gone: string[];
  results: { token: string; ok: boolean; status: number; code: string; error: string | null }[];
};
export declare function createLegacyFcm(options: { keyFile: string; fetchImpl?: FetchLike }): {
  readKey(): Promise<object | null>;
  send(message: Record<string, string>, tokens: string[]): Promise<LegacyResult>;
};

export type CentralData = { serverId: string; workspaceId: string; agentId: string; title: string; body: string; path: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CentralReply = { ok: boolean; status: number; json: any };
export type CentralClient = {
  originId: string;
  hello(): Promise<CentralReply>;
  raise(eventId: string, kind: "question" | "compact", fallback: "origin" | "none", data: CentralData, revision?: number): Promise<CentralReply>;
  wait(eventId: string, waitMs: number, stop?: AbortSignal): Promise<CentralReply>;
  commit(eventId: string, decision: "phone" | "pc", deliveryId?: string): Promise<CentralReply>;
  resolve(eventId: string, revision?: number): Promise<CentralReply>;
};
export declare function createCentralClient(route: CentralRoute, options?: { fetchImpl?: FetchLike }): CentralClient;
export declare function createEventSerial(): <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** soundEvents.ts createPushDisposition 이 채우는 모양 */
export type DispositionLike = {
  decidePc(key: string, reason: string): Promise<"phone" | "pc">;
  commitPhone(key: string, deliveryId: string): Promise<{ committed: boolean; state: string }>;
  voidPhone(key: string, deliveryId: string, reason: string): Promise<boolean>;
  finish(key: string): Promise<unknown>;
};
export declare function deliverCentral(options: {
  client: CentralClient;
  disposition: DispositionLike;
  eventId: string;
  kind: "question" | "compact";
  data: CentralData;
  order?: <T>(fn: () => Promise<T>) => Promise<T>;
  windowMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<{ outcome: "phone" | "phone_unconfirmed" | "pc" | "resolved"; reason: string | null }>;
