import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { SOUND_PAGE_SIZE, type RoutedSoundEvent } from "../../shared/presentation/soundClaim";
import type { SoundKind } from "../../shared/presentation/sound";
import { hostIdentity } from "../layoutSync";
import { lastTurnCommandOnly } from "./chime/lastTurn";
import { mutedKindsOf } from "../projects/projectMute";
import type { MutableSoundKind } from "../../shared/projects/projects";
import { SoundJournal, soundDataFile } from "./soundJournal";
import { phoneTook } from "./push";
import { baseQuestionId } from "../../shared/presentation/push";
import { shareReplyOf } from "../../shared/team/share";
import { shareReplyPending } from "../team/share";
import { baseOf } from "../account";
import { waitedLong } from "../diagStall";

// 서버 0.10.3 의 플러그인 묶기(paseo-plugin-server-runtime-boundary)는 @getpaseo/client 를 직접 가져오면 빌드를 거절한다
// (10-08 서버 3대 배포 실패) — 늘 통과하던 서버 SDK 문맥 타입에서 꺼낸다
type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgent = NonNullable<NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"]>;
type Config = { warningPercent: number; dangerPercent: number };
type Cycle = { key: string; cycle: number; high: boolean };

// ── 폰 푸시 내구 판정(10-18 FCM 한 곳 관리 — Codex 261018_052815 D-2 "발생 데몬의 아주 작은 내구 판정 기록") ──
// 중앙 경로(<Paseo 홈>/claude-state-bar/push-central.json 의 mode "central")에서만 쓴다. 지금처럼 직발송(legacy)이면 아래 phoneTook 그대로다.
// 사건 키 = push.ts 의 알림 eventId(q:<대화>:<요청> · c:<대화>:<차례>). 판정은 pending → phone | pc 한 번뿐이고 pending 으로 돌아가지 않는다.
// phone 은 게이트가 "이 배달은 허락하지 않았다"고 분명히 답했을 때만 거둔다(void → pc). 불변식: 폰 재생 ⇒ phone 이 먼저 내구 저장됨 ·
// PC 재생 ⇒ pending→pc 전이 성공. 기록은 소리 발생 기록과 같은 SoundJournal(fsync 뒤에만 답 · 손상/쓰기 실패면 무음으로 닫힘), 파일은 따로.
// 7일 지난 판정은 처음 읽을 때 접는다(구현 세부 — 사건 키는 대화·요청·차례 번호라 다시 오지 않는다).
type PdState = "pending" | "phone" | "void" | "pc" | "resolved";
type PdRecord = { type: "pd"; key: string; state: PdState; deliveryId?: string | null; at: number };
type PdEntry = { decision: "pending" | "phone" | "pc"; deliveryId: string | null; resolved: boolean; at: number };
const PD_STATES: readonly string[] = ["pending", "phone", "void", "pc", "resolved"];
const PD_KEEP_MS = 7 * 24 * 3600 * 1000;

