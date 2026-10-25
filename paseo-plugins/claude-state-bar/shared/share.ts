import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 같이 보기(10-25 리규형님 결정) — 공유를 켠 대화의 사람 말·답 글만 콜어드민 웹 게이트에 사본으로 올리고, 팀원은 자기 웹 로그인으로
// "공유" 화면에서 읽고 답글을 남긴다. 팀원 답글은 리규형님 대화 화면에 플러그인 줄로만 뜬다(Claude 에게 안 감 — Paseo 가 그 줄을
// 화면 기록에만 넣는 것을 0.13.0 코드로 확인). 리규형님이 "대화에 넣기"를 눌러야 "<이름> 답글: …" 으로 대화에 들어간다.
// 공유 단위 = 대화 하나씩 · 켜고 끄기 = 입력창 위 "공유" 알약 · 답글이 오면 질문처럼 소리·폰 알림. 게이트 쪽은 docs web-gate/lib/share.mjs

/** 대화 화면에 덧붙이는 답글 줄의 렌더러 이름·판 */
export const SHARE_REPLY_KIND = "csb-share-reply";
export const SHARE_REPLY_VERSION = 1;
/** 답글 소리·폰 알림의 질문 번호 — 질문 다시 알림과 같은 길(push.compact_wait questionRepeats)로 화면에 간다 */
export const SHARE_REPLY_MARK = "share-";
export const shareReplyNative = (replyId: string) => `${SHARE_REPLY_MARK}${replyId}`;
export const shareReplyOf = (nativeId: string) => (nativeId.startsWith(SHARE_REPLY_MARK) ? nativeId.slice(SHARE_REPLY_MARK.length) : null);
/** 팀원 화면을 여는 화면 번호(팀원 데몬의 같은 플러그인이 단다) */
export const SHARE_SCREEN_ID = "share";

// 팀원 답글 첨부(10-25 리규형님 — 답글 칸 "+" 단추·이미지 붙여넣기, 모든 파일). 게이트(web-gate/lib/share.mjs REPLY_FILE_*)와 같은 상한.
// 대화에 넣을 때 이미지는 Claude 에게 이미지로, 글 파일은 글 첨부로, 그 밖은 이 기기 폴더에 저장한 경로를 넣는다(Paseo 가 Claude 에게
// 직접 넣을 수 있는 첨부는 이미지와 글뿐 — 0.13.0 SendMessageOptions images·attachments)
export const SHARE_FILES_MAX = 5;
export const SHARE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SHARE_FILES_TOTAL_BYTES = 20 * 1024 * 1024;
/** Claude 에게 이미지로 넣는 크기 상한(Claude 가 받는 이미지 한 장 상한 5MB) — 넘으면 파일로 저장하고 경로를 넣는다 */
export const SHARE_IMAGE_INLINE_MAX = 5 * 1024 * 1024;
/** 글 첨부로 넣는 크기 상한 — 넘으면 파일로 저장하고 경로를 넣는다(대화가 한꺼번에 너무 길어지지 않게) */
export const SHARE_TEXT_INLINE_MAX = 200 * 1024;
export const SHARE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// 첨부할 수 있는 형식(10-25 리규형님 명시 지시 — 공유받은 팀원은 이미지·PDF·PPT 등만). 게이트(web-gate/lib/share.mjs REPLY_ALLOWED_EXT)와 같은 목록 —
// 화면이 먼저 거르고 게이트가 한 번 더 거른다. 붙여 넣은 이미지는 이름이 없을 수 있어 이미지 형식이면 받는다
export const SHARE_ALLOWED_EXT: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "hwp", "hwpx"];
export const shareFileAllowed = (name: string, mimeType: string) =>
  SHARE_ALLOWED_EXT.includes(/\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "") || SHARE_IMAGE_TYPES.includes(mimeType.toLowerCase());
/** 파일 고르기 창에 거는 형식 */
export const SHARE_ACCEPT = SHARE_ALLOWED_EXT.map((e) => `.${e}`).join(",");
export const SHARE_ALLOWED_TEXT = "이미지·PDF·PPT·워드·엑셀·한글";

/**
 * 팀원 답글을 대화에 넣는 방식(10-25 리규형님 — 공유하는 사람이 공유할 때 고른다, 기본 바로 보냄).
 * direct = 받는 대로 대화에 넣는다(대화가 진행 중이면 그 차례가 끝난 뒤) · approve = 대화 화면 줄에서 "대화에 넣기"를 눌러야 들어간다
 */
