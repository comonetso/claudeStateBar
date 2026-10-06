import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 프로젝트 매니저 목록 파일(projects.json)을 Paseo 안에서 고친다(리규형님 10-06 결정: VS Code 없이, 폰에서도).
// 화면(projectsEdit)과 데몬(server/projects)이 같은 검사를 써서, 목록을 못 읽게 되는 파일은 저장하지 않는다.

export const projectsFileRead = defineRpc({
  name: "projects.file-read",
  input: z.object({}),
  output: z.object({
    /** 목록 파일 경로. 못 찾았으면 null */
    file: z.string().nullable(),
    text: z.string(),
    /** 읽은 때의 파일 수정 시각 — 저장할 때 그사이 다른 곳(VS Code 등)에서 바뀌었는지 가린다 */
    mtimeMs: z.number().nullable(),
    error: z.string().optional(),
  }),
});

export const projectsFileWrite = defineRpc({
  name: "projects.file-write",
  input: z.object({ text: z.string(), baseMtimeMs: z.number().nullable() }),
  output: z.object({ ok: z.boolean(), mtimeMs: z.number().optional(), error: z.string().optional() }),
});

/**
 * 저장해도 되는 글인지. 문제가 있으면 사람이 읽을 이유, 없으면 null.
 * 목록 읽기(server/projects listProjects)는 배열 안의 name·rootPath(글자) 항목만 쓰고 나머지는 조용히 건너뛴다 —
 * 고치다 빠뜨린 항목이 목록에서 말없이 사라지지 않게 저장 때는 막는다.
 */
export function projectsTextProblem(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `JSON 형식 오류: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!Array.isArray(raw)) return "맨 바깥이 [ ] 배열이어야 합니다";
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i] as { name?: unknown; rootPath?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.name !== "string" || typeof o.rootPath !== "string") {
      return `${i + 1}번째 항목에 name·rootPath(글자)가 없습니다`;
    }
  }
  return null;
}
