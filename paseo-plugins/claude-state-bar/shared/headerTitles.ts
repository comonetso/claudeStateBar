import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 위쪽 제목(작업 공간 머리줄) "카테고리 - 이름"(리규형님 10-07·10-08 결정 — 번호는 떼고, 이미 붙은 작업 공간 제목도 전부 덮고,
// 새 작업 공간·목록 변경도 자동으로 맞춘다). 머리줄 앞칸은 작업 공간 제목, 뒷칸은 프로젝트 이름이라 둘 다 같은 글로 맞춘다
// (넓은 화면은 같으면 한 줄만 보인다). 기기마다 그 기기 화면 플러그인이 자기 기기 작업 공간을 맞추고, 경로별 제목은 그 기기의
// ~/.claude/project-labels.json(PC 가 목록에서 만들어 보낸 이름표, server/projectLabels)에서 읽는다
/** title = 위쪽 제목 "카테고리 - 이름", name = 이름만(폰·좁은 화면 위 줄 — 10-08 리규형님 "폰에선 카테고리 빼기") */
const titleSchema = z.object({ path: z.string(), title: z.string(), name: z.string() });

/** 이름표가 바뀔 때까지 기다린다(길어도 25초). 지금 아는 서명을 보내면, 다르면 바로 답한다 */
export const headerTitlesWait = defineRpc({
  name: "header-titles.wait",
  input: z.object({ sig: z.string().nullable() }),
  output: z.object({ sig: z.string().nullable(), titles: z.array(titleSchema) }),
});

/** 바꾸기 전 원래 이름을 기록하고, 프로젝트면 이 기기의 paseo 명령으로 이름을 바꾼다(작업 공간 제목은 화면이 직접 바꾼다) */
export const headerTitleApply = defineRpc({
  name: "header-titles.apply",
  input: z.object({ kind: z.enum(["workspace", "project"]), id: z.string(), before: z.string(), after: z.string() }),
  output: z.object({ ok: z.boolean(), out: z.string() }),
});
