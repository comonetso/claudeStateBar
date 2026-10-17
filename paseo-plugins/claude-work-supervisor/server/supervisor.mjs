// 감독자 — 등록한 대화(Mesa)가 할 일이 남았는데 멈추지 않게 지켜본다(10-16 리규형님 "쉬지 않게" · docs/paseo-plugin-tools/NONSTOP_IMPL_SPEC.md §5).
// 09:51 사고의 뿌리: 계정을 넘기는 장치만 있고, 할 일이 남았는지 보고 다음 실행을 책임지는 주체가 없었다.
// 판단에 모델을 부르지 않는다. 파일(claude-work/)과 Paseo 상태만 본다.
// 🔴 자동 깨우기(autoSend)는 리규형님 확인 전엔 꺼져 있다(기획 §4 — 기록 모드로 지켜본 뒤 켬). 꺼져 있으면 "깨웠을 것"을 기록하고 폰으로 알린다.
// decideAgent 는 순수 함수다(시험이 같은 것을 쓴다). createSupervisor 가 이벤트·파일 변화·기한 타이머로 판단을 부르고 결과를 실행한다.
import { mkdirSync, readdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alive, appendEvent, forgetAgent, listTransitions, missingFields, paths, pruneTransitions, readJson, readRegistry, removeFile,
  sameWindow, TRANSITION_OPEN, validId, writeJson, writeTransition } from "./workstate.mjs";

/**
 * 다시 볼 간격·횟수 — 기획 §4 "일시 오류 5·10·15분 세 번"(Claude 선택 값, 실측 뒤 조정). 이행이 멈췄는지 확인·결과 모르는 말의 재확인에도 같은 값을 쓴다
 */
export const RECHECK_MS = 300_000;
export const RECHECK_MAX = 3;
/** 이행 한 단계의 최대 시간 — 넘기면 주인이 살아 있어도 멈춘 것으로 보고 넘겨받는다. 재확인 간격 × 횟수(15분, 기존 Claude 선택 값의 합) */
export const STAGE_MAX_MS = RECHECK_MS * RECHECK_MAX;
/** 기획 §4 무진척 — 감독자가 깨운 턴이 결과 증거 없이 두 번 이어 끝나면 보류(Claude 선택 값) */
export const NO_PROGRESS_MAX = 2;
/** 턴 이벤트 대기열 상한 — 판단이 막혀도 메모리에 끝없이 쌓이지 않게(오래된 것부터 버림) */
export const EVENTS_QUEUE_MAX = 50;
export const WAKE_MARK = "[supervisor]";
/** kicker(resume-kicker.mjs)가 넣는 이어 달리기 말의 머리 — rotation.mjs RESUME_PROMPT 와 같아야 한다 */
export const RESUME_MARK = "[rotation] 자동 이어 달리기";

/** 권한 창·질문지에 답이 없을 때 거절까지 기다리는 시간 — 리규형님 10-16 19:4x "일정시간이란 5분정도" */
export const PERMISSION_WAIT_MS = 5 * 60_000;
/** 멈춤이 이만큼 이어질 때만 알리고 깨운다 — 리규형님 10-16 22:4x "30초 이어질 때만"(일하는 중 1초 안쪽 틈을 멈춤으로 본 알림이 22:27·22:33 두 번 나갔다) */
export const STOP_SETTLE_MS = 30_000;
const WORK_CLI = join(homedir(), "paseo-plugins", "claude-rc-relay", "work-cli.mjs");
/** 자동 거절 이유 — Claude 에게 간다 */
export function denyText(kind) {
  const ask = `node ${WORK_CLI} set --state ready --next "답 없이 할 다음 조각" --question "물을 것"`;
  return kind === "question" || kind === "plan"
    ? `${WAKE_MARK} 사람이 5분 안에 답하지 않아 감독자가 이 질문을 닫았다(무중단 대화). 질문은 장부에 적으면 폰으로 알린다: ${ask} — 답 없이 할 수 있는 일을 계속한다.`
    : `${WAKE_MARK} 사람이 5분 안에 답하지 않아 감독자가 이 요청을 거절했다(무중단 대화). 되살릴 수 있는 방법(git stash·git revert·파일을 백업한 뒤 고쳐 쓰기)으로 같은 일을 하고, `
      + `목록에 안 걸리는 다른 파괴 명령으로 바꿔 쓰지 않는다. 꼭 필요하면 장부에 질문으로 적고(${ask}) 답 없이 할 수 있는 일을 계속한다.`;
}

export function wakeText(why) {
  return `${WAKE_MARK} 자동 이어가기 — 사람 말이 아니라 감독자(claude-work-supervisor)가 넣은 말이다(${why}). `
    + "장부를 확인하고(work-cli.mjs show) 다음 조각을 이어서 한다. 기다릴 이유가 있으면 장부 상태를 바꾼 뒤 끝낸다. 리규형님께는 감독자가 깨웠다는 것을 한 줄 알린다.";
}

/**
 * 지금 좌석이 막혀 깨워도 소용없는 동안 — 다시 볼 시각(ms), 막히지 않았으면 0.
 * 실행기가 "넘길 곳 없음"으로 남긴 다음 시각(다른 좌석이 먼저 풀리는 시각)이 더 이르면 그때 깨운다 —
 * 깨우면 지금 좌석이 거절하고 실행기가 풀린 좌석으로 넘긴다
 */
export function providerBlockedUntil(observe, nowMs) {
  if (!observe) return 0;
  const seat = observe.seats?.[observe.provider];
  const own = Math.max(observe.limited && typeof observe.limitReset === "number" ? observe.limitReset * 1000 : 0,
    seat?.status === "limit" && typeof seat.resetsAt === "number" ? seat.resetsAt * 1000 : 0);
  if (own <= nowMs) return 0;
  const d = observe.decision;
  const other = d?.reason === "no_target" && typeof d.nextAt === "number" ? d.nextAt * 1000 : 0;
  return other > nowMs && other < own ? other : own;
}

