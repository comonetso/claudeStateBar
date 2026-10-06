import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// VS Code 프로젝트 매니저 목록(리규형님 10-05: Paseo 에서 태그 묶음 그대로 쓰고 싶다). 데몬(PC)이 프로젝트 매니저 파일을
// 그대로 읽어 준다 — VS Code 에서 고쳐도 바로 따라온다.
const entrySchema = z.object({
  name: z.string(),
  tags: z.array(z.string()),
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
