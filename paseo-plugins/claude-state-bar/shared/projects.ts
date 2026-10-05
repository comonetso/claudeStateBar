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