/** 지금 좌석이 막혔던 기록(한도 거절·limit 관측)이 남아 있는지 — providerBlockedUntil 이 0 이면 그 시각은 이미 지났다 */
export function seatWasBlocked(observe) {
  if (!observe) return false;
  const seat = observe.seats?.[observe.provider];
  return (observe.limited === true && typeof observe.limitReset === "number") || (seat?.status === "limit" && typeof seat.resetsAt === "number");
}

/**
 * 한 대화의 판단 — 순수 함수. 돌려주는 값 { status, reason, dueAt(ms, 0 = 없음), actions }
 * actions: {t:"notify", key, title, body} · {t:"transition", tid, patch} · {t:"wake", why} · {t:"hold", reason} · {t:"outbox", patch} ·
 *          {t:"perm_seen", id, at}(권한 요청을 처음 봄) · {t:"deny", id, message}(답 없어 거절) · {t:"stop_seen", key, at}(멈춤을 처음 봄)
 * c: now · snap(Paseo 상태: status·activeTurn·pendingPermissions·archivedAt) · work/workError · observe · relayAlive(실행기 생존) ·
 *    transitions · ownerAlive(t) · sv(감독자 기록) · autoSend · seenResume(Set tid) · seenWake(bool) · lastFailedAt(ms) · settleMs(멈춤 대기, 시험용)
 */
