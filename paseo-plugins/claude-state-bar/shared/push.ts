import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 폰 푸시(10-15 리규형님 — 질문지·압축 준비만, 모든 대화). 폰 감싸기 앱(com.blueming.paseo)이 웹에 주는 FCM 토큰을
// 화면 플러그인이 자기 데몬에 맡긴다. 데몬마다 자기 대화의 일만 보낸다
export const pushRegister = defineRpc({
  name: "push.register",
  input: z.object({ token: z.string().min(1).max(4096) }),
  // enabled = 이 데몬에 발송 키가 있어 실제로 보낼 수 있는지(직원 데몬·키 없는 기기는 false)
  output: z.object({ ok: z.boolean(), enabled: z.boolean() }),
});

// 폰 앱이 알림을 받았다(10-17 — 폰 앱 대화와 peer_mail 91f222d6 으로 맞춤: 앱이 웹에 "paseoshell:push-received" detail {eventId, kind, receivedAt}).
// 화면 플러그인이 자기 데몬에 전한다 — 그 알림을 보낸 데몬만 ok(다른 데몬은 무시). 받았으면 그 소리는 PC 에서 울리지 않는다(server/push.ts)
export const pushReceived = defineRpc({
  name: "push.received",
  input: z.object({ eventId: z.string().min(1).max(300), kind: z.string().max(20).optional(), receivedAt: z.number().optional() }),
  output: z.object({ ok: z.boolean() }),
});

// 답하지 않은 질문 다시 알리기(10-24 리규형님 "알림을 보낸 뒤 5분 안에 질문 버튼을 누르지 않으면 누를 때까지 계속 보냄 — 작업이 끊기지 않게" ·
// 버튼 "폰 알림과 PC 질문 소리 둘 다 · 5분마다, 누를 때까지"). 다시 보낼 때마다 질문 번호 끝에 ":r<회차>" 를 붙여 새 사건으로 올린다 —
// 폰 알림과 PC 소리는 사건 번호로 짝을 맞추므로(폰이 받으면 PC 조용) 서버·화면이 같은 번호를 쓴다. 판정할 때는 표시를 떼고 원래 질문을 본다
const REPEAT_MARK = /:r\d+$/;
export const baseQuestionId = (nativeId: string) => nativeId.replace(REPEAT_MARK, "");
export const questionRepeatId = (requestId: string, round: number) => `${baseQuestionId(requestId)}:r${round}`;

// 프로젝트 목록의 압축 준비 아이콘(10-15 리규형님 "질문지 올라올 때 ? 넣듯이") — 이 데몬에서 압축 명령어를 기다리는 대화.
// 바뀌거나 25초가 지나면 답한다(rev 가 같으면 기다린다). questionRepeats = 지금 다시 울릴 질문(10-24 — 옛 데몬은 보내지 않는다)
export const pushCompactWait = defineRpc({
  name: "push.compact_wait",
  input: z.object({ rev: z.number().nullable() }),
  output: z.object({
    rev: z.number(),
    agentIds: z.array(z.string()),
    questionRepeats: z.array(z.object({ agentId: z.string(), nativeId: z.string() })).optional(),
  }),
});
