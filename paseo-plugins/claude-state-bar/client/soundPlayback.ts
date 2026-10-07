import { soundCancel, soundDropScreen, soundPresence, soundReport, soundResult, soundTake, soundWait, SOUND_HEARTBEAT_MS, SOUND_RETRY_MS, type RoutedSoundEvent, type SoundEnvelope, type SoundTicket } from "../shared/soundClaim";
import { soundOriginValidate, soundOriginDrop } from "../shared/soundEvents";
import { eventProject, markSoundScreenUse, rememberSoundReport, screenId, screenSnapshot, soundOrigin, watchSoundScreen } from "./soundScreen";
import { currentSettings, soundProvider, type SoundProvider } from "./sounds";
import { playSoundUrl, watchScreenUse } from "./web";

// 이벤트는 한 번만 보고한다. PC/프로토콜 오류는 로컬 재생권이 아니며 회복 때 다시 보내지 않는다.
export async function reportSoundEvent(event: RoutedSoundEvent, log: (message: string) => void): Promise<void> {
  if (!rememberSoundReport(event.eventId)) return;
  const connection = soundProvider()?.soundRouter;
  if (!connection) {
    log(`${event.kind}: skipped (v2 PC unavailable)`);
    void soundOrigin(event.originHostId)?.rpc(soundOriginDrop, { eventId: event.eventId }).catch(() => {});
    return;
  }
  try {
    const response = await connection.rpc(soundReport, { event: { ...event, projectKey: eventProject(event) }, screen: screenSnapshot() });
    if (response.coordinatorId !== connection.coordinatorId) throw new Error("소리 정본 번호 불일치");
    log(`${event.kind} ${event.eventId}: ${response.accepted ? "queued" : "already recorded/skipped"}`);
  } catch (e) {
    log(`${event.kind} ${event.eventId}: skipped (report failed): ${String(e)}`);
    void soundOrigin(event.originHostId)?.rpc(soundOriginDrop, { eventId: event.eventId }).catch(() => {});
    // 응답만 유실돼 서버에 큐가 남았을 수도 있다. 즉시 폐기 시도만 하며 보류/재시도 목록은 만들지 않는다.
    void connection.rpc(soundCancel, { eventId: event.eventId }).catch(() => {});
  }
}

export function startSoundPlayback(provider: SoundProvider, log: (message: string) => void): () => void {
  const connection = provider.soundRouter;
  if (!connection) return () => {};
  let stopped = false, connected = false, generation = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const triedTokens = new Set<string>();
  const { rpc, coordinatorId } = connection;
  const check = (e: SoundEnvelope) => { if (e.coordinatorId !== coordinatorId) throw new Error("소리 정본 번호 불일치"); };
  const failed = (e: unknown) => {
    if (stopped || !connected) return;
    connected = false; generation++;
    log(`sound queue disconnected; skip: ${String(e)}`);
    void rpc(soundDropScreen, { screenId: screenId() }).catch(() => {});
  };
  const sendPresence = async () => {
    if (stopped || !connected) return;
    const epoch = generation;
    try { const r = await rpc(soundPresence, screenSnapshot()); if (!stopped && generation === epoch) check(r); }
    catch (e) { if (generation === epoch) failed(e); }
  };
  const consume = async (ticket: SoundTicket, envelope: SoundEnvelope, epoch: number) => {
    if (stopped || !connected || generation !== epoch || triedTokens.has(ticket.token)) return;
    triedTokens.add(ticket.token);
    const alive = () => !stopped && connected && generation === epoch && soundProvider() === provider;
    try {
      const origin = soundOrigin(ticket.originHostId);
      if (!origin) throw new Error("발생 호스트 연결 없음");
      const settings = currentSettings();
      if (ticket.kind === "workflow" && !settings.workflowBeep) { await rpc(soundCancel, { eventId: ticket.eventId }); return; }
      const { valid } = await origin.rpc(soundOriginValidate, { event: ticket, warningPercent: settings.warningPercent, dangerPercent: settings.dangerPercent });
      if (!alive()) return;
      if (!valid) { await rpc(soundCancel, { eventId: ticket.eventId }); log(`${ticket.eventId}: cancelled at source`); return; }
      const audio = await provider.sound(ticket.kind); // 음원 실패면 승인도 받지 않는다.
      if (!alive()) return;
      // 음원을 기다리는 사이 질문 해결/다시 running이 됐을 수도 있으므로 승인 직전에 재확인한다.
      const latest = await origin.rpc(soundOriginValidate, { event: ticket, warningPercent: settings.warningPercent, dangerPercent: settings.dangerPercent });
      if (!alive()) return;
      if (!latest.valid) { await rpc(soundCancel, { eventId: ticket.eventId }); log(ticket.eventId + ": cancelled before take"); return; }
      const grant = await rpc(soundTake, { screen: screenSnapshot(), eventId: ticket.eventId, token: ticket.token, coordinatorEpoch: envelope.coordinatorEpoch });
      if (!alive()) return;
      check(grant);
      if (!grant.play) return;
      // 발급 후 실패/ACK 유실에도 재발급하지 않는다. 실제 재생 성공과 승인 성공은 별개다.
      try {
        const played = await playSoundUrl(audio);
        log(`${ticket.eventId}: ${played ? "started" : "skipped (not web)"}`);
        void rpc(soundResult, { screenId: screenId(), eventId: ticket.eventId, token: ticket.token, outcome: played ? "started" : "failed" }).catch((e) => log(`sound result unknown: ${String(e)}`));
      } catch (e) {
        log(`${ticket.eventId}: audio failed: ${String(e)}`);
        void rpc(soundResult, { screenId: screenId(), eventId: ticket.eventId, token: ticket.token, outcome: "failed" }).catch(() => {});
      }
    } catch (e) {
      log(`${ticket.eventId}: skipped: ${String(e)}`);
      void rpc(soundCancel, { eventId: ticket.eventId }).catch(() => {});
      failed(e);
    }
  };
  const loop = async () => {
    try {
      // 재연결 전에 옛 미승인 알림을 버린다. 소리를 회복 대기 상태로 두지 않는다.
      await rpc(soundDropScreen, { screenId: screenId() });
      if (stopped) return;
      connected = true;
      await sendPresence();
      while (!stopped && connected) {
        const epoch = generation;
        const response = await rpc(soundWait, { screenId: screenId() });
        if (stopped || !connected || generation !== epoch) return;
        check(response);
        for (const ticket of response.tickets) await consume(ticket, response, epoch);
      }
    } catch (e) { if (!stopped) { connected = true; failed(e); } }
    finally { if (!stopped) retry = setTimeout(() => { void loop(); }, SOUND_RETRY_MS); }
  };
  const stopState = watchSoundScreen(() => { void sendPresence(); });
  const stopUse = watchScreenUse(markSoundScreenUse);
  heartbeat = setInterval(() => { void sendPresence(); }, SOUND_HEARTBEAT_MS);
  void loop();
  return () => {
    stopped = true; connected = false; generation++;
    if (heartbeat) clearInterval(heartbeat);
    if (retry) clearTimeout(retry);
    stopState(); stopUse();
    void rpc(soundDropScreen, { screenId: screenId() }).catch(() => {});
  };
}