export function decideAgent(c) {
  const { now, snap, work, workError, observe, relayAlive = false, transitions = [], ownerAlive = () => false, sv = {}, autoSend = false,
    seenResume = new Set(), seenWake = false, lastFailedAt = 0, settleMs = STOP_SETTLE_MS } = c;
  const actions = [];
  const out = (status, reason, dueAt = 0) => ({ status, reason, dueAt, actions });
  const notify = (key, title, body) => actions.push({ t: "notify", key, title, body });
  if (!snap) return out("unknown_agent", "Paseo 상태를 읽지 못했다", now + RECHECK_MS);
  if (snap.archivedAt) return out("archived", "보관됨");
  const running = !!snap.activeTurn || snap.status === "running" || snap.status === "initializing";

  // 1) 넘김 이행 — 주인이 살아 있으면 손대지 않는다. 주인이 없어졌으면 넘겨받는다(무중단 기획 §3-4 이행 전이)
  for (const t of transitions.filter((x) => TRANSITION_OPEN.includes(x.state))) {
    // 주인이 살아 있으면 먼저 — 99% 강제 넘김은 Claude 가 실행 중일 때 준비(prepared)된다.
    // 단 살아 있어도 한 단계에 STAGE_MAX_MS 를 넘기면 멈춘 것으로 보고 넘겨받는다(Codex 리뷰 261016_182309 — 응답 없는 paseo 명령에 무기한 대기)
    const since = Date.parse(t.updatedAt ?? t.createdAt ?? "");
    const stale = Number.isFinite(since) && now - since > STAGE_MAX_MS;
    if (t.state !== "unknown" && !stale && ownerAlive(t)) {
      return out("transition", `${t.state} — ${t.owner} 진행 중`, Math.min(now + RECHECK_MS, (Number.isFinite(since) ? since : now) + STAGE_MAX_MS + 1000));
    }
    const why = stale ? "stage-expired" : "owner-gone";
    if (t.state === "prepared") { actions.push({ t: "transition", tid: t.tid, patch: { state: "aborted", by: "supervisor", why } }); continue; }
    if (running) { actions.push({ t: "transition", tid: t.tid, patch: { state: "admitted", by: "supervisor-running" } }); continue; }
    if (t.state === "committed") { actions.push({ t: "transition", tid: t.tid, patch: { state: "failed", by: "supervisor", why: stale ? why : "kicker-missing" } }); continue; }
    // dispatching(보내다 끊김)·unknown — 보냈는지 모른다. 대화 기록에서 이 이행 번호가 붙은 이어 달리기 말을 찾고,
    // 없으면 다시 볼 시각(checkAt)에만 한 번씩 재확인한다 — 파일 변화 알림마다 기회를 줄이면 0.02초 만에 다 썼다(Codex 리뷰). 다 쓰면 보류(다시 보내지 않는다)
    if (seenResume.has(t.tid)) { actions.push({ t: "transition", tid: t.tid, patch: { state: "admitted", by: "supervisor-timeline" } }); continue; }
    const checkAt = Date.parse(t.checkAt ?? "");
    if (t.state === "unknown" && Number.isFinite(checkAt) && now < checkAt) return out("transition", "넘긴 뒤 이어 달리기 결과 모름 — 다시 볼 시각 대기", checkAt);
    const left = typeof t.reconcileLeft === "number" ? t.reconcileLeft : RECHECK_MAX;
    if (left > 0) {
      actions.push({ t: "transition", tid: t.tid, patch: { state: "unknown", reconcileLeft: left - 1, checkAt: new Date(now + RECHECK_MS).toISOString() } });
      return out("transition", "넘긴 뒤 이어 달리기 결과 모름 — 대화 기록으로 다시 확인", now + RECHECK_MS);
    }
    actions.push({ t: "transition", tid: t.tid, patch: { state: "lost", by: "supervisor", why: "unconfirmed" } });
    actions.push({ t: "hold", reason: "넘긴 뒤 이어 달리기 확인 불가" });
    notify(`lost:${t.tid}`, "판별 불가", "좌석을 넘긴 뒤 이어 달리기 말이 들어갔는지 확인하지 못했습니다. 대화를 확인해 주세요.");
    return out("hold", "넘긴 뒤 이어 달리기 확인 불가");
  }

  // 2) 권한 창·질문지 — bypass 여도 ask 규칙·핵심 경로 삭제·질문 버튼은 사람 답을 기다린다(공식 문서 permission-modes "Actions no mode auto-approves").
  //    대부분은 도구 문지기(claude-rc-relay/tool-gate.mjs)가 미리 막는다 — 여기는 놓친 것. 그동안 Paseo 는 실행 중으로 보이므로 실행 중보다 먼저 본다.
  //    권한 창은 폰으로 알리고(질문·계획 승인은 claude-state-bar 폰 푸시가 이미 알린다 — 겹치지 않게 뺀다, 리규형님 10-16 19:3x),
  //    처음 본 뒤 PERMISSION_WAIT_MS 안에 답이 없으면 거절하고 Claude 에게 다른 길을 알려 준다(리규형님 10-16 19:4x "5분 정도" · "자동 거절하고 다른 길로 계속").
  //    알림에는 도구 이름만 — 명령 원문은 비밀값이 섞일 수 있어 폰으로 보내지 않는다
  const perms = (Array.isArray(snap.pendingPermissions) ? snap.pendingPermissions : []).filter((r) => r && r.id);
  if (perms.length) {
    const seen = sv.perms ?? {};
    for (const r of perms) if (!seen[r.id]) actions.push({ t: "perm_seen", id: r.id, at: now });
    const until = (r) => (seen[r.id]?.at ?? now) + PERMISSION_WAIT_MS;
    const expired = perms.filter((r) => now >= until(r));
    const tryable = expired.filter((r) => (seen[r.id]?.denyTries ?? 0) < RECHECK_MAX);
    const name = (r) => String(r.name ?? r.kind ?? "?").slice(0, 40);
    if (tryable.length) {
      for (const r of tryable) actions.push({ t: "deny", id: r.id, message: denyText(r.kind) });
      notify(`permdeny:${tryable.map((r) => r.id).join(",")}`, "자동 거절함", `5분 안에 답이 없어 ${tryable.map(name).join(", ")} 요청을 거절했습니다. Claude 는 다른 방법으로 계속합니다.`);
      return out("permission", "답이 없어 자동 거절", now + RECHECK_MS);
    }
    if (expired.length) {
      notify(`permstuck:${expired.map((r) => r.id).join(",")}`, "판별 불가", "자동 거절이 되지 않았습니다. 화면에서 권한 창을 확인해 주세요.");
      return out("permission", "자동 거절 실패");
    }
    const next = Math.min(...perms.map(until));
    const tool = perms.find((r) => !["question", "plan"].includes(r.kind));
    if (tool) {
      notify(`perm:${tool.id}`, "권한 대기", `도구 ${name(tool)} 가 승인을 기다립니다. 5분 안에 답이 없으면 자동으로 거절합니다.`);
      return out("permission", "권한 창 대기", next);
    }
    return out("permission", "질문·계획 승인 대기", next);
  }
  // 3) 보류·실행 중
  if (sv.hold) return out("hold", sv.hold.reason);
  if (running) return out("running", "실행 중");
  // 실행기가 받은 말을 아직 처리 중이거나(입력 뒤 결과 전) 막 떠서 첫 말을 기다리는 중 — Paseo 상태가 잠깐 쉼으로 보이는 틈이다
  // (10-16 19:15 넘김 직후 새 실행기가 첫 관측을 쓴 순간 "멈춤"으로 오판). 그 시각부터 RECHECK_MS 안에서만 믿는다(결과가 영영 안 오면 다시 판단)
  if (relayAlive && observe?.main?.done === false) {
    const fed = (observe.input?.seq ?? 0) > 0;
    const base = fed ? Date.parse(observe.input?.at ?? "") : Number(observe.startedAtMs);
    if (Number.isFinite(base) && now < base + RECHECK_MS) return out("running", fed ? "실행기가 받은 말 처리 중" : "실행기 시작 — 첫 말 대기", base + RECHECK_MS);
  }
  // 메인 답이 끝난 뒤 백그라운드 작업 목록이 바뀌었다 = 작업이 끝났다 → Claude Code 가 완료 알림으로 곧 다음 턴을 연다. 그 틈도 멈춤이 아니다
  // (10-16 22:27:16 Mesa: 서브 작업이 끝난 순간 "멈춤 — 할 일 남음" 폰 알림이 나갔다가 0.1초 뒤 턴 시작으로 지워짐). 목록이 바뀐 때부터 RECHECK_MS 안에서만 믿는다
  if (relayAlive && observe?.main?.done === true) {
    const bgAt = Date.parse(observe.background?.at ?? ""), mainAt = Date.parse(observe.main?.at ?? "");
    if (Number.isFinite(bgAt) && Number.isFinite(mainAt) && bgAt > mainAt && now < bgAt + RECHECK_MS)
      return out("running", "백그라운드 작업이 끝남 — 완료 알림으로 다시 깨는 중", bgAt + RECHECK_MS);
  }

  // 4) 감독자가 보낸 말의 결과 — 확인 전엔 또 보내지 않는다. 다시 볼 시각(checkAt)에만 재확인, 다 쓰면 보류(사람 확인 전엔 다시 보내지 않는다)
  const ob = sv.outbox;
  if (ob && ["pending", "sent", "unknown"].includes(ob.state)) {
    if (seenWake) actions.push({ t: "outbox", patch: { state: "confirmed" } });
    else {
      const checkAt = Date.parse(ob.checkAt ?? "");
      if (Number.isFinite(checkAt) && now < checkAt) return out("wake_unconfirmed", "감독자가 보낸 말의 결과 모름 — 다시 볼 시각 대기", checkAt);
      const left = typeof ob.reconcileLeft === "number" ? ob.reconcileLeft : RECHECK_MAX;
      if (left > 0) {
        actions.push({ t: "outbox", patch: { state: "unknown", reconcileLeft: left - 1, checkAt: new Date(now + RECHECK_MS).toISOString() } });
        return out("wake_unconfirmed", "감독자가 보낸 말의 결과 모름 — 대화 기록으로 다시 확인", now + RECHECK_MS);
      }
      actions.push({ t: "outbox", patch: { state: "lost" } });
      actions.push({ t: "hold", reason: "감독자 말 확인 불가" });
      notify(`wakelost:${ob.wakeId}`, "판별 불가", "감독자가 보낸 이어가기 말이 들어갔는지 확인하지 못했습니다. 대화를 확인해 주세요.");
      return out("hold", "감독자 말 확인 불가");
    }
  }

  // 5) 장부
  if (workError || !work) {
    notify(`nowork:${observe?.runGen ?? "-"}:${observe?.input?.seq ?? "-"}`, "판별 불가", workError ? "장부 파일이 깨져 할 일을 알 수 없습니다." : "장부가 없어 할 일을 알 수 없습니다.");
    return out("no_work", workError ? "장부 깨짐" : "장부 없음");
  }
  // scheduled = 기다리던 시각이 된 깨우기(외부 작업 다시 볼 시각·막혔던 좌석이 풀린 시각) — autoSend 와 상관없이 깨운다.
  // 대화 Claude 가 스스로 깨우기 예약을 걸던 규칙을 장치로 옮긴 것(리규형님 10-16 19:5x "외부 작업 시각만 감독자가 자동으로"). 할 일 남은 멈춤은 그대로 autoSend 를 따른다
  const wake = (why, scheduled = false) => {
    // 사람이 마지막 말 뒤에 턴을 중단했다 — 사람 손에 있다. 다음 말이 올 때까지 알리지도 깨우지도 않는다(리규형님 10-16 22:4x)
    const cut = observe?.interrupt;
    if (relayAlive && observe?.main?.done === true && Number.isFinite(cut?.seq) && (observe.input?.seq ?? 0) === cut.seq) return out("human_stopped", "사람이 중단 — 다음 말까지 알리지 않음");
    // 정해 둔 시각의 깨우기가 아니면 멈춤이 settleMs 이어질 때만 — 같은 멈춤 = 같은 실행기·입력·메인 끝 시각·장부 판
    if (!scheduled && settleMs > 0) {
      const key = `${observe?.runGen ?? "-"}:${observe?.input?.seq ?? "-"}:${observe?.main?.at ?? "-"}:${work.rev ?? "-"}`;
      const seen = sv.stopSeen?.key === key ? Date.parse(sv.stopSeen.at ?? "") : NaN;
      if (!Number.isFinite(seen)) actions.push({ t: "stop_seen", key, at: now });
      const from = Number.isFinite(seen) ? seen : now;
      if (now < from + settleMs) return out("settling", `${why} — ${settleMs / 1000}초 이어지는지 보는 중`, from + settleMs);
    }
    if ((sv.noProgress?.count ?? 0) >= NO_PROGRESS_MAX) {
      actions.push({ t: "hold", reason: `진척 없는 깨움 ${sv.noProgress.count}번` });
      notify(`noprog:${work.rev}`, "멈춤 — 진척 없음", `감독자가 깨운 턴이 결과 없이 ${sv.noProgress.count}번 끝났습니다. 대화를 확인해 주세요.`);
      return out("hold", "진척 없음");
    }
    const key = `stop:${observe?.runGen ?? "-"}:${observe?.input?.seq ?? "-"}:${work.rev}`;
    if (!autoSend && !scheduled) {
      notify(key, "멈춤 — 할 일 남음", `${why} · 다음: ${String(work.next ?? work.task ?? "").slice(0, 150)}`);
      return out("would_wake", why);
    }
    if (lastFailedAt && now < lastFailedAt + RECHECK_MS) return out("retry_wait", "오류로 끝난 뒤 다시 볼 시각", lastFailedAt + RECHECK_MS);
    actions.push({ t: "wake", why });
    return out("waking", why);
  };
  switch (work.state) {
    case "paused": return out("paused", work.note ?? "멈춤");
    case "waiting_human": // 질문 알림은 상태와 따로 질문 칸이 보낸다(askNotice) — 턴이 시작돼도 지워지지 않게
      return out("human", "사람 답 대기");
    case "completed":
      notify(`done:${work.rev}`, "완료 주장 — 확인 대기", `기준: ${String(work.completed?.criteria ?? "").slice(0, 100)} · 증거: ${String(work.completed?.evidence ?? "").slice(0, 100)}`);
      return out("claimed_complete", "완료 주장");
    case "waiting_external": {
      const due = Date.parse(work.external?.recheckAt ?? "");
      if (!work.external?.ref || !Number.isFinite(due)) {
        notify(`invalid:${work.rev}`, "판별 불가", "외부 작업 대기인데 참조나 다시 볼 시각이 없습니다.");
        return out("invalid_work", "외부 대기 칸 빠짐");
      }
      return due > now ? out("waiting_external", work.external.ref, due) : wake("외부 작업을 다시 볼 시각", true);
    }
    case "waiting_provider": {
      const until = providerBlockedUntil(observe, now);
      if (until) return out("waiting_provider", "좌석 초기화 대기", until);
      // 막혔던 기록이 있고 그 시각이 지났을 때만 기다리던 깨우기로 본다 — 기록 없이 깨우면 같은 상태로 끝나기를 되풀이할 수 있다
      return seatWasBlocked(observe) ? wake("막혔던 좌석이 풀린 시각", true) : wake("좌석이 막힌 기록이 없음");
    }
    case "ready": {
      const miss = missingFields(work, now);
      if (miss.length) { notify(`invalid:${work.rev}`, "판별 불가", `장부 칸이 비었습니다: ${miss.join(", ")}`); return out("invalid_work", "장부 칸 빠짐"); }
      if (relayAlive && observe?.background?.waited > 0) return out("background", `서브에이전트·워크플로우 ${observe.background.waited}개 대기 — 끝나면 Claude 가 스스로 깬다`);
      const until = providerBlockedUntil(observe, now);
      if (until) return out("waiting_provider", "좌석 한도 — 초기화 대기", until);
      return wake("할 일이 남았는데 멈춤");
    }
    default:
      notify(`invalid:${work.rev}`, "판별 불가", `장부 상태를 모릅니다: ${work.state}`);
      return out("invalid_work", "장부 상태 모름");
  }
}

