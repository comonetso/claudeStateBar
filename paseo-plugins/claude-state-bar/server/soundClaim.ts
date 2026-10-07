import { randomUUID } from "node:crypto";
import { SOUND_LEDGER_KEEP_MS, SOUND_SCREEN_TTL_MS, SOUND_TICKET_TTL_MS, SOUND_WAIT_MS, eventSchema, type RoutedSoundEvent, type SoundScreenState, type SoundTicket } from "../shared/soundClaim";
import { SoundJournal, soundDataFile } from "./soundJournal";

// seenAt = 마지막 생존 증거(-Infinity = 재시작으로 복원했거나 끊겨서 다시 등록해야 후보). restored = 기록에서 되살린 화면 —
// 파일의 사용 번호는 "이미 최신이면 안 쓴다" 때문에 낡을 수 있어, 재시작 뒤 첫 등록의 번호 증가는 사용으로 치지 않는다.
// usedAt·at = 기록 시각(오래된 기록 정리 기준, 10-08 Claude)
type Screen = SoundScreenState & { seenAt: number; useOrder: number; usedAt?: number; restored?: boolean };
type RecordEntry = { eventId: string; event?: RoutedSoundEvent; screenId?: string; token?: string; expiresAt?: number; state: "queued" | "issued" | "dropped" | "cancelled"; outcome?: string; at?: number };

// 구버전의 실패 시 로컬 재생을 막으려면 정상적인 false 응답이어야 한다.
export function markScreenUsed(_screenId: string): { ok: boolean } { return { ok: true }; }
export async function claimSound(_input: unknown): Promise<{ play: boolean }> { return { play: false }; }