export function createPushDisposition(file = soundDataFile("push-disposition-v1.jsonl"), now: () => number = () => Date.now()) {
  const entries = new Map<string, PdEntry>();
  /** 이 프로세스가 지금 판정 중인 사건 — 데몬이 다시 뜨면 비어 있다(옛 pending 은 기다리지 않고 pc 로 굳힌다) */
  const live = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const apply = (r: PdRecord) => {
    const e = entries.get(r.key) ?? { decision: "pending", deliveryId: null, resolved: false, at: r.at };
    if (r.state === "phone") { e.decision = "phone"; e.deliveryId = r.deliveryId ?? null; }
    else if (r.state === "void" || r.state === "pc") e.decision = "pc";
    else if (r.state === "resolved") e.resolved = true;
    e.at = r.at;
    entries.set(r.key, e);
  };
  const journal = new SoundJournal<PdRecord>(file, (r) => {
    if (r?.type !== "pd" || typeof r.key !== "string" || !PD_STATES.includes(r.state) || !Number.isFinite(r.at)) throw new Error("폰 푸시 판정 기록 형식 오류");
    apply(r);
  });
  let compacted = false;
  const run = <R>(fn: () => Promise<R>) => journal.serial(async () => {
    if (!compacted) {
      compacted = true;
      const cut = now() - PD_KEEP_MS;
      const old = [...entries].filter(([, e]) => e.at < cut).map(([k]) => k);
      if (old.length) {
        for (const k of old) entries.delete(k);
        const keep: PdRecord[] = [];
        for (const [key, e] of entries) {
          keep.push({ type: "pd", key, state: e.decision, deliveryId: e.deliveryId, at: e.at });
          if (e.resolved) keep.push({ type: "pd", key, state: "resolved", at: e.at });
        }
        await journal.rewrite(keep).catch((error: unknown) => console.log(`[push] disposition compact failed: ${String(error)}`));
      }
    }
    return fn();
  });
  const write = async (r: PdRecord) => {
    await journal.append(r);
    apply(r);
    for (const wake of [...(waiters.get(r.key) ?? [])]) wake();
  };
  const waitFor = (key: string, ms: number) => new Promise<void>((done) => {
    const set = waiters.get(key) ?? new Set<() => void>();
    waiters.set(key, set);
    const finish = () => { clearTimeout(timer); set.delete(finish); if (!set.size) waiters.delete(key); done(); };
    const timer = setTimeout(finish, ms);
    set.add(finish);
  });
  return {
    /**
     * 사건 생성 즉시 pending(이름 조회·중앙 요청보다 먼저). 새로 만들었을 때만 "new" — 부르는 쪽은 "new" 일 때만 보낸다.
     * 이미 있으면 그 판정(진행 중 pending · phone · pc), 앞 프로세스가 남긴 pending 이면 "stale"(부르는 쪽이 finish 로 pc 로 굳힌다)
     */
    begin: (key: string) => run(async (): Promise<"new" | "pending" | "stale" | "phone" | "pc"> => {
      const e = entries.get(key);
      if (e) return e.decision === "pending" ? (live.has(key) ? "pending" : "stale") : e.decision;
      await write({ type: "pd", key, state: "pending", at: now() });
      live.add(key);
      return "new";
    }),
    /** 중앙이 증명한 앱 수신 — pending 일 때만 phone 으로(이미 pc·해결이면 거절) */
    commitPhone: (key: string, deliveryId: string) => run(async () => {
      const e = entries.get(key);
      if (!e || e.resolved || e.decision === "pc") return { committed: false, state: !e ? "none" : e.resolved ? "resolved" : e.decision };
      if (e.decision !== "phone") await write({ type: "pd", key, state: "phone", deliveryId, at: now() });
      return { committed: true, state: "phone" };
    }),
    /** 게이트가 그 배달을 허락하지 않았다고 답함 — 그 배달로 정한 phone 만 거둔다(→ pc) */
    voidPhone: (key: string, deliveryId: string, _reason: string) => run(async () => {
      const e = entries.get(key);
      if (e?.decision !== "phone" || e.deliveryId !== deliveryId) return false;
      await write({ type: "pd", key, state: "void", deliveryId, at: now() });
      return true;
    }),
    /** 남은 pending 을 pc 로 굳히고 최종 판정을 돌려준다(phone 이면 그대로) */
    decidePc: (key: string, _reason: string) => run(async () => {
      const e = entries.get(key);
      if (!e || e.decision === "pending") await write({ type: "pd", key, state: "pc", at: now() });
      return entries.get(key)!.decision === "phone" ? "phone" as const : "pc" as const;
    }),
    /** 판정 흐름 끝 — 남은 pending 은 pc 로 */
    finish: async (key: string) => {
      live.delete(key);
      return run(async () => {
        if (entries.get(key)?.decision === "pending") await write({ type: "pd", key, state: "pc", at: now() });
      });
    },
    /** 질문 답함·턴 시작·보관 — 해결 표식(판정은 바꾸지 않는다) */
    resolve: (key: string) => run(async () => {
      const e = entries.get(key);
      if (e && !e.resolved) await write({ type: "pd", key, state: "resolved", at: now() });
    }),
    known: (key: string) => run(async () => entries.has(key)),
    /**
     * PC 소리를 내도 되는가. 이 프로세스가 판정 중이면 끝날 때까지(최대 capMs) 기다린 뒤, pending·없음이면 pc 로 굳히고 true,
     * phone 이면 false. 소리가 알림보다 먼저 와도 pc 로 굳혀 늦은 폰 허락을 막는다.
     */
    async allowPc(key: string, capMs: number): Promise<boolean> {
      const until = Date.now() + capMs;
      while (live.has(key) && entries.get(key)?.decision === "pending") {
        const left = until - Date.now();
        if (left <= 0) break;
        await waitFor(key, left);
      }
      return run(async () => {
        const e = entries.get(key);
        if (!e || e.decision === "pending") {
          await write({ type: "pd", key, state: "pc", at: now() });
          live.delete(key);
          return true;
        }
        return e.decision === "pc";
      });
    },
  };
}
export type PushDisposition = ReturnType<typeof createPushDisposition>;
/** 소리 확인 ↔ 폰 푸시 연결(push.ts soundPushLink 가 만든다). central() = 이 기기가 중앙 경로인가 */
export type SoundPushLink = {
  disposition: PushDisposition;
  central(): Promise<boolean>;
  keyOf(agentId: string, kind: "question" | "compact", nativeId: string): string | null;
  pcWaitCapMs: number;
};

