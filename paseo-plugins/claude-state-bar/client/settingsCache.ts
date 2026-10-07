import { appBundleId } from "./web";

// 다른 기기에서 받은 설정을 새로고침 없이 반영한다(리규형님 10-08 결정: "새로고침 없이 바로", 안 되는 판에서만 예전처럼 새로 읽기).
// Paseo 는 앱 설정·단축키 덮어쓰기를 화면 안 캐시(react-query)에 들고 있고, 처음 한 번 저장소에서 읽은 뒤로는 다시 읽지 않는다.
// 저장소에 새 값을 써 둔 뒤 그 캐시에 "저장소에서 다시 읽어라"만 시키면, Paseo 가 켤 때와 같은 읽기 함수로 값이 들어가
// 테마·글꼴(AppearanceProvider)·언어(I18nProvider)·단축키가 그 자리에서 바뀐다(0.11.0-beta.5 번들에서 확인한 구독 경로).
//  - 캐시 본체: Metro 848 번 모듈의 queryClient(앱 루트 QueryClientProvider 에 넘기는 것)
//  - 쿼리 열쇠: 앱 설정 ["app-settings"](모듈 3125 APP_SETTINGS_QUERY_KEY) · 단축키 ["keyboard-shortcut-overrides"](모듈 4028)
// 모듈 번호는 이 번들에서만 맞다 — 지문이 다르면 손대지 않고 이유를 돌려준다(부르는 쪽이 새로 읽는다). web.ts 의 작업 공간
// 연결과 같은 번들 지문이다(업데이트 점검표 20번).

const CACHE_BUNDLE = "f07439c15f40c0ca1689fb49e3dcc6c8";
const QUERY_CLIENT_MODULE = 848;
const QUERY_KEYS: Record<string, readonly string[]> = {
  "@paseo:app-settings": ["app-settings"],
  "@paseo:keyboard-shortcut-overrides": ["keyboard-shortcut-overrides"],
};

type QueryClientLike = {
  refetchQueries(filters: { queryKey: readonly unknown[]; exact: boolean }): Promise<unknown>;
  getQueryState(queryKey: readonly unknown[]): { status?: string } | undefined;
};

function queryClient(): QueryClientLike | string {
  if (appBundleId() !== CACHE_BUNDLE) return `app bundle ${appBundleId()?.slice(0, 12) ?? "unknown"} is not ${CACHE_BUNDLE.slice(0, 12)}`;
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return "no metro require";
  try {
    const qc = (require(QUERY_CLIENT_MODULE) as { queryClient?: Partial<QueryClientLike> } | null)?.queryClient;
    if (typeof qc?.refetchQueries !== "function" || typeof qc.getQueryState !== "function") return "no queryClient in module 848";
    return qc as QueryClientLike;
  } catch (error) {
    return `module 848 failed: ${String(error)}`;
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