export function createSoundRouter(coordinatorId: string, file = soundDataFile("sound-ledger-v2.jsonl"), now = Date.now) {
  const coordinatorEpoch = randomUUID();
  const envelope = { coordinatorId, coordinatorEpoch };
  const screens = new Map<string, Screen>();
  const records = new Map<string, RecordEntry>();
  const waiters = new Map<string, Set<() => void>>();
  let order = 0;
  let disposed = false;
  let restoredLines = 0;
  const journal = new SoundJournal<RecordEntry | { type: "screen"; screen: Screen }>(file, (value) => {
    restoredLines++;
    if ("type" in value) {
      const s = value.screen;
      if (!s.screenId || !Number.isSafeInteger(s.useOrder) || !Number.isSafeInteger(s.userUseSeq)) throw new Error("화면 사용 기록 형식 오류");
      screens.set(s.screenId, { ...s, seenAt: Number.NEGATIVE_INFINITY, restored: true });
      order = Math.max(order, s.useOrder); return;
    }
    const r = value;
    if (!r.eventId || !["queued", "issued", "dropped", "cancelled"].includes(r.state)) throw new Error("소리 기록 형식 오류");
    if (r.event) eventSchema.parse(r.event);
    // 재시작은 회복 뒤 재배정이 아니다. 미승인 큐도 버리고 이벤트 기억은 유지한다.
    records.set(r.eventId, r.state === "queued" ? { ...r, state: "dropped" } : r);
  });
  const live = (s: Screen) => now() - s.seenAt < SOUND_SCREEN_TTL_MS;
  const presence = async (input: SoundScreenState) => {
    const old = screens.get(input.screenId);
    if (old && input.stateSeq <= old.stateSeq) return;
    const used = !old?.restored && input.userUseSeq > (old?.userUseSeq ?? 0);
    // 이미 가장 최근에 쓴 화면이면 순서가 그대로라 번호도 기록도 그대로 둔다 — 입력마다 디스크에 쓰지 않게(10-08 Claude)
    const latest = !!old && old.useOrder > 0 && old.useOrder === order;
    const bump = used && !latest;
    const useOrder = bump ? ++order : (old?.useOrder ?? 0);
    const next: Screen = { ...input, seenAt: now(), useOrder, usedAt: bump ? now() : old?.usedAt };
    if (bump) await journal.append({ type: "screen", screen: next });
    screens.set(input.screenId, next);
  };
  // 소리 대기 요청이 걸리는 것 자체가 생존 증거 — 숨긴 화면은 타이머가 1분에 한 번으로 늦춰져도 대기 요청은 25초마다 다시 온다.
  // 재시작·끊김으로 다시 등록해야 하는 화면(-Infinity)은 대기만으로 되살리지 않는다(등록 순서가 사용 순서를 바꾸지 않게)
  const touch = (screenId: string) => {
    const s = screens.get(screenId);
    if (s && s.seenAt !== Number.NEGATIVE_INFINITY) screens.set(screenId, { ...s, seenAt: now() });
  };
  const choose = (projectKey: string | null) => {
    const all = [...screens.values()].filter(live);
    const green = projectKey === null ? [] : all.filter((s) => s.projectKey === projectKey);
    return (green.length ? green : all).sort((a, b) => b.useOrder - a.useOrder || a.screenId.localeCompare(b.screenId))[0]?.screenId;
  };
  const wake = (id?: string) => { if (id) for (const f of [...(waiters.get(id) ?? [])]) f(); };
  const save = async (r: RecordEntry) => { const e = { ...r, at: now() }; await journal.append(e); records.set(r.eventId, e); };
  const drop = async (r: RecordEntry, state: "dropped" | "cancelled" = "dropped") => { await save({ ...r, state }); wake(r.screenId); };
  const tickets = async (screenId: string): Promise<SoundTicket[]> => {
    const out: SoundTicket[] = [];
    for (const r of records.values()) {
      if (r.state !== "queued" || r.screenId !== screenId) continue;
      const screen = screens.get(screenId);
      if (!screen || !live(screen) || now() >= r.expiresAt! || disposed) { await drop(r); continue; }
      out.push({ ...r.event!, token: r.token!, expiresAt: r.expiresAt! });
    }
    return out;
  };
  // 데몬이 켜질 때 한 번 — 보관 기간(SOUND_LEDGER_KEEP_MS) 지난 이벤트·화면 기록을 버리고, 같은 이벤트의 여러 줄(queued·issued·결과)은
  // 마지막 상태 한 줄로 줄인다. 시각을 모르는 줄은 남긴다. 정리 실패는 로그만 남기고 옛 파일을 그대로 쓴다(10-08 Claude)
  void journal.serial(async () => {
    const cutoff = now() - SOUND_LEDGER_KEEP_MS;
    let removed = 0;
    for (const [id, r] of records) {
      const at = r.at ?? (r.expiresAt !== undefined ? r.expiresAt - SOUND_TICKET_TTL_MS : undefined);
      if (at !== undefined && at < cutoff) { records.delete(id); removed++; }
    }
    for (const [id, s] of screens) if (s.usedAt !== undefined && s.usedAt < cutoff) { screens.delete(id); removed++; }
    const lines = [
      ...[...screens.values()].map((s) => ({ type: "screen" as const, screen: { ...s, seenAt: 0, restored: undefined } })),
      ...records.values(),
    ];
    if (!removed && lines.length >= restoredLines) return;
    try {
      await journal.rewrite(lines);
      console.log(`[sound-v2] ledger compacted ${restoredLines} -> ${lines.length} lines (${removed} older than keep)`);
    } catch (e) {
      console.log(`[sound-v2] ledger compact failed, kept as is: ${String(e)}`);
    }
  }).catch(() => {});
  return {
    async presence(input: SoundScreenState) { return journal.serial(async () => { if (disposed) throw new Error("소리 선출기 종료"); await presence(input); return envelope; }); },
    async report(input: { screen: SoundScreenState; event: RoutedSoundEvent }) {
      return journal.serial(async () => {
        if (disposed) throw new Error("소리 선출기 종료");
        await presence(input.screen);
        const old = records.get(input.event.eventId);
        if (old) return { ...envelope, accepted: false };
        const screenId = choose(input.event.projectKey);
        const r: RecordEntry = { eventId: input.event.eventId, event: input.event, screenId, token: randomUUID(), expiresAt: now() + SOUND_TICKET_TTL_MS, state: screenId ? "queued" : "dropped" };
        await save(r); wake(screenId);
        console.log(`[sound-v2] queued ${r.eventId} -> ${screenId ?? "skip"}`);
        return { ...envelope, accepted: !!screenId };
      });
    },
    async wait(screenId: string) {
      const first = await journal.serial(async () => { touch(screenId); return tickets(screenId); });
      if (first.length || disposed) return { ...envelope, tickets: first };
      // 등록 후 한 번 더 검사하므로 검사-등록 사이에 들어온 이벤트도 놓치지 않는다.
      await new Promise<void>((resolve) => {
        const set = waiters.get(screenId) ?? new Set<() => void>();
        waiters.set(screenId, set);
        const finish = () => { clearTimeout(timer); set.delete(finish); if (!set.size) waiters.delete(screenId); resolve(); };
        const timer = setTimeout(finish, SOUND_WAIT_MS);
        set.add(finish);
        void journal.serial(() => tickets(screenId)).then((r) => { if (r.length || disposed) finish(); }, finish);
      });
      return { ...envelope, tickets: await journal.serial(() => tickets(screenId)) };
    },
    async take(input: { screen: SoundScreenState; eventId: string; token: string; coordinatorEpoch: string }) {
      return journal.serial(async () => {
        await presence(input.screen);
        const r = records.get(input.eventId);
        if (disposed || input.coordinatorEpoch !== coordinatorEpoch || !r || r.state !== "queued" || r.screenId !== input.screen.screenId || r.token !== input.token) return { ...envelope, play: false };
        const selected = screens.get(r.screenId);
        if (!selected || !live(selected) || now() >= r.expiresAt!) { await drop(r); return { ...envelope, play: false }; }
        // 승인 전 최신 초록과 사용 순서를 반영한다. 발급한 권리는 다시 옮기지 않는다.
        const winner = choose(r.event!.projectKey);
        if (winner !== r.screenId) {
          await save({ ...r, screenId: winner, token: randomUUID(), state: winner ? "queued" : "dropped" });
          wake(winner); return { ...envelope, play: false };
        }
        await save({ ...r, state: "issued" });
        console.log(`[sound-v2] issued ${r.eventId} -> ${r.screenId}`);
        return { ...envelope, play: true };
      });
    },
    async cancel(eventId: string) { return journal.serial(async () => { const r = records.get(eventId); if (r?.state === "issued") return { ok: false }; await drop(r ?? { eventId, state: "cancelled" }, "cancelled"); return { ok: true }; }); },
    // 지우지 않고 후보에서만 뺀다 — 지우면 다시 붙을 때 새 화면으로 받아 "가장 최근에 쓴 화면"으로 올라간다(잠깐 끊긴 폰이 소리를
    // 가져가던 것, 10-08 Claude). 사용 순서·번호는 남겨 두고 다시 등록하면 후보로 돌아온다
    async dropScreen(screenId: string) { return journal.serial(async () => { const s = screens.get(screenId); if (s) screens.set(screenId, { ...s, seenAt: Number.NEGATIVE_INFINITY }); for (const r of records.values()) if (r.state === "queued" && r.screenId === screenId) await drop(r); wake(screenId); return { ok: true }; }); },
    async result(input: { screenId: string; eventId: string; token: string; outcome: string }) { return journal.serial(async () => { const r = records.get(input.eventId); if (!r || r.state !== "issued" || r.token !== input.token || r.screenId !== input.screenId) return { ok: false }; await save({ ...r, outcome: input.outcome }); console.log(`[sound-v2] ${input.outcome} ${r.eventId}`); return { ok: true }; }); },
    dispose() { disposed = true; for (const id of [...waiters.keys()]) wake(id); },
  };
}
