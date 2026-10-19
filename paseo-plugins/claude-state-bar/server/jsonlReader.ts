import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

// 첫 판독도 줄 단위로 끝까지 훑는다. 앞의 생성 시각·실행/완료 짝·오늘 통계를 버리면 판정이 달라진다.
// 이후에는 덧붙인 바이트만 읽는다. 원문 대신 판독 상태와 미완성 한 줄만 보관한다.
export interface LineReducer<S, T> { create(): S; add(state: S, line: string): void; value(state: S): T }
type Index<S> = { size: number; mtimeMs: number; identity: string; state: S; rest: string; decoder: StringDecoder; skipping: boolean };
const CHUNK = 4 * 1024 * 1024;
// thinkingBoundary와 같은 32MiB 보호선. 이보다 큰 단일 줄은 끝까지 건너뛰어 다음 줄부터 계속한다.
const MAX_LINE = 32 * 1024 * 1024;

export function createJsonlReader<S, T>(reducer: LineReducer<S, T>): (file: string) => Promise<T> {
  const indexes = new Map<string, Index<S>>();
  const loading = new Map<string, Promise<T>>();
  const load = async (file: string): Promise<T> => {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      const identity = [info.dev, info.ino, info.birthtimeMs].join(":");
      let ix = indexes.get(file);
      if (!ix || ix.identity !== identity || info.size < ix.size || (info.size === ix.size && info.mtimeMs !== ix.mtimeMs)) {
        ix = { size: 0, mtimeMs: info.mtimeMs, identity, state: reducer.create(), rest: "", decoder: new StringDecoder("utf8"), skipping: false };
        indexes.set(file, ix);
      }
      while (ix.size < info.size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, info.size - ix.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, ix.size);
        if (!bytesRead) throw new Error("대화 기록이 판독 중 줄어듦");
        ix.size += bytesRead;
        const text = ix.decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        for (;;) {
          const end = text.indexOf("\n", start);
          const part = text.slice(start, end < 0 ? text.length : end);
          if (!ix.skipping) {
            if (ix.rest.length + part.length > MAX_LINE) { ix.rest = ""; ix.skipping = true; }
            else ix.rest += part;
          }
          if (end < 0) break;
          if (!ix.skipping) reducer.add(ix.state, ix.rest);
          ix.rest = ""; ix.skipping = false; start = end + 1;
        }
        // 큰 최초 판독도 RPC·훅·타이머에 실행 기회를 준다.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      ix.mtimeMs = info.mtimeMs;
      // 줄바꿈 없는 완전한 마지막 JSON도 옛 판독처럼 보인다. 확정 상태에는 넣지 않아 다음 덧붙임 때 중복되지 않는다.
      const snapshot = structuredClone(ix.state);
      if (!ix.skipping && ix.rest) reducer.add(snapshot, ix.rest);
      return reducer.value(snapshot);
    } catch (error) {
      indexes.delete(file);
      throw error;
    } finally { await handle.close(); }
  };
  return file => {
    const next = (loading.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => load(file));
    loading.set(file, next);
    void next.finally(() => { if (loading.get(file) === next) loading.delete(file); }).catch(() => {});
    return next;
  };
}

/** 파일 전체를 문자열로 만들지 않는 출력 끝 판독. 시작이 UTF-8 문자 중간이면 그 문자 조각만 뺀다. */
export async function readTextTail(file: string, limit = 64 * 1024): Promise<{ text: string; clipped: boolean; mtimeMs: number }> {
  const handle = await open(file, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, start + used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    let first = 0;
    if (start) while (first < used && (buffer[first] & 0xc0) === 0x80) first++;
    return { text: buffer.subarray(first, used).toString("utf8"), clipped: start > 0, mtimeMs };
  } finally { await handle.close(); }
}
