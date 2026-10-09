import { Platform } from "react-native";
import type { Lang, TranslationCache } from "./thinkingPlayer";

// 생각 상자 플러그인 번역을 이 기기 브라우저에 7일 담아 둔다(10-10 리규형님 "번역된 것은 다시 번역해서 비용이 나가지 않게" ·
// 결정 "이 기기에 7일 저장"). 새로고침·다른 탭·번역을 껐다 켜도 같은 문단은 번역을 다시 보내지 않는다.
// 앱 저장소(localStorage)는 Paseo 설정도 같이 쓰고 5MB 남짓이라 번역이 쌓이면 Paseo 저장을 막을 수 있어 IndexedDB 에 둔다
// (기기 사이 설정 맞추기는 앱 저장소만 옮겨서 이 보관은 다른 기기로 가지 않는다). 키 = 언어 + 원문 문단 그대로(같은 글만 맞는다).
// 7일은 담은 때부터 — 지난 것은 쓰지 않고, 페이지를 처음 열 때 한 번 지운다. 웹·PC 앱만(폰 앱은 담지 않는다 — 지금처럼)

const DB_NAME = "claude-state-bar";
const STORE = "thinking-translations";
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// This plugin typechecks without the DOM library. Declare only what this module uses.
type Entry = { t: string; at: number };
type IdbRequest<T> = { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null };
type IdbCursor = { value: Entry | undefined; delete(): unknown; continue(): void };
type IdbStore = {
  get(key: string): IdbRequest<Entry | undefined>;
  put(value: Entry, key: string): unknown;
  openCursor(): IdbRequest<IdbCursor | null>;
};
type IdbTransaction = { objectStore(name: string): IdbStore; oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null };
type IdbDatabase = {
  transaction(store: string, mode: "readonly" | "readwrite"): IdbTransaction;
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
};
type IdbOpen = IdbRequest<IdbDatabase> & { onupgradeneeded: (() => void) | null; onblocked: (() => void) | null };
declare const indexedDB: { open(name: string, version: number): IdbOpen } | undefined;

let opened: Promise<IdbDatabase | null> | null = null;

function database(): Promise<IdbDatabase | null> {
  if (Platform.OS !== "web" || typeof indexedDB === "undefined" || !indexedDB) return Promise.resolve(null);
  const idb = indexedDB;
  opened ??= new Promise<IdbDatabase | null>((resolve) => {
    try {
      const request = idb.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        resolve(request.result);
        prune(request.result);
      };
      // 못 열면 담지 않는다 — 번역은 지금처럼 보낸다
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

const keyOf = (lang: Lang, text: string) => `${lang}\n${text}`;
const fresh = (entry: Entry | undefined, now: number): entry is Entry =>
  !!entry && typeof entry.t === "string" && typeof entry.at === "number" && now - entry.at < KEEP_MS;

/** 7일 지난 번역을 지운다(페이지마다 처음 열 때 한 번) */
function prune(db: IdbDatabase): void {
  try {
    const now = Date.now();
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!fresh(cursor.value, now)) cursor.delete();
      cursor.continue();
    };
  } catch {
    /* 못 지워도 지난 번역은 쓰지 않는다 */
  }
}

export const translationCache: TranslationCache = {
  async lookup(lang, texts) {
    const found = new Map<string, string>();
    const db = await database();
    if (!db || !texts.length) return found;
    const now = Date.now();
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        for (const text of texts) {
          const request = store.get(keyOf(lang, text));
          request.onsuccess = () => {
            const entry = request.result;
            if (fresh(entry, now)) found.set(text, entry.t);
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    return found;
  },
  store(lang, entries) {
    if (!entries.length) return;
    void database().then((db) => {
      if (!db) return;
      try {
        const store = db.transaction(STORE, "readwrite").objectStore(STORE);
        const at = Date.now();
        for (const [text, translation] of entries) store.put({ t: translation, at }, keyOf(lang, text));
      } catch {
        /* 못 담아도 이번 상자에는 번역이 있다 */
      }
    });
  },
};