/**
 * 소리 확인(soundOriginValidate RPC) 안에서 중앙 판정을 기다리는 마감 — 요청을 받은 때부터 15초(10-18 2차, 구현 세부 값).
 * 데몬 플러그인 요청 한도가 30초다(Paseo 0.11.4 설치본 app.asar 의 플러그인 host REQUEST_TIMEOUT_MS = 30000 — 넘으면 'Plugin RPC timed out').
 * 기다림 뒤의 다시 검사(대화 새로 읽기·차례 확인)와 판정 기록 쓰기에 나머지 절반을 남긴다. 예전에는 pushCore PC_WAIT_CAP_MS(23초)를 그대로 기다려
 * 앞뒤 검사까지 더하면 30초에 닿을 수 있었고, 시간 초과면 화면이 소리 대기열 연결을 끊는다(client/presentation/soundPlayback.ts 의 catch → failed).
 * 마감에 닿으면 pc 로 굳힌다 — 늦은 폰 허락은 게이트가 거절하므로(commitPhone 거절 → commit pc) 이중 울림은 없고, 그 알림은 PC 가 울린다.
 * 직발송(legacy) 기기는 이 기다림을 타지 않는다.
 */
export const SOUND_VALIDATE_WAIT_MS = 15_000;

export function createSoundOrigins(file = soundDataFile("sound-origin-v2.jsonl"), tookByPhone: typeof phoneTook = phoneTook, push?: SoundPushLink, validateWaitMs = SOUND_VALIDATE_WAIT_MS) {
  const cycles = new Map<string, Cycle>();
  const skipped = new Set<string>();
  const journal = new SoundJournal<Cycle | { type: "skip"; eventId: string }>(file, (value) => {
    if ("type" in value) { if (value.type !== "skip" || typeof value.eventId !== "string") throw new Error("발생 폐기 기록 오류"); skipped.add(value.eventId); return; }
    const r = value;
    if (typeof r.key !== "string" || !Number.isSafeInteger(r.cycle) || r.cycle < 0 || typeof r.high !== "boolean") throw new Error("소리 발생 기록 형식 오류");
    cycles.set(r.key, r);
  });
  // 줄에 세운다 — 5초 넘게 기다렸으면 진단에 남긴다(10-22 요청 시간 초과 조사, server/diagStall.ts). 순서·계산은 그대로
  const QUEUE_WAIT_LOG_MS = 5_000;
  const queued = <R>(what: string, run: () => Promise<R>): Promise<R> => {
    const at = Date.now();
    return journal.serial(() => {
      const waited = Date.now() - at;
      if (waited > QUEUE_WAIT_LOG_MS) waitedLong(`sound queue ${what}`, waited);
      return run();
    });
  };
  // 사용량 관찰은 화면마다(PC·서버 화면이 같은 플러그인에) 같은 대화를 거의 동시에 보낸다 — 줄에서 아직 시작하지 않은 같은 대화 관찰이
  // 있으면 그 결과를 같이 쓴다. 시작한 뒤에 온 것은 새로 줄 선다(그사이 바뀐 사용량을 놓치지 않게). 판정 계산(sample)은 그대로다(10-22)
  const observing = new Map<string, Promise<{ ok: boolean }>>();
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
  // Claude 계열 대화(Paseo 설정 extends === "claude" 인 공급자 — 판정은 server/account.ts baseOf 한 곳, 10-18 정리)만
  // 대화 기록을 읽어 차례 끝을 가린다. 앞 단계(index.server.ts checkSession)·생각 경계(thinkingBoundary.ts)와 같은 판정이다
  const claudeSession = (a: PaseoAgent) => (baseOf(a.provider) && a.persistence?.sessionId) || null;
  // 압축 준비(10-15 — 체크포인트 보고로 끝난 차례는 끝남 대신 compact)는 10-24 리규형님 버튼 "폰 알림 없애고 보통 끝남 소리로"로 없앴다 —
  // 압축 명령은 플러그인이 1분 뒤 대신 넣어(autoCompact.ts) 사람이 할 일이 없다. 보고 차례도 보통 끝남이고 compact 사건은 만들지 않는다(옛 사건은 무효)
  const valid = async (a: PaseoAgent, kind: SoundKind, nativeId: string, cfg: Config, cycle: number, paseo: PaseoApi) => {
    if (a.archivedAt || a.status === "closed") return false;
    // 허락 요청은 종류와 상관없이 질문이다 — 도구 사용 허락 포함(10-21 리규형님 "똑같이 질문으로 소리", client/presentation/judge.ts 와 같은 뜻).
    // 다시 알린 질문(10-24 — 번호 끝 ":r<회차>")은 표시를 떼고 원래 질문이 아직 떠 있는지 본다
    // 같이 보기 팀원 답글(10-25 "질문처럼 소리") — 번호 "share-<답글>" 은 아직 넣거나 닫지 않은 답글일 때만
    if (kind === "question") {
      const reply = shareReplyOf(nativeId);
      if (reply !== null) return shareReplyPending(a.id, reply);
      const id = baseQuestionId(nativeId);
      return a.pendingPermissions.some((p) => p.id === id);
    }
    if (kind === "completion" || kind === "compact") {
      if (a.status !== "idle" || !a.lastUserMessageAt || await completionId(paseo, a) !== nativeId || a.pendingPermissions.length > 0) return false;
      const s = claudeSession(a);
      if (s && await lastTurnCommandOnly(s)) return false;
      return kind === "completion";
    }
    if (kind === "workflow") return true; // 번호는 스캐너가 실제 완료 항목에서 준다.
    const p = percent(a);
    return nativeId === String(cycle) && p !== null && p >= (kind === "danger" ? cfg.dangerPercent : cfg.warningPercent);
  };
  return {
    observe(agentId: string, cfg: Config, paseo: PaseoApi) {
      const waiting = observing.get(agentId);
      if (waiting) return waiting;
      const next = queued("observe", async () => {
        if (observing.get(agentId) === next) observing.delete(agentId); // 시작했다 — 이 뒤에 온 관찰은 새로 줄 선다
        const a = await fresh(paseo, agentId); if (!a) return { ok: false }; await sample(a, cfg); return { ok: true };
      });
      observing.set(agentId, next);
      void next.finally(() => { if (observing.get(agentId) === next) observing.delete(agentId); }).catch(() => undefined);
      return next;
    },
    prepare(input: Config & { agentId: string; kind: SoundKind; nativeId: string }, paseo: PaseoApi) {
      return queued("prepare", async (): Promise<{ event: RoutedSoundEvent | null }> => {
        const a = await fresh(paseo, input.agentId); if (!a) return { event: null };
        const cycle = await sample(a, input);
        if (input.kind === "completion" && (!a.lastUserMessageAt || input.nativeId !== a.lastUserMessageAt)) return { event: null };
        const nativeId = input.kind === "completion" ? await completionId(paseo, a)
          : input.kind === "warning" || input.kind === "danger" ? String(cycle) : input.nativeId;
        const kind: SoundKind = input.kind;
        if (!nativeId || !await valid(a, kind, nativeId, input, cycle, paseo)) return { event: null };
        const { serverId } = await hostIdentity(); if (!serverId) throw new Error("발생 데몬 번호 미확인");
        const eventId = JSON.stringify(["sound-v2", serverId, kind === "workflow" ? "workflow" : incarnation(a), kind, nativeId]);
        if (skipped.has(eventId)) return { event: null };
        const directory = await directoryOf(paseo, a);
        // 프로젝트에서 끈 소리(10-24 리규형님 — 무인 프로젝트 소리 끄기 · 폰으로도 안 나감)는 사건을 아예 만들지 않는다. 질문은 끌 수 없다
        if (kind !== "question" && (await mutedKindsOf(directory)).includes(kind as MutableSoundKind)) {
          console.log(`[sound-v2] ${kind} ${a.id.slice(0, 8)}: muted for this project — no sound anywhere`);
          return { event: null };
        }
        return { event: {
          eventId,
          originHostId: serverId, agentId: a.id, kind, nativeId,
          directory, projectKey: null,
        } };
      });
    },
    drop(eventId: string) {
      return queued("drop", async () => {
        const { serverId } = await hostIdentity();
        const key: unknown = JSON.parse(eventId);
        if (!Array.isArray(key) || key[0] !== "sound-v2" || key[1] !== serverId) return { ok: false };
        if (!skipped.has(eventId)) { await journal.append({ type: "skip", eventId }); skipped.add(eventId); }
        return { ok: true };
      });
    },
    async validate(event: RoutedSoundEvent, cfg: Config, paseo: PaseoApi) {
      const started = Date.now();
      const check = () => queued("validate", async () => {
        const a = await fresh(paseo, event.agentId); if (!a) return { valid: false };
        const { serverId } = await hostIdentity();
        const expected = JSON.stringify(["sound-v2", serverId, event.kind === "workflow" ? "workflow" : incarnation(a), event.kind, event.nativeId]);
        if (skipped.has(event.eventId) || event.eventId !== expected || serverId !== event.originHostId) return { valid: false };
        return { valid: await valid(a, event.kind, event.nativeId, cfg, await sample(a, cfg), paseo) };
      });
      const r = await check();
      // 중앙 경로(10-18): 그 알림의 판정이 이미 있거나 이 기기가 central 이면 내구 판정을 따른다 — phone 이면 PC 조용,
      // pc 로 굳힐 수 있을 때만 울린다. 기다린 뒤에는 지금 질문·차례가 아직 살아 있는지 다시 본다(Codex D-2 "기다림 후에 다시 검사").
      // 압축 준비는 정확한 차례 번호로만 잇는다(그 대화의 마지막 압축 준비 알림으로 물러서지 않는다)
      if (r.valid && push && (event.kind === "question" || event.kind === "compact")) {
        const key = push.keyOf(event.agentId, event.kind, event.nativeId);
        // 직발송(legacy) 기기에서는 판정 기록을 못 읽어도(손상) 지금 동작 그대로 간다 — 중앙에서 바꿔 온 직후의 알림만 판정 기록을 따른다
        const central = await push.central();
        if (key && (central || await push.disposition.known(key).catch(() => false))) {
          // 기다림 상한 = 중앙 판정 최대(pcWaitCapMs)와 이 요청의 남은 마감(받은 때부터 validateWaitMs — 앞 검사에 쓴 시간을 뺀다) 중 작은 쪽
          const capMs = Math.min(push.pcWaitCapMs, Math.max(0, started + validateWaitMs - Date.now()));
          if (!await push.disposition.allowPc(key, capMs)) {
            console.log(`[sound-v2] ${event.kind} ${event.agentId.slice(0, 8)}: phone took it (central) — PC stays quiet`);
            return { valid: false };
          }
          return check();
        }
        if (!key && central) return r; // 차례 번호 없는 압축 준비 — 중앙 경로는 그 알림을 보내지 않았다(push.ts)
      }
      // 폰 알림을 보냈고 폰 앱이 받았다고 답했으면 PC 는 울리지 않는다(10-17 리규형님 — 질문지·압축 준비만, 답은 3초까지 기다림 push.ts phoneTook).
      // 기다림은 순서 대기열 밖에서 — 안에서 기다리면 다른 소리 확인까지 밀린다
      if (r.valid && (event.kind === "question" || event.kind === "compact") && await tookByPhone(event.agentId, event.kind, event.nativeId)) {
        console.log(`[sound-v2] ${event.kind} ${event.agentId.slice(0, 8)}: phone received the push — PC stays quiet`);
        return { valid: false };
      }
      return r;
    },
  };
}
