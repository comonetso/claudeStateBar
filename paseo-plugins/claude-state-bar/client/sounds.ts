import type { LayoutSnapshot } from "../shared/layoutSync";
import { DEFAULT_SETTINGS, type SoundSettings } from "../shared/settings";
import type { SoundKind } from "../shared/sound";
import type { Usage } from "./usageFooter";

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
  // 이 PC 데몬의 Claude·Codex 사용량(10-06). 다른 호스트 작업 공간의 사용량 단추도 같은 숫자를 보이게 이것을 쓴다.
  // 옛 판 공급자에는 없을 수 있다
  usage?(): Promise<Usage>;
  // 이 PC 플러그인이 등록한 설정 화면(Claude State Bar)을 연다(10-07 머리줄 톱니). 옛 판 공급자에는 없을 수 있다
  openSettings?(): void;
  // PC 앱이 맡겨 둔 작업 공간 순서·화면 구성(10-07 머리줄 동기화 단추). 서버 작업 공간 단추도 이 PC 데몬 것을 읽게 공급자를 거친다.
  // 옛 판 공급자에는 없을 수 있다
  loadLayout?(slot: string): Promise<LayoutSnapshot>;
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
