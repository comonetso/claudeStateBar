import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// PC 에서 가져오기(리규형님 10-07 결정). PC 앱은 작업 공간 순서·화면 구성이 바뀔 때마다 이 PC 데몬에 저장해 두고,
// 웹·폰에서 단추를 누르면 그 저장본을 가져와 덮어쓴다. 설정은 실시간 맞추기(settingsSync)가 맡아 여기서 뺐고, 서버 3대
// 열쇠는 로그인 서버에 잠가 두므로 여기 없다. 칸은 화면 판(화면 코드 파일 지문)마다 따로 — 판이 다르면 저장 모양이 다를 수 있다.

export type LayoutItemId = "order" | "layout";

/** 가져오는 저장 열쇠(앱 0.11.0-beta.5 zustand persist 이름). 열쇠 안의 작업 공간 이름표에 서버 번호가 들어 있어 같은 서버면 그대로 맞는다 */
export const LAYOUT_ITEMS: readonly { id: LayoutItemId; key: string; title: string }[] = [
  { id: "order", key: "sidebar-project-workspace-order", title: "작업 공간 순서" },
  { id: "layout", key: "workspace-layout-state", title: "화면 구성" },
];

export function isLayoutKey(key: string): boolean {
  return LAYOUT_ITEMS.some((item) => item.key === key);
}

// 대표 PC 웹(10-08 리규형님 결정: PC 앱은 평소 안 켜고 필요할 때만 → 화면 구성 저장·새 판 설정 칸 만들기를 설정 화면 버튼으로
// 지정한 브라우저 하나가 맡는다). 대표가 없으면 예전처럼 PC 앱이 맡는다. 대표가 있으면 다른 화면(PC 앱 포함)의 저장은 데몬이 거절한다.
// screen = 브라우저마다 만들어 그 브라우저 저장소에 둔 무작위 번호(client/screenRole.ts)
const owner = z.object({ id: z.string(), label: z.string(), at: z.number() }).nullable();
export type LayoutOwner = z.output<typeof owner>;

/** 기준 화면(대표가 없으면 PC 앱)이 바뀐 값을 맡긴다. 대표가 따로 있는데 다른 화면이 보내면 refused 와 지금 대표를 돌려준다 */
export const layoutSave = defineRpc({
  name: "layout-sync.save",
  input: z.object({ slot: z.string(), key: z.string(), value: z.string(), screen: z.string().optional() }),
  output: z.object({ at: z.number(), refused: z.boolean().optional(), owner: owner.optional() }),
});

/** 지금 대표 화면(없으면 null) */
export const layoutOwnerGet = defineRpc({
  name: "layout-sync.owner",
  input: z.object({}),
  output: z.object({ owner }),
});

/** 대표 화면을 정한다. screen=null 이면 대표를 풀어 PC 앱이 다시 맡는다 */
export const layoutOwnerSet = defineRpc({
  name: "layout-sync.set-owner",
  input: z.object({ screen: z.string().nullable(), label: z.string() }),
  output: z.object({ owner }),
});

const snapshot = z.object({
  keys: z.record(z.string(), z.object({ v: z.string(), at: z.number() })).nullable(),
  slots: z.array(z.object({ slot: z.string(), at: z.number() })),
});
export type LayoutSnapshot = z.output<typeof snapshot>;

/** 웹·폰이 저장본을 받는다. keys 는 이 판 칸(없으면 null), slots 는 모든 판 칸과 마지막 저장 시각 */
export const layoutLoad = defineRpc({
  name: "layout-sync.load",
  input: z.object({ slot: z.string() }),
  output: snapshot,
});
