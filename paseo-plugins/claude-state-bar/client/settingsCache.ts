import { appBundleId, paseoModuleIds, type InternalsReason } from "./web";

// 다른 기기에서 받은 설정을 새로고침 없이 반영한다(리규형님 10-08 결정: "새로고침 없이 바로", 안 되는 판에서만 예전처럼 새로 읽기).
// Paseo 는 앱 설정·단축키 덮어쓰기를 화면 안 캐시(react-query)에 들고 있고, 처음 한 번 저장소에서 읽은 뒤로는 다시 읽지 않는다.
// 저장소에 새 값을 써 둔 뒤 그 캐시에 "저장소에서 다시 읽어라"만 시키면, Paseo 가 켤 때와 같은 읽기 함수로 값이 들어가
// 테마·글꼴(AppearanceProvider)·언어(I18nProvider)·단축키가 그 자리에서 바뀐다(0.11.0-beta.5 번들에서 확인한 구독 경로).
//  - 캐시 본체: queryClient 모듈(앱 루트 QueryClientProvider 에 넘기는 것) — 번호는 판마다 web.ts PASEO_BUNDLES(beta.5 848 · 0.11.1 850)
//  - 쿼리 열쇠: 앱 설정 ["app-settings"] · 단축키 ["keyboard-shortcut-overrides"] — 글자 열쇠라 판이 바뀌어도 그대로
// 모르는 판이면 손대지 않고 이유를 돌려준다(부르는 쪽이 새로 읽는다). 업데이트 점검표 20번.

const QUERY_KEYS: Record<string, readonly string[]> = {
  "@paseo:app-settings": ["app-settings"],
  "@paseo:keyboard-shortcut-overrides": ["keyboard-shortcut-overrides"],
};

type QueryClientLike = {
  refetchQueries(filters: { queryKey: readonly unknown[]; exact: boolean }): Promise<unknown>;
  getQueryState(queryKey: readonly unknown[]): { status?: string } | undefined;
};

function queryClient(): QueryClientLike | string {
  const id = paseoModuleIds()?.queryClient;
  if (id === undefined) return `app bundle ${appBundleId()?.slice(0, 12) ?? "unknown"} is not a known Paseo version`;
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return "no metro require";
  try {
    const qc = (require(id) as { queryClient?: Partial<QueryClientLike> } | null)?.queryClient;
    if (typeof qc?.refetchQueries !== "function" || typeof qc.getQueryState !== "function") return `no queryClient in module ${id}`;
    return qc as QueryClientLike;
  } catch (error) {
    return `module ${id} failed: ${String(error)}`;
  }
}

/** 상태 표시(10-08, client/health.ts) — 캐시 연결이 갖춰졌는지 읽기만 한다. null = 갖춰짐 */
export function probeSettingsCache(): InternalsReason | null {
  if (!appBundleId()) return "not-web";
  const id = paseoModuleIds()?.queryClient;
  if (id === undefined) return "unknown-bundle";
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return "no-require";
  try {
    const qc = (require(id) as { queryClient?: Partial<QueryClientLike> } | null)?.queryClient;
    return typeof qc?.refetchQueries === "function" && typeof qc.getQueryState === "function" ? null : "no-export";
  } catch {
    return "load-failed";
  }
}

/** 저장소에 이미 쓴 열쇠들을 Paseo 캐시에 다시 읽힌다. null = 반영함, 문자열 = 못 한 이유(부르는 쪽이 새로 읽는다).
 *  아직 Paseo 가 그 쿼리를 만들지 않았으면(시작 직후) 곧 저장소에서 새 값을 읽으므로 반영한 것으로 본다 */
export async function refreshSettingsCache(keys: readonly string[]): Promise<string | null> {
  const unknown = keys.filter((k) => !(k in QUERY_KEYS));
  if (unknown.length > 0) return `no cache key for ${unknown.join(",")}`;
  const qc = queryClient();
  if (typeof qc === "string") return qc;
  try {
    await Promise.all(keys.map((k) => qc.refetchQueries({ queryKey: QUERY_KEYS[k], exact: true })));
  } catch (error) {
    return `refetch failed: ${String(error)}`;
  }
  const failed = keys.filter((k) => qc.getQueryState(QUERY_KEYS[k])?.status === "error");
  return failed.length > 0 ? `refetch ended in error: ${failed.join(",")}` : null;
}
