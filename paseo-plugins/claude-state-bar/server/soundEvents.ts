import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { SOUND_PAGE_SIZE, type RoutedSoundEvent } from "../shared/soundClaim";
import type { SoundKind } from "../shared/sound";
import { hostIdentity } from "./layoutSync";
import { lastTurnCommandOnly } from "./chime/lastTurn";
import { SoundJournal, soundDataFile } from "./soundJournal";

// 서버 0.10.3 의 플러그인 묶기(paseo-plugin-server-runtime-boundary)는 @getpaseo/client 를 직접 가져오면 빌드를 거절한다
// (10-08 서버 3대 배포 실패) — 늘 통과하던 서버 SDK 문맥 타입에서 꺼낸다
type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgent = NonNullable<NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"]>;
type Config = { warningPercent: number; dangerPercent: number };
type Cycle = { key: string; cycle: number; high: boolean };
export function createSoundOrigins(file = soundDataFile("sound-origin-v2.jsonl")) {
  const cycles = new Map<string, Cycle>();
  const skipped = new Set<string>();
  const journal = new SoundJournal<Cycle | { type: "skip"; eventId: string }>(file, (value) => {
    if ("type" in value) { if (value.type !== "skip" || typeof value.eventId !== "string") throw new Error("발생 폐기 기록 오류"); skipped.add(value.eventId); return; }
    const r = value;
    if (typeof r.key !== "string" || !Number.isSafeInteger(r.cycle) || r.cycle < 0 || typeof r.high !== "boolean") throw new Error("소리 발생 기록 형식 오류");
    cycles.set(r.key, r);
  });
  const incarnation = (a: PaseoAgent) => JSON.stringify([a.id, a.createdAt, a.persistence?.sessionId ?? null]);
  const percent = (a: PaseoAgent) => {
    const used = a.lastUsage?.contextWindowUsedTokens, max = a.lastUsage?.contextWindowMaxTokens;
    return used === undefined || !max ? null : used / max * 100;
  };
  const sample = async (a: PaseoAgent, cfg: Config) => {
    const key = incarnation(a), old = cycles.get(key);
    const p = percent(a);
    if (p === null) return old?.cycle ?? 0; // 사용량 미상은 reset이 아니다.
    const high = p >= cfg.warningPercent;
    const cycle = old ? old.cycle + (old.high && !high ? 1 : 0) : 0;
    if (!old || old.high !== high) {
      const r = { key, cycle, high }; await journal.append(r); cycles.set(key, r);
    }
    return cycle;
  };
  const fresh = async (paseo: PaseoApi, agentId: string) => (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
  const directoryOf = async (paseo: PaseoApi, a: PaseoAgent) => {
    if (!a.workspaceId) return a.cwd;
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: { entries: { id: string; workspaceDirectory: string }[]; pageInfo: { hasMore: boolean; nextCursor: string | null } } = await paseo.workspaces.list({ page: { limit: SOUND_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
      const hit = page.entries.find((w) => w.id === a.workspaceId);
      if (hit) return hit.workspaceDirectory;
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error("작업 공간 페이지 반복");
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new Error("발생 작업 공간 폴더 미확인");
  };
  const completionId = async (paseo: PaseoApi, a: PaseoAgent): Promise<string | null> => {
    const page = await paseo.agents.ref(a.id).timeline.refetch({ direction: "tail", projection: "canonical", limit: SOUND_PAGE_SIZE });
    if (page.error || page.gap || page.staleCursor) return null;
    // 원본 live timeline에 붙은 회차 번호를 쓴다. 시간/화면 카운터로 회차를 추정하지 않는다.
    const latest = [...page.entries].sort((x, y) => y.seqEnd - x.seqEnd).find((e) => e.turnId);
    return latest?.turnId ? JSON.stringify([a.lastUserMessageAt, latest.turnId]) : null;
  };
  const valid = async (a: PaseoAgent, kind: SoundKind, nativeId: string, cfg: Config, cycle: number, paseo: PaseoApi) => {
    if (a.archivedAt || a.status === "closed") return false;
    if (kind === "question") return a.pendingPermissions.some((p) => p.id === nativeId && (p.kind === "question" || p.kind === "plan"));
    if (kind === "completion") {
      if (a.status !== "idle" || !a.lastUserMessageAt || await completionId(paseo, a) !== nativeId || a.pendingPermissions.some((p) => p.kind === "question" || p.kind === "plan")) return false;
      if (a.provider === "claude" && a.persistence?.sessionId && await lastTurnCommandOnly(a.persistence.sessionId)) return false;
      return true;
    }
    if (kind === "workflow") return true; // 번호는 스캐너가 실제 완료 항목에서 준다.
    const p = percent(a);
    return nativeId === String(cycle) && p !== null && p >= (kind === "danger" ? cfg.dangerPercent : cfg.warningPercent);
  };
  return {
    observe(agentId: string, cfg: Config, paseo: PaseoApi) {
      return journal.serial(async () => { const a = await fresh(paseo, agentId); if (!a) return { ok: false }; await sample(a, cfg); return { ok: true }; });
    },
    prepare(input: Config & { agentId: string; kind: SoundKind; nativeId: string }, paseo: PaseoApi) {
      return journal.serial(async (): Promise<{ event: RoutedSoundEvent | null }> => {
        const a = await fresh(paseo, input.agentId); if (!a) return { event: null };
        const cycle = await sample(a, input);
        if (input.kind === "completion" && (!a.lastUserMessageAt || input.nativeId !== a.lastUserMessageAt)) return { event: null };
        const nativeId = input.kind === "completion" ? await completionId(paseo, a)
          : input.kind === "warning" || input.kind === "danger" ? String(cycle) : input.nativeId;
        if (!nativeId || !await valid(a, input.kind, nativeId, input, cycle, paseo)) return { event: null };
        const { serverId } = await hostIdentity(); if (!serverId) throw new Error("발생 데몬 번호 미확인");
        const eventId = JSON.stringify(["sound-v2", serverId, input.kind === "workflow" ? "workflow" : incarnation(a), input.kind, nativeId]);
        if (skipped.has(eventId)) return { event: null };
        return { event: {
          eventId,
          originHostId: serverId, agentId: a.id, kind: input.kind, nativeId,
          directory: await directoryOf(paseo, a), projectKey: null,
        } };
      });
    },
    drop(eventId: string) {
      return journal.serial(async () => {
        const { serverId } = await hostIdentity();
        const key: unknown = JSON.parse(eventId);
        if (!Array.isArray(key) || key[0] !== "sound-v2" || key[1] !== serverId) return { ok: false };
        if (!skipped.has(eventId)) { await journal.append({ type: "skip", eventId }); skipped.add(eventId); }
        return { ok: true };
      });
    },
    validate(event: RoutedSoundEvent, cfg: Config, paseo: PaseoApi) {
      return journal.serial(async () => {
        const a = await fresh(paseo, event.agentId); if (!a) return { valid: false };
        const { serverId } = await hostIdentity();
        const expected = JSON.stringify(["sound-v2", serverId, event.kind === "workflow" ? "workflow" : incarnation(a), event.kind, event.nativeId]);
        if (skipped.has(event.eventId) || event.eventId !== expected || serverId !== event.originHostId) return { valid: false };
        return { valid: await valid(a, event.kind, event.nativeId, cfg, await sample(a, cfg), paseo) };
      });
    },
  };
}
