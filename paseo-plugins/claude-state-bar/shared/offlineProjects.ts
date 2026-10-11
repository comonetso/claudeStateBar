import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { projectEntrySchema } from "./projects";

// 261012 결정: Calladmin-Gabia만 PC가 없을 때 네 기능을 대신한다. SSH 별칭은 PC만 안다.
export const OFFLINE_HOST = "Calladmin-Gabia";
export const OFFLINE_NOTICE = "PC 가 꺼져 있어 보기만 됩니다";
export const PC_OFFLINE_NOTICE = "PC 가 꺼져 있습니다";
export const offlineCopySchema = z.object({
  recipient: z.string(),
  fallback: z.boolean(),
  entries: z.array(projectEntrySchema),
  keys: z.array(z.string()),
  groups: z.record(z.string(), z.array(z.string())),
});
// 최초에는 mtimeMs를 생략해 바로 답한다. 이후는 기존 목록 기다리기와 같은 25초 long poll.
export const offlineProjectsStatus = defineRpc({
  name: "projects.offline-status",
  input: z.object({ mtimeMs: z.number().nullable().optional() }),
  output: z.object({ eligible: z.boolean(), mtimeMs: z.number().nullable() }),
});