/**
 * 장부 질문 알림(폰 알림의 질문 칸) — 상태 알림과 따로 둔다. 질문 버튼 대신 장부에 적고 일을 계속하므로(리규형님 10-16 19:2x)
 * 턴이 시작돼도 지우지 않고, 질문이 지워질 때만 지운다. 돌려주는 값: { raise: { key, title, body } } 또는 { resolve: true }
 */
export function askNotice(work) {
  const q = work?.human?.question;
  if (typeof q !== "string" || !q.trim()) return { resolve: true };
  return { raise: { key: `ask:${work.human.askedAt ?? work.rev ?? "-"}`, title: work.state === "waiting_human" ? "사람 대기" : "사람 답 필요 — 일은 계속",
    body: q.slice(0, 200) } };
}

/** 대화 기록 항목에서 사람·자동 말(user_message)만 — 감독자 말·이어 달리기 말 확인용 */
const userTexts = (items) => (Array.isArray(items) ? items : []).filter((i) => i?.type === "user_message");

/**
 * api: { snapshot(id) → Promise<스냅샷|null>, timeline(id) → Promise<항목[]>, send(id, text, opts) → Promise }
 * push: { raise(agent, key, title, body), resolve(agentId) } — 실패해도 판단엔 영향 없음
 */
export function createSupervisor({ root, api, push, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  ownerAlive = (t) => (t.owner === "relay" ? alive(Number(String(t.runGen ?? "").split("-")[0])) : t.owner === "kicker" ? alive(Number(t.kickerPid)) : false),
  relayAlive = (observe) => !!observe && alive(Number(observe.pid)), watchFiles = true, settleMs = STOP_SETTLE_MS }) {
  const p = paths(root);
  // agentId → { busy, again, turnStartAt, lastFailedAt, events(턴 이벤트 대기열), dueHandled(판단에 넘긴 기한) } — 등록한 대화만 담는다
  const agents = new Map();
  const watchers = new Map();
  let timer = null, stopped = false, poolBusy = false, poolAgain = false;
  const st = (id) => {
    let s = agents.get(id);
    if (!s) { s = { busy: false, again: false, turnStartAt: 0, lastFailedAt: 0, events: [], dueHandled: null }; agents.set(id, s); }
    return s;
  };
  const readSv = (id) => readJson(p.supervisor(id)).value ?? { v: 1, agentId: id };
  /** 감독자 기록 쓰기 — 바뀐 게 없으면 쓰지 않는다. 성공(또는 같음)이면 true. 보낼 말(outbox)은 이 값을 확인한 뒤에만 보낸다 */
  const writeSv = (id, sv) => {
    const prev = readJson(p.supervisor(id)).value;
    const strip = (x) => JSON.stringify({ ...x, updatedAt: undefined });
    if (prev && strip(prev) === strip(sv)) return true;
    try { writeJson(p.supervisor(id), { ...sv, updatedAt: new Date(now()).toISOString() }); return true; }
    catch (e) { log(`supervisor state write failed ${id.slice(0, 8)}: ${e?.code ?? e}`); return false; }
  };
  const registered = () => { const r = readRegistry(root); return r.error ? null : r; };
  const isReg = (id) => Object.hasOwn(registered()?.agents ?? {}, id);
  const raise = (agent, key, title, body, slot) => void Promise.resolve(push?.raise(agent, key, title, body, slot))
    .catch((e) => log(`push failed ${agent.id.slice(0, 8)}: ${e?.message ?? e}`));

  // ── 기한 타이머 — 가장 이른 기한 하나만 건다. 이미 판단에 넘긴 기한은 판단이 새 기한을 쓰기 전까지 다시 걸지 않는다
  //    (지난 기한을 0ms 타이머로 거듭 걸어 판단이 끝나기 전까지 파일을 계속 읽었다 — Codex 리뷰 261016_182309) ──
  const arm = () => {
    if (timer) { clearTimer(timer); timer = null; }
    if (stopped) return;
    let next = Infinity;
    for (const id of Object.keys(registered()?.agents ?? {})) {
      const dueText = readSv(id).dueAt;
      const due = Date.parse(dueText ?? "");
      if (!Number.isFinite(due)) continue;
      const s = st(id);
      if (s.dueHandled === dueText) continue;
      if (due <= now()) { s.dueHandled = dueText; schedule(id, "due"); continue; }
      next = Math.min(next, due);
    }
    if (next === Infinity) return;
    timer = setTimer(() => { timer = null; arm(); }, Math.max(0, Math.min(next - now(), 2_147_000_000)));
    timer?.unref?.();
  };

  /**
   * 턴 이벤트를 감독자 기록에 적용한다 — 판단과 같은 차례 안에서만(판단 도중 들어온 취소 보류를 판단이 덮어쓰지 않게 — Codex 리뷰)
   * 보류 풀기(뒤의 사람 말) · 무진척 세기(감독자가 깨운 턴이 결과 증거 없이 ready 로 끝남 — 기다리는 상태로 끝나면 세지 않는다) ·
   * 오류 시각 · 출처 모르는 취소 보류
   */
  function applyEvents(id, sv, work) {
    const s = st(id);
    const notices = [];
    for (const ev of s.events.splice(0)) {
      const at = new Date(ev.at).toISOString();
      if (sv.hold && ev.inputKind === "human" && (sv.hold.seq == null || ev.runGen !== sv.hold.runGen || ev.inputSeq > sv.hold.seq)) {
        log(`hold released by human input ${id.slice(0, 8)}`); sv = { ...sv, hold: null, noProgress: { count: 0 } };
      }
      if (sv.outbox && ev.inputKind === "supervisor" && ["pending", "sent", "unknown", "confirmed"].includes(sv.outbox.state)) {
        const waiting = !!work && work.state !== "ready" && missingFields(work, ev.at).length === 0;
        let count = sv.noProgress?.count ?? 0;
        if (!waiting) count = (work?.progressAt ?? null) !== (sv.outbox.progressAtWake ?? null) ? 0 : count + 1;
        sv = { ...sv, outbox: { ...sv.outbox, state: "done", endedAt: at, outcome: ev.outcome }, noProgress: { count, at } };
      }
      if (ev.outcome === "failed" && !ev.expected) s.lastFailedAt = ev.at;
      if (ev.outcome === "canceled" && !ev.expected && !sv.hold) {
        const key = `cancel:${ev.runGen ?? "-"}:${ev.inputSeq ?? "-"}`;
        sv = { ...sv, hold: { reason: `출처 모르는 취소(${ev.reason})`, at, seq: ev.inputSeq, runGen: ev.runGen }, notified: { key, at } };
        notices.push({ agent: ev.agent, key, title: "보류 — 취소됨", body: "턴이 취소되어 감독자가 자동으로 이어가지 않습니다. 다시 시작하려면 말을 넣어 주세요." });
        log(`hold — canceled turn of unknown source ${id.slice(0, 8)}`);
      }
      sv = { ...sv, lastTurn: { outcome: ev.outcome, reason: ev.reason || null, endedAt: at, inputKind: ev.inputKind, expected: ev.expected } };
    }
    return { sv, notices };
  }

  // ── 판단 ──
  async function evaluate(id, why) {
    const reg = registered();
    if (!reg || !Object.hasOwn(reg.agents, id)) { agents.delete(id); return; }
    const w = readJson(p.work(id)), o = readJson(p.observe(id)).value ?? null;
    const transitions = listTransitions(root, id);
    let sv = readSv(id);
    // 사람이 명시적으로 보류를 푼다(work-cli resume — 요청 파일 하나만 남기고 감독자가 지운다)
    const resumeFile = `${p.supervisor(id)}.resume`;
    if (readJson(resumeFile).value) { if (sv.hold) log(`hold released by request ${id.slice(0, 8)}`); sv = { ...sv, hold: null, noProgress: { count: 0 } }; removeFile(resumeFile); }
    const applied = applyEvents(id, sv, w.value ?? null);
    sv = applied.sv;
    let snap = null;
    try { snap = await api.snapshot(id); } catch (e) { log(`snapshot failed ${id.slice(0, 8)}: ${e?.message ?? e}`); }
    // 풀린 권한 요청의 "처음 본 시각"은 지운다(쌓이지 않게)
    if (snap && sv.perms) {
      const live = new Set((Array.isArray(snap.pendingPermissions) ? snap.pendingPermissions : []).map((r) => r?.id).filter(Boolean));
      const kept = Object.fromEntries(Object.entries(sv.perms).filter(([k]) => live.has(k)));
      sv = { ...sv, perms: Object.keys(kept).length ? kept : null };
    }
    // 결과 모르는 이행·감독자 말 — 대화 기록에서 찾는다(필요할 때만 읽는다). 이어 달리기 말은 이 이행 번호가 붙은 것만 인정한다(Codex 리뷰)
    const needResume = transitions.filter((t) => ["dispatching", "unknown"].includes(t.state) || (t.state === "committed" && !ownerAlive(t)));
    const needWake = sv.outbox && ["pending", "sent", "unknown"].includes(sv.outbox.state);
    const seenResume = new Set();
    let seenWake = false;
    if (snap && (needResume.length || needWake)) {
      let items = [];
      try { items = userTexts(await api.timeline(id)); } catch (e) { log(`timeline failed ${id.slice(0, 8)}: ${e?.message ?? e}`); }
      for (const t of needResume) if (items.some((i) => String(i.text ?? "").includes(RESUME_MARK) && String(i.text ?? "").includes(`(이행 ${t.tid})`))) seenResume.add(t.tid);
      if (needWake) seenWake = items.some((i) => i.messageId === sv.outbox.wakeId || i.clientMessageId === sv.outbox.wakeId);
    }
    const s = st(id);
    const d = decideAgent({ now: now(), snap, work: w.value ?? null, workError: w.error ?? null, observe: o, relayAlive: relayAlive(o),
      transitions, ownerAlive, sv, autoSend: reg.autoSend, seenResume, seenWake, lastFailedAt: s.lastFailedAt, settleMs });
    const agentInfo = { id, workspaceId: snap?.workspaceId ?? null, cwd: snap?.cwd ?? "", label: reg.agents[id]?.label ?? null };
    for (const n of applied.notices) raise({ ...n.agent, label: agentInfo.label }, n.key, n.title, n.body);
    // 권한 창 알림은 턴 안에서 풀린다(새 턴 시작이 없다) — 풀린 판단이면 지운다. 이번 판단이 새 알림을 올리면 그 알림이 대신한다
    const permGone = d.status !== "permission" && String(sv.notified?.key ?? "").startsWith("perm:") && !d.actions.some((a) => a.t === "notify");
    // 실행
    for (const a of d.actions) {
      if (a.t === "transition") {
        const cur = transitions.find((t) => t.tid === a.tid);
        if (cur) {
          const closed = !TRANSITION_OPEN.includes(a.patch.state);
          try { writeTransition(root, id, { ...cur, ...a.patch, owner: "supervisor", ...(closed ? { closedAt: new Date(now()).toISOString() } : {}) }); }
          catch (e) { log(`transition write failed ${a.tid}: ${e?.code ?? e}`); }
          appendEvent(root, { kind: "transition", agentId: id, tid: a.tid, state: a.patch.state, owner: "supervisor", by: a.patch.by, why: a.patch.why });
          if (closed) pruneTransitions(root, id);
        }
      }
      if (a.t === "outbox") sv = { ...sv, outbox: { ...sv.outbox, ...a.patch } };
      if (a.t === "perm_seen") sv = { ...sv, perms: { ...(sv.perms ?? {}), [a.id]: { at: a.at, denyTries: 0 } } };
      if (a.t === "stop_seen") sv = { ...sv, stopSeen: { key: a.key, at: new Date(a.at).toISOString() } };
      if (a.t === "deny") { const cur = sv.perms?.[a.id] ?? { at: now() }; sv = { ...sv, perms: { ...(sv.perms ?? {}), [a.id]: { ...cur, denyTries: (cur.denyTries ?? 0) + 1 } } }; }
      if (a.t === "hold") sv = { ...sv, hold: { reason: a.reason, at: new Date(now()).toISOString(), seq: o?.input?.seq ?? null, runGen: o?.runGen ?? null } };
      if (a.t === "notify" && sv.notified?.key !== a.key) {
        sv = { ...sv, notified: { key: a.key, at: new Date(now()).toISOString() } };
        raise(agentInfo, a.key, a.title, a.body);
      }
    }
    if (permGone) { sv = { ...sv, notified: null }; void Promise.resolve(push?.resolve(id)).catch(() => {}); }
    // 멈춤이 풀렸으면 처음 본 시각을 지운다 — 다음 멈춤은 다시 30초를 센다
    if (sv.stopSeen && !["settling", "would_wake", "waking", "retry_wait"].includes(d.status)) sv = { ...sv, stopSeen: null };
    // 질문 칸 — 장부를 읽었고 보관되지 않았을 때만, 보낸 질문(sv.asked)과 달라질 때만 올리거나 지운다(상태 칸의 notified 와 같은 방식)
    if (!w.error && d.status !== "archived") {
      const ask = askNotice(w.value ?? null);
      if (ask.raise && sv.asked?.key !== ask.raise.key) {
        sv = { ...sv, asked: { key: ask.raise.key, at: new Date(now()).toISOString() } };
        raise(agentInfo, ask.raise.key, ask.raise.title, ask.raise.body, "ask");
      } else if (ask.resolve && sv.asked) {
        sv = { ...sv, asked: null };
        void Promise.resolve(push?.resolve(id, "ask")).catch(() => {});
      }
    }
    const logKey = `${d.status}|${d.reason}`;
    const fresh = sv.lastLogged !== logKey;
    sv = { ...sv, status: d.status, reason: d.reason, dueAt: d.dueAt ? new Date(d.dueAt).toISOString() : null, lastLogged: logKey };
    writeSv(id, sv);
    if (fresh) {
      log(`${id.slice(0, 8)} ${d.status} — ${d.reason}${d.dueAt ? ` (next ${new Date(d.dueAt).toISOString()})` : ""}`);
      appendEvent(root, { kind: "supervisor", agentId: id, status: d.status, reason: d.reason, dueAt: sv.dueAt, trigger: why });
    }
    // 자동 거절 — 시도 횟수를 먼저 저장한 뒤 보낸다(실패해도 다음 판단이 횟수를 안다). 결과는 permission_resolved 이벤트로 다시 판단된다
    for (const a of d.actions.filter((x) => x.t === "deny")) {
      try {
        if (typeof api.deny !== "function") throw new Error("deny not available");
        await api.deny(id, a.id, a.message);
        log(`denied ${a.id} for ${id.slice(0, 8)} — no answer within ${PERMISSION_WAIT_MS / 60_000} min`);
        appendEvent(root, { kind: "perm-deny", agentId: id, requestId: a.id, ok: true });
      } catch (e) {
        log(`deny failed ${a.id} for ${id.slice(0, 8)}: ${e?.message ?? e}`);
        appendEvent(root, { kind: "perm-deny", agentId: id, requestId: a.id, ok: false });
      }
    }
    if (d.actions.some((a) => a.t === "wake")) await sendWake(id, d.actions.find((a) => a.t === "wake").why, o, w.value);
  }

  /**
   * 자동 깨우기(autoSend 켜졌을 때만) — 보내기 직전에 다시 확인한다. 그사이 턴 이벤트가 들어왔으면 보내지 않는다(다음 판단이 먼저 적용).
   * 보낼 말(outbox)을 디스크에 저장하지 못하면 보내지 않는다 — 저장 없이 보내면 다음 판단·재시작이 모르고 또 보낸다(Codex 리뷰). 결과를 모르면 다시 보내지 않는다
   */
  async function sendWake(id, why, observe, work) {
    let snap = null;
    try { snap = await api.snapshot(id); } catch { /* 아래에서 그만둔다 */ }
    const ob = readJson(p.observe(id)).value;
    const blocked = st(id).events.length ? "그사이 턴 이벤트" : !snap ? "Paseo 상태 모름" : snap.activeTurn || snap.status === "running" ? "실행 중"
      : snap.pendingPermissions?.length ? "권한 대기"
      : listTransitions(root, id).some((t) => TRANSITION_OPEN.includes(t.state)) ? "넘김 이행 중"
      : (ob?.input?.seq ?? null) !== (observe?.input?.seq ?? null) || ob?.runGen !== observe?.runGen ? "그사이 새 입력" : null;
    if (blocked) { log(`wake skipped ${id.slice(0, 8)} — ${blocked}`); schedule(id, "wake-recheck"); return; }
    const wakeId = `sv-${id.slice(0, 8)}-${now()}`;
    const text = wakeText(why);
    let sv = readSv(id);
    sv = { ...sv, outbox: { wakeId, text, behavior: "steer", state: "pending", at: new Date(now()).toISOString(), why,
      progressAtWake: work?.progressAt ?? null, workRev: work?.rev ?? null, reconcileLeft: RECHECK_MAX,
      checkAt: new Date(now() + RECHECK_MS).toISOString() } };
    if (!writeSv(id, sv)) { log(`wake skipped ${id.slice(0, 8)} — outbox not saved`); return; }
    appendEvent(root, { kind: "wake", agentId: id, wakeId, why });
    try {
      await api.send(id, text, { activeTurnBehavior: "steer", messageId: wakeId });
      sv = { ...readSv(id) }; if (sv.outbox?.wakeId === wakeId && sv.outbox.state === "pending") sv.outbox = { ...sv.outbox, state: "sent" };
      log(`woke ${id.slice(0, 8)} (${why}) ${wakeId}`);
    } catch (e) {
      sv = { ...readSv(id) }; if (sv.outbox?.wakeId === wakeId) sv.outbox = { ...sv.outbox, state: "unknown", error: String(e?.message ?? e).slice(0, 200) };
      sv.dueAt = new Date(now() + RECHECK_MS).toISOString();
      log(`wake result unknown ${id.slice(0, 8)}: ${e?.message ?? e}`);
    }
    writeSv(id, sv);
    arm();
  }

  // 대화마다 한 번에 하나 — 판단 중에 또 오면 끝난 뒤 한 번 더
  function schedule(id, why) {
    if (stopped || !validId(id)) return;
    const s = st(id);
    if (s.busy) { s.again = why; return; }
    s.busy = true;
    setImmediate(async () => {
      try { await evaluate(id, why); } catch (e) { log(`evaluate failed ${id.slice(0, 8)}: ${e?.stack ?? e}`); }
      s.busy = false;
      arm();
      if (s.again && !stopped) { const again = s.again; s.again = false; schedule(id, again); }
    });
  }

  // ── 좌석 집계(pool.json) — 모든 관측 파일에서 좌석별 가장 새 관측. 비밀값 없음 ──
  function rebuildPool() {
    if (poolBusy) { poolAgain = true; return; }
    poolBusy = true;
    setImmediate(() => {
      try {
        const seats = {};
        let names = [];
        try { names = readdirSync(join(root, "observe")).filter((n) => n.endsWith(".json")); } catch { /* 없음 */ }
        for (const n of names) {
          const o = readJson(join(root, "observe", n)).value;
          for (const [sid, s] of Object.entries(o?.seats ?? {})) {
            if (!s || typeof s !== "object") continue;
            if (!seats[sid] || String(s.observedAt ?? "") > String(seats[sid].observedAt ?? "")) {
              seats[sid] = { pct: s.pct ?? null, resetsAt: s.resetsAt ?? null, observedAt: s.observedAt ?? null, status: s.status ?? null, source: s.source ?? null,
                ...(s.week ? { week: s.week } : {}), ...(s.limitType ? { limitType: s.limitType } : {}), ...(s.limitReset ? { limitReset: s.limitReset } : {}) };
            }
          }
        }
        const prev = readJson(p.pool).value;
        if (JSON.stringify(prev?.seats ?? null) !== JSON.stringify(seats)) writeJson(p.pool, { v: 1, updatedAt: new Date(now()).toISOString(), seats });
      } catch (e) { log(`pool rebuild failed: ${e?.code ?? e}`); }
      poolBusy = false;
      if (poolAgain && !stopped) { poolAgain = false; rebuildPool(); }
    });
  }

  // ── 파일 변화 — 장부·관측·이행이 바뀌면 그 대화를 다시 판단한다 ──
  function watchDir(dir, onName) {
    if (!watchFiles || watchers.has(dir)) return;
    try {
      mkdirSync(dir, { recursive: true });
      const w = watch(dir, (_event, name) => { if (!stopped) onName(name ? String(name) : null); });
      w.on("error", () => { watchers.delete(dir); });
      watchers.set(dir, w);
    } catch (e) { log(`watch failed ${dir}: ${e?.code ?? e}`); }
  }
  const idOf = (name) => (name && name.endsWith(".json") ? name.slice(0, -5) : null);
  function syncWatches() {
    const reg = registered();
    watchDir(join(root, "work"), (n) => { const id = idOf(n); if (id && reg?.agents && Object.hasOwn(registered()?.agents ?? {}, id)) schedule(id, "work"); });
    watchDir(join(root, "observe"), (n) => { rebuildPool(); const id = idOf(n); if (id && Object.hasOwn(registered()?.agents ?? {}, id)) schedule(id, "observe"); });
    watchDir(join(root, "supervisor"), (n) => { if (n && n.endsWith(".resume")) schedule(n.slice(0, -".json.resume".length), "resume"); });
    for (const id of Object.keys(reg?.agents ?? {})) watchDir(join(root, "transition", id), () => schedule(id, "transition"));
    // 등록에서 빠진 대화의 이행 감시는 닫는다
    for (const [dir, w] of watchers) {
      const m = /transition[\\/]([^\\/]+)$/.exec(dir);
      if (m && !Object.hasOwn(reg?.agents ?? {}, m[1])) { try { w.close(); } catch { /* 이미 닫힘 */ } watchers.delete(dir); }
    }
  }

  return {
    start() {
      mkdirSync(root, { recursive: true });
      watchDir(root, (n) => { if (n === "registry.json") { syncWatches(); for (const id of Object.keys(registered()?.agents ?? {})) schedule(id, "registry"); } });
      syncWatches();
      rebuildPool();
      for (const id of Object.keys(registered()?.agents ?? {})) schedule(id, "start");
    },
    onTurnStarted({ agent }) {
      const id = agent?.id;
      if (!validId(id) || !Object.hasOwn(registered()?.agents ?? {}, id)) return; // 등록한 대화만 기억한다(다른 대화로 Map 이 늘지 않게)
      st(id).turnStartAt = now();
      void Promise.resolve(push?.resolve(id)).catch(() => {});
      schedule(id, "turn_started");
    },
    onTurnEnded({ agent, outcome }) {
      const id = agent?.id;
      if (!validId(id) || !isReg(id)) return;
      const s = st(id);
      const o = readJson(p.observe(id)).value;
      // 이 턴 중에 실행기가 계정을 실제로 바꿔(committedAt) Claude 를 껐으면 예상한 종료다 — 무효가 된 넘김 시도(aborted)는 근거가 아니다(Codex 리뷰).
      // 턴 시작을 모르면(감독자가 다시 뜬 직후) 최근 RECHECK_MS 안의 것만 본다
      const since = (s.turnStartAt || now() - RECHECK_MS) - 1000;
      const expected = listTransitions(root, id).some((t) => t.committedAt && Date.parse(t.committedAt) >= since);
      s.events.push({ kind: "ended", outcome: outcome?.kind ?? null, reason: String(outcome?.reason ?? outcome?.error?.message ?? "").slice(0, 120),
        inputKind: o?.input?.kind ?? null, inputSeq: o?.input?.seq ?? null, runGen: o?.runGen ?? null, expected, at: now(),
        agent: { id, workspaceId: agent.workspaceId ?? null, cwd: agent.cwd ?? "" } });
      if (s.events.length > EVENTS_QUEUE_MAX) s.events.splice(0, s.events.length - EVENTS_QUEUE_MAX); // 판단이 멈춰도 끝없이 쌓이지 않게
      schedule(id, `turn_ended:${outcome?.kind ?? "?"}`);
    },
    onPermission({ agent }) { if (validId(agent?.id) && Object.hasOwn(registered()?.agents ?? {}, agent.id)) schedule(agent.id, "permission"); },
    onArchived({ agent }) {
      const id = agent?.id;
      if (!validId(id)) return;
      void Promise.resolve(push?.resolve(id, "all")).catch(() => {});
      agents.delete(id);
      // 등록한 대화는 장부를 남긴다(되살릴 수 있다). 그 밖의 대화는 관측 파일까지 지운다(쌓이지 않게)
      if (Object.hasOwn(registered()?.agents ?? {}, id)) { removeFile(p.observe(id)); removeFile(p.gate(id)); schedule(id, "archived"); }
      else forgetAgent(root, id);
      rebuildPool();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimer(timer); timer = null; }
      for (const w of watchers.values()) { try { w.close(); } catch { /* 이미 닫힘 */ } }
      watchers.clear();
      agents.clear();
    },
    // 시험용
    evaluate, schedule, rebuildPool, _agents: agents,
  };
}