export const shareModes = ["direct", "approve"] as const;
export type ShareMode = (typeof shareModes)[number];
export const SHARE_MODE_DEFAULT: ShareMode = "direct";
export const SHARE_MODE_LABEL: Record<ShareMode, string> = { direct: "바로 보냄", approve: "승인 후 보냄" };
/** 관리자(리규형님 웹 로그인)를 팀원 쪽에서 부르는 이름 — PC 팀원 정보에 부를 이름이 없을 때(10-25 팀원도 공유) */
export const ADMIN_LABEL = "관리자";
// .env 는 넣지 않는다 — DB 비밀번호·키가 대화 기록에 글로 남는다(파일로 저장하고 경로만)
const TEXT_EXT = new Set(("txt md markdown log csv tsv json jsonl xml yaml yml ini conf cfg toml sql sh bash zsh bat cmd ps1 " +
  "js mjs cjs jsx ts tsx py php php3 java kt kts dart go rs c h cpp hpp cc cs swift rb vue svelte html htm css scss less gradle properties").split(" "));
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|x-sh|x-yaml|yaml|sql|x-sql|toml)\b)/i;
export type ShareFileKind = "image" | "text" | "file";
/** 대화에 넣는 방식 — 이미지(5MB 이하) · 글 파일(200KB 이하) · 그 밖은 파일(경로). 글은 서버가 넣기 전에 UTF-8 로 한 번 더 확인한다 */
export function shareFileKind(name: string, mimeType: string, size: number): ShareFileKind {
  if (SHARE_IMAGE_TYPES.includes(mimeType.toLowerCase()) && size <= SHARE_IMAGE_INLINE_MAX) return "image";
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if ((TEXT_EXT.has(ext) || TEXT_MIME.test(mimeType)) && size <= SHARE_TEXT_INLINE_MAX) return "text";
  return "file";
}
export const shareSizeText = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

export const shareReplyFile = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(["image", "text", "file"]),
  /** 이 기기에 저장한 곳(대화에 "파일"로 넣을 때 쓰는 경로) */
  path: z.string().optional(),
});
export type ShareReplyFile = z.infer<typeof shareReplyFile>;

export const shareReplyData = z.object({
  replyId: z.string(),
  member: z.string(),
  label: z.string(),
  text: z.string(),
  at: z.string(),
  state: z.enum(["new", "inserted", "dismissed"]),
  /** 첨부 — 10-25 전 줄에는 없다 */
  files: z.array(shareReplyFile).optional(),
});
export type ShareReplyData = z.infer<typeof shareReplyData>;

const member = z.object({ id: z.string(), label: z.string() });
export type ShareMember = z.infer<typeof member>;

/** 이 데몬의 공유 상태 — 바뀌거나 25초가 지나면 답한다(rev 가 같으면 기다린다) */
export const shareWait = defineRpc({
  name: "share.wait",
  input: z.object({ rev: z.number().nullable() }),
  output: z.object({
    rev: z.number(),
    /** 게이트 길이 있는가(폰 알림이 중앙 경로인 데몬만) — 없으면 알약을 안 붙인다 */
    available: z.boolean(),
    reason: z.string().nullable(),
    /** 대화 번호 → 공유받는 팀원 아이디 */
    shares: z.record(z.string(), z.array(z.string())),
    /** 대화 번호 → 팀원 답글을 넣는 방식(공유 중인 대화만) */
    modes: z.record(z.string(), z.enum(shareModes)),
    /** 공유할 수 있는 사람(게이트에 등록이 끝난 팀원 + 관리자, 나는 빠짐 — 10-25). 이름은 PC 팀원 정보의 "부를 이름", 없으면 관리자는 "관리자"·팀원은 아이디 */
    members: z.array(member),
    /** 사본을 못 올리고 있는 대화 → 이유(화면 알약에 보인다) */
    errors: z.record(z.string(), z.string()),
  }),
});

/** 공유 켜기·끄기·팀원 바꾸기 — members 가 비면 끈다(게이트 사본도 지운다). mode 가 없으면 지금 방식 그대로(처음 켤 때는 바로 보냄) */
export const shareSet = defineRpc({
  name: "share.set",
  // 인원 상한 없음(10-25 명시 지시 6-3 "다중을 제한 없이") — 게이트가 계정에 있는 사람만 받는다
  input: z.object({ agentId: z.string().min(1).max(100), members: z.array(z.string().max(32)), mode: z.enum(shareModes).optional() }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

/** 답글 줄의 이미지 미리보기 — 이 기기에 저장한 n 번째 첨부(이미지만) */
export const shareReplyFileGet = defineRpc({
  name: "share.reply_file",
  input: z.object({ agentId: z.string().min(1).max(100), replyId: z.string().min(1).max(100), n: z.number().int().min(0).max(SHARE_FILES_MAX - 1) }),
  output: z.object({ ok: z.boolean(), mimeType: z.string().optional(), data: z.string().optional(), error: z.string().optional() }),
});

/** 답글 줄의 단추 — insert = 대화에 넣기(쉬고 있을 때만) · dismiss = 닫기 */
export const shareReplyAction = defineRpc({
  name: "share.reply_action",
  input: z.object({ agentId: z.string().min(1).max(100), replyId: z.string().min(1).max(100), action: z.enum(["insert", "dismiss"]) }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});
