import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { soundKinds } from "./sound";

// 시간 정책은 여기 한 곳에 둔다. 값은 Codex 가 정하고(261008_024100 §0) 리규형님 위임으로 Claude 가 근거를 다시 따져 정했다(10-08).
// 생존은 소리 대기 요청이 걸릴 때마다 갱신된다(server/soundClaim wait). 브라우저·PC 앱은 5분 넘게 숨긴 화면의 타이머를
// 1분에 한 번으로 늦추지만(Chrome 88 intensive throttling — 반복 타이머 해당) 대기 요청 응답은 타이머가 아니라 늦춰지지 않는다.
/** 화면 상태(초록 프로젝트·사용 번호) 보조 전송 간격 — 변경은 따로 즉시 보낸다. 생존은 대기 요청이 맡아 늦춰져도 무해. PC 부하는 화면당 5초에 한 건 */
export const SOUND_HEARTBEAT_MS = 5_000;
/** 생존 증거가 이만큼 없으면 후보에서 뺀다 — 살아 있는 화면은 대기 요청(SOUND_WAIT_MS 25초)마다 갱신되니 25초 + 한 번 늦은 재연결(5초)을 넘는 여유.
 *  더 길면 닫힌 화면이 뽑혀 아무 데서도 안 울리는 시간이 는다 */
export const SOUND_SCREEN_TTL_MS = 45_000;
/** 뽑힌 화면이 이 안에 가져가지 않으면 버린다 — 대기 한 주기(25초)와 같아 재요청 틈에 온 소리도 다음 대기에서 받는다.
 *  더 길면 회복된 화면이 한참 지난 소리를 낸다(리규형님 결정: 회복 뒤 재배정·늦은 재생 없음) */
export const SOUND_TICKET_TTL_MS = 25_000;
export const SOUND_WAIT_MS = 25_000; // Paseo 서버 RPC 제한 30초보다 짧게(기존 settingsSync와 같음).
/** 끊겼을 때 다시 붙는 간격 — 끊긴 동안의 소리는 버려지므로(재전송 없음) 짧게. PC 가 꺼져 있으면 화면당 5초에 실패 한 건 */
export const SOUND_RETRY_MS = 5_000;
export const SOUND_PAGE_SIZE = 200; // 기존 프로젝트 목록의 페이지 크기, 다음 페이지는 모두 읽는다.
/** 입력 묶기 — 1초 안의 클릭·키 입력은 처음과 끝 두 번만 PC 에 알린다. "마지막으로 만진 화면"은 사람이 1초 안에 두 기기를
 *  오가며 입력하지 않으니 이 정도로 충분하고, 타이핑마다 PC 요청이 몰려 소리 처리가 밀리지 않게 */
export const SOUND_USE_COALESCE_MS = 1_000;
/** PC 소리 기록 보관 — 데몬이 켜질 때 이보다 오래된 이벤트·화면 기록을 정리한다. 화면은 처음 열 때·다시 붙을 때 지금 상태를
 *  기준으로만 삼아(baseline) 오래된 이벤트 번호를 다시 보고하지 않는다. 기간은 이 플러그인 묶음의 기록 보관 기본(codex_rescue 7일)과 같게 */
export const SOUND_LEDGER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export const screenSchema = z.object({
  screenId: z.string().min(1), stateSeq: z.number().int().nonnegative(),
  userUseSeq: z.number().int().nonnegative(), projectKey: z.string().nullable(),
});
export const eventSchema = z.object({
  eventId: z.string().min(1), originHostId: z.string().min(1), agentId: z.string(),
  kind: z.enum(soundKinds), nativeId: z.string().min(1),
  projectKey: z.string().nullable(), directory: z.string(),
});
export const envelopeSchema = z.object({ coordinatorId: z.string(), coordinatorEpoch: z.string() });
export const ticketSchema = eventSchema.extend({ token: z.string(), expiresAt: z.number() });
export type SoundScreenState = z.infer<typeof screenSchema>;
export type RoutedSoundEvent = z.infer<typeof eventSchema>;
export type SoundTicket = z.infer<typeof ticketSchema>;
export type SoundEnvelope = z.infer<typeof envelopeSchema>;

// 옛 화면은 v2 큐에 참여하지 않는다. 옛 이름을 제거하면 catch에서 재생하므로 false로 응답해야 한다.
export const soundScreenUsed = defineRpc({ name: "sound.screen-used", input: z.object({ screenId: z.string() }), output: z.object({ ok: z.boolean() }) });
export const soundClaim = defineRpc({
  name: "sound.claim",
  input: z.object({ screenId: z.string(), key: z.string(), eventProject: z.string().nullable(), screenProject: z.string().nullable() }),
  output: z.object({ play: z.boolean() }),
});
export const soundPresence = defineRpc({ name: "sound.presence-v2", input: screenSchema, output: envelopeSchema });
export const soundReport = defineRpc({
  name: "sound.report-v2", input: z.object({ screen: screenSchema, event: eventSchema }),
  output: envelopeSchema.extend({ accepted: z.boolean() }),
});
export const soundWait = defineRpc({
  name: "sound.wait-v2", input: z.object({ screenId: z.string() }),
  output: envelopeSchema.extend({ tickets: z.array(ticketSchema) }),
});
export const soundTake = defineRpc({
  name: "sound.take-v2", input: z.object({ screen: screenSchema, eventId: z.string(), token: z.string(), coordinatorEpoch: z.string() }),
  output: envelopeSchema.extend({ play: z.boolean() }),
});
export const soundCancel = defineRpc({
  name: "sound.cancel-v2", input: z.object({ eventId: z.string() }), output: z.object({ ok: z.boolean() }),
});
export const soundDropScreen = defineRpc({
  name: "sound.drop-screen-v2", input: z.object({ screenId: z.string() }), output: z.object({ ok: z.boolean() }),
});
export const soundResult = defineRpc({
  name: "sound.result-v2", input: z.object({ screenId: z.string(), eventId: z.string(), token: z.string(), outcome: z.enum(["started", "failed", "cancelled"]) }),
  output: z.object({ ok: z.boolean() }),
});
