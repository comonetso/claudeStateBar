import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 프로젝트 목록(리규형님 10-05: VS Code 프로젝트 매니저 묶음 그대로 → 10-07: 목록을 플러그인 데이터 폴더로 옮겨 정본으로,
// tags → category). 데몬(PC)이 server/projects 로 읽어 준다.
const entrySchema = z.object({
  name: z.string(),
  /** 묶음 이름 — 옛 tags 의 하나뿐이던 값("8. 확장프로그램"). 없으면 "" */
  category: z.string(),
  enabled: z.boolean(),
  /** "PC"(이 데몬의 기계) 또는 Remote-SSH 호스트 별칭(~/.ssh/config Host) */
  host: z.string(),
  path: z.string(),
  /** PC 경로인데 폴더가 없다 */
  missing: z.boolean().optional(),
});
export type ProjectEntry = z.infer<typeof entrySchema>;

// 맨 위 고정(10-06) — 키는 "<host>|<path>". 데몬(PC)의 플러그인 전용 파일에 둔다(server/projectsPins)
export const projectsPins = defineRpc({
  name: "projects.pins",
  input: z.object({}),
  output: z.object({ keys: z.array(z.string()) }),
});

export const projectsPinSet = defineRpc({
  name: "projects.pin-set",
  input: z.object({ key: z.string(), pinned: z.boolean() }),
  output: z.object({ keys: z.array(z.string()) }),
});

// 고정 묶음 순서 바꾸기(10-06, PC·웹에서 마우스 드래그) — keys 의 순서가 화면 순서
export const projectsPinOrder = defineRpc({
  name: "projects.pin-order",
  input: z.object({ keys: z.array(z.string()) }),
  output: z.object({ keys: z.array(z.string()) }),
});

// 묶음 안 순서(10-07 리규형님 결정 — 활성 묶음과 태그 묶음도 끌어서 순서를 바꾼다). 묶음 이름 → 키 순서.
// 끌어 놓은 적 없는 프로젝트는 여기 없고, 화면은 그것들을 이름순으로 뒤에 붙인다(server/projectsOrder)
export const ACTIVE_ORDER_KEY = ":active";
/** 카테고리 묶음끼리의 순서(10-07 리규형님: 카테고리도 끌어 옮긴다) — 값은 카테고리 이름 */
export const CATEGORY_ORDER_KEY = ":categories";
const groupOrders = z.object({ groups: z.record(z.string(), z.array(z.string())) });

export const projectsOrder = defineRpc({
  name: "projects.order",
  input: z.object({}),
  output: groupOrders,
});

export const projectsOrderSet = defineRpc({
  name: "projects.order-set",
  input: z.object({ group: z.string(), keys: z.array(z.string()) }),
  output: groupOrders,
});

// 순서·고정 모두 처음으로(10-07 리규형님: 초기화하면 목록 파일 순서, 고정도 모두 풀림 — 설정 화면 버튼)
export const projectsResetOrder = defineRpc({
  name: "projects.reset-order",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// 목록 파일이 바뀔 때까지 기다린다(10-07 — Paseo 편집기에서 저장하면 왼쪽 목록이 바로 다시 읽게). 지금 아는 수정 시각을 보낸다
export const projectsWait = defineRpc({
  name: "projects.wait",
  input: z.object({ mtimeMs: z.number().nullable() }),
  output: z.object({ mtimeMs: z.number().nullable() }),
});

export const projectsManager = defineRpc({
  name: "projects.manager",
  input: z.object({}),
  output: z.object({
    /** 읽은 목록 파일 경로. 못 찾았으면 null */
    source: z.string().nullable(),
    entries: z.array(entrySchema),
    error: z.string().optional(),
  }),
});
