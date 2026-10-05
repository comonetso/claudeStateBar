import { DEFAULT_SETTINGS, type SoundSettings } from "../shared/settings";
import type { SoundKind } from "../shared/sound";

// 앱은 호스트마다 이 플러그인을 따로 띄우지만 실행 공간(globalThis)은 하나다.
// 서버 데몬에는 소리 파일이 없으므로, 소리를 낼 수 있는 호스트(이 PC 데몬)의 플러그인이
// 공급자로 등록하고 모든 호스트의 플러그인이 그 공급자의 소리와 설정을 쓴다.
// 공급자는 먼저 등록한 하나다. 데스크톱 앱은 자기 PC 데몬에 먼저 붙는다.
export interface SoundProvider {
  readonly hostLabel: string;
  sound(kind: SoundKind): Promise<string>;
  // 마지막으로 읽은 설정. 판정기가 동기로 쓴다.
  settings(): SoundSettings;
  refreshSettings(): Promise<void>;
}

interface Shared {
  provider?: SoundProvider;
}

const SHARED_KEY = "__claudeStateBar_v2";

function shared(): Shared {
  const root = globalThis as unknown as Record<string, Shared | undefined>;
  let value = root[SHARED_KEY];
  if (!value) {
    value = {};
    root[SHARED_KEY] = value;
  }
  return value;
}

export function soundProvider(): SoundProvider | undefined {
  return shared().provider;
}

/** 공급자로 등록한다. 이미 있으면 false. 돌려받은 함수로 물러난다. */
export function registerProvider(provider: SoundProvider): (() => void) | undefined {
  const s = shared();
  if (s.provider) return undefined;
  s.provider = provider;
  return () => {
    if (s.provider === provider) s.provider = undefined;
  };
}

export function currentSettings(): SoundSettings {
  return shared().provider?.settings() ?? DEFAULT_SETTINGS;
}
