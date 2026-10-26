import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { mutableSoundKinds, mutableSoundNames, type MutableSoundKind } from "./projectSound";

// 프로젝트 목록(리규형님 10-05: VS Code 프로젝트 매니저 묶음 그대로 → 10-07: 목록을 플러그인 데이터 폴더로 옮겨 정본으로,
// tags → category). 데몬(PC)이 server/projects 로 읽어 준다.
export const projectEntrySchema = z.object({
  name: z.string(),
  /** 묶음 이름 — 옛 tags 의 하나뿐이던 값. 없으면 "". 번호는 이름에 넣지 않고 화면이 순서대로 붙인다(10-11) */
  category: z.string(),
  enabled: z.boolean(),
  /** "PC"(이 데몬의 기계) 또는 Remote-SSH 호스트 별칭(~/.ssh/config Host) */
  host: z.string(),
  path: z.string(),
  /** PC 경로인데 폴더가 없다 */
  missing: z.boolean().optional(),
  /** 이 항목을 연 데몬 — 직원 화면이 직원 데몬 여럿의 목록을 합칠 때만 붙인다(10-20 client/staffProjects). 서버는 보내지 않는다 */
  serverId: z.string().optional(),
  /**
   * 하위 공간이면 그 메인의 경로(같은 기기) — 같은 경로로 또 추가해 만든 워크트리 항목(10-24). 왼쪽 목록이 메인 아래에 묶어 접고 편다
   * (10-24 리규형님 "하위 스페이스는 메인에 얽매인 거잖아 — 접을 수 있게, 한데 몰려 다니게"). 목록 파일에도 경로만 적는다
   */
  parent: z.string().optional(),
  /**
   * 이 프로젝트에서 끈 소리 종류(10-24 리규형님 — Mesa 처럼 사람 없이 도는 프로젝트의 소리를 끄기). 끈 종류는 소리를 아예 만들지 않아
   * PC·웹·폰 앱 어디서도 안 울린다. 질문은 늘 울려 여기 없다(버튼 "질문은 늘 울림"). 하위 공간은 메인 것을 따른다(버튼) — 하위 칸은 안 쓴다
   */
  mute: z.array(z.enum(mutableSoundKinds)).optional(),
});
export { mutableSoundKinds, mutableSoundNames, type MutableSoundKind };
export type ProjectEntry = z.infer<typeof projectEntrySchema>;

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
/** 카테고리 묶음끼리의 순서(10-07 리규형님: 카테고리도 끌어 옮긴다) — 값은 카테고리 이름. 10-11부터 이 순서가 카테고리 번호다 */
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
// 팀원 프로젝트(shared/team/team)도 같은 고치기를 쓴다
// itemName(10-23): 같은 기기·경로로 이름만 다른 프로젝트를 여럿 둘 수 있어(리규형님 — Mesa 한 폴더를 세션 여럿으로) 고칠 줄의 지금 이름을
// 함께 보낸다. 없으면(옛 판 화면) 그 경로의 첫 항목
const itemName = z.string().optional();
export const projectsEditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), key: z.string(), name: z.string(), itemName }),
  /** 다른 카테고리로 — 그 묶음 맨 아래로 간다(10-10 결정). "" = 카테고리 없음 */
  z.object({ op: z.literal("category"), key: z.string(), category: z.string(), itemName }),
  z.object({ op: z.literal("enabled"), key: z.string(), enabled: z.boolean(), itemName }),
  /** 끈 소리 종류를 통째로 바꾼다 — [] = 모두 켬(10-24) */
  z.object({ op: z.literal("mute"), key: z.string(), mute: z.array(z.enum(["completion", "workflow", "warning", "danger"])), itemName }),
  z.object({ op: z.literal("remove"), key: z.string(), itemName }),
  /** host = "PC" 또는 ~/.ssh/config 의 Host 별칭. name 이 비면 폴더 이름. parent = 하위 공간으로 넣을 때 메인 경로(10-24) */
  z.object({ op: z.literal("add"), host: z.string(), path: z.string(), name: z.string(), category: z.string(), parent: z.string().optional() }),
  z.object({ op: z.literal("renameCategory"), from: z.string(), to: z.string() }),
  /** 카테고리만 지운다 — 안의 프로젝트는 "카테고리 없음"으로(10-10 결정) */
  z.object({ op: z.literal("deleteCategory"), name: z.string() }),
]);
export type ProjectsEditOp = z.infer<typeof projectsEditOpSchema>;

export const projectsEdit = defineRpc({
  name: "projects.edit",
  input: projectsEditOpSchema,
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
    entries: z.array(projectEntrySchema),
    readOnly: z.boolean().optional(),
    error: z.string().optional(),
  }),
});
