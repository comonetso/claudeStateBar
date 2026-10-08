import { Platform } from "react-native";
import { readLocal } from "./web";

// 화면 언어 판정(리규형님 10-08 결정: 설정 화면 한글·영어는 따로 고르는 칸 없이 Paseo 언어 설정을 따라간다).
// 번역 기능도 이 함수로 번역 대상 언어를 정한다 — 그래서 한곳에 둔다.
//  - 웹·PC 앱: Paseo 앱 저장소 '@paseo:app-settings'(JSON)의 language. 기기 사이 설정 맞추기(settingsSync)가 이미 이 열쇠에
//    기대므로 새 의존이 아니다. 값이 "system"·없음·모르는 값이면 Paseo 와 같은 규칙으로 기기 언어(navigator.languages 순서)를 본다.
//  - 웹이 아니면(폰 공식 앱): 앱 저장소를 동기로 못 읽어 Intl 의 기기 언어 하나로 같은 규칙, 실패하면 한국어.
//  - 해석 결과가 ko 면 한국어, 그 밖의 언어는 모두 영어(플러그인 사전은 두 벌뿐).

// 이 플러그인은 DOM 타입 없이 검사한다 — 쓰는 것만 선언
declare const navigator: { languages?: readonly string[]; language?: string } | undefined;

const APP_SETTINGS_KEY = "@paseo:app-settings";

// ── 복사본: Paseo v0.11.1 packages/app/src/i18n/locales.ts (SupportedLocale 1행 · DEFAULT_LOCALE 9행 · SUPPORTED_LANGUAGES 24~35행 ·
//    REGIONAL_LANGUAGE_LOCALES 149~157행 · parseAppLanguage 159~163행 · resolveSupportedLocale 183~207행). 원본이 바뀌면 같이 고친다.
export type SupportedLocale = "ar" | "en" | "es" | "fr" | "ja" | "ko" | "pt-BR" | "ru" | "zh-CN";
type AppLanguage = "system" | SupportedLocale;

const DEFAULT_LOCALE: SupportedLocale = "en";

const SUPPORTED_LANGUAGES = new Set<AppLanguage>(["system", "ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"]);

const REGIONAL_LANGUAGE_LOCALES: Readonly<Record<string, SupportedLocale>> = {
  ar: "ar",
  en: "en",
  es: "es",
  fr: "fr",
  ja: "ja",
  ko: "ko",
  ru: "ru",
};

function parseAppLanguage(value: unknown): AppLanguage | null {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value as AppLanguage) ? (value as AppLanguage) : null;
}

export function resolveSupportedLocale(language: AppLanguage, systemLocales: readonly string[]): SupportedLocale {
  if (language !== "system") {
    return language;
  }

  for (const locale of systemLocales) {
    const normalized = locale.toLowerCase();
    const baseLanguage = normalized.split("-", 1)[0];
    const regionalLocale = REGIONAL_LANGUAGE_LOCALES[baseLanguage];
    if (regionalLocale) {
      return regionalLocale;
    }
    if (normalized === "pt" || normalized === "pt-br") {
      return "pt-BR";
    }
    if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
      return "zh-CN";
    }
  }

  return DEFAULT_LOCALE;
}
// ── 복사본 끝

/** Paseo 앱 언어 설정(웹·PC 앱만). 저장 안 됐거나 모르는 값이면 "system" — Paseo 저장 스키마의 language .catch("system") 과 같다
 *  (Paseo v0.11.1 packages/app/src/hooks/use-settings/storage.ts 216행) */
function appLanguageSetting(): AppLanguage {
  const raw = readLocal(APP_SETTINGS_KEY);
  if (!raw) return "system";
  try {
    const parsed = JSON.parse(raw) as { language?: unknown } | null;
    return parseAppLanguage(parsed?.language) ?? "system";
  } catch {
    return "system";
  }
}

function intlLocale(): string | null {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof locale === "string" && locale ? locale : null;
  } catch {
    return null;
  }
}

/** 웹의 기기 언어 목록 — Paseo i18n/provider.tsx getSystemLocales 와 같이 navigator.languages 순서. 비었으면
 *  navigator.language, 그것도 없으면 Intl(Paseo 는 이때 expo-localization 을 부른다 — 플러그인에는 없어 가장 가까운 것) */
function webSystemLocales(): string[] {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (nav?.languages && nav.languages.length > 0) return [...nav.languages];
  if (nav?.language) return [nav.language];
  const intl = intlLocale();
  return intl ? [intl] : [];
}

/** 지금 화면이 쓰는 Paseo 언어(아홉 가지 중 하나). 판정 중 오류가 나면 한국어 */
export function appLocale(): SupportedLocale {
  try {
    if (Platform.OS === "web") return resolveSupportedLocale(appLanguageSetting(), webSystemLocales());
    const intl = intlLocale();
    return intl ? resolveSupportedLocale("system", [intl]) : "ko";
  } catch {
    return "ko";
  }
}

/** 플러그인 화면 글자 언어 — Paseo 언어가 한국어면 "ko", 그 밖은 모두 "en" */
export function uiLanguage(): "ko" | "en" {
  return appLocale() === "ko" ? "ko" : "en";
}
