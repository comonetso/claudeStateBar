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
/** 카테고리가 빈 프로젝트의 묶음 이름 — 화면 묶음 이름이자 순서 파일의 묶음 열쇠(관리 화면이 옮길 때 데몬도 쓴다) */
export const UNTAGGED_GROUP = "카테고리 없음";
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

// 프로젝트 관리 화면(10-10 리규형님: "사용자들이 json 을 건드는 건 좀 그래서" — 목록 파일 직접 편집 대신 화면에서 고친다).
// key 는 고정·순서와 같은 "<기기>|<경로>". 실제 폴더는 건드리지 않고 목록 파일만 고친다
const editOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), key: z.string(), name: z.string() }),
  /** 다른 카테고리로 — 그 묶음 맨 아래로 간다(10-10 결정). "" = 카테고리 없음 */
  z.object({ op: z.literal("category"), key: z.string(), category: z.string() }),
  z.object({ op: z.literal("enabled"), key: z.string(), enabled: z.boolean() }),
  z.object({ op: z.literal("remove"), key: z.string() }),
  /** host = "PC" 또는 ~/.ssh/config 의 Host 별칭. name 이 비면 폴더 이름 */
  z.object({ op: z.literal("add"), host: z.string(), path: z.string(), name: z.string(), category: z.string() }),
  z.object({ op: z.literal("renameCategory"), from: z.string(), to: z.string() }),
  /** 카테고리만 지운다 — 안의 프로젝트는 "카테고리 없음"으로(10-10 결정) */
  z.object({ op: z.literal("deleteCategory"), name: z.string() }),
]);
export type ProjectsEditOp = z.infer<typeof editOp>;

export const projectsEdit = defineRpc({
  name: "projects.edit",
  input: editOp,
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

// 새 프로젝트를 둘 기기 — "PC" + ~/.ssh/config 의 Host 별칭(와일드카드 줄은 뺀다, 10-10 결정)
export const projectsHosts = defineRpc({
  name: "projects.hosts",
  input: z.object({}),
  output: z.object({ hosts: z.array(z.string()) }),
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
