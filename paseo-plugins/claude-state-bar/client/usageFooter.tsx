import { onUiRole, uiProvider } from "./uiRole";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { onPageVisible, pageHidden } from "./pageVisible";
import { soundProvider } from "./sounds";
import { readAppFontSizes, readLocal, setNoTranslate, writeLocal } from "./web";
import { isTeamUsageSource } from "../shared/account";
import { usageFromReports } from "../shared/usageIdentity";
import { reportUsageDedupe, type UsageDedupeView } from "./health";

// 왼쪽 목록 칸 맨 아래에 Claude·Codex 사용량을 둔다(리규형님 10-05 결정 — Paseo 자체 "사용량" 줄은 눌러야 보인다).
// 10-09 부터 처음엔 접혀 요약 한 줄만 보이고, 올리고 내린 것을 기억한다(아래 UsageFooter).
// 값은 Paseo 데몬이 받아 둔 것을 쓴다(providers.listUsage). 표는 Paseo 가 주는 창 전부(10-07부터 — Fable 같은 모델별
// 주간 창 포함), 상단 단추 글자는 Paseo 가 요약에 쓰라고 표시한 창(summary)만.
// 같은 계정의 내장 Claude 카드와 우리 팀 카드가 겹치면 우리 팀 카드만 남긴다(10-18 C2 — 아래 readUsage). 묻기가 하나라서
// 왼쪽 아래 표·접힌 줄 요약·위쪽 사용량 단추·폰 알약(UsageTable)이 모두 같은 거른 목록을 그린다.

// 10-17: 30초마다 묻는다(읽기 실패하면 1분·2분, 받으면 30초) — 데몬이 기억한 값이라 바깥 조회는 Paseo 하던 대로 데몬이 5분에 한 번.
// 리규형님 "Paseo 하던 대로 두고 내가 원할 때 즉시 갱신" → 펼친 칸 머리의 갱신 아이콘을 누를 때만 "기억 건너뛰고 새로 받기"
// (web.ts forceUsageRefresh). 🔴 자동 강제는 하지 마라 — 30초마다 강제하자 개인 Claude 조회가 Anthropic 횟수 제한(429)으로 막혀
// 카드가 사라졌다(10-17 09:26). 묻을 때마다 개인 로그인 열쇠도 곧 만료면 데몬 플러그인이 미리 바꿔 둔다(keepLogin — 개인 계정을 쓰는
// Claude 가 없으면 열쇠가 만료돼 카드가 사라졌다, 10-17 09:40). 30초 간격이라 만료 1분 전 창을 놓치지 않는다. 가려진 화면은 묻지 않는다
const POLL_STEPS_MS = [30_000, 60_000, 120_000];
// 글자는 Paseo 설정의 "인터페이스 크기"(사이드바 줄과 같은 크기, 리규형님 10-05: "너무 작다, 인터페이스 크기와 같게").
// 못 읽으면 앱 웹 기본 14px. 설정을 바꾸면 몇 초 안에 따라온다
const UI_DEFAULT_PX = 14;
function useUiPx(): number {
  const [px, setPx] = useState(() => readAppFontSizes().ui ?? UI_DEFAULT_PX);
  useEffect(() => {
    const timer = setInterval(() => {
      const next = readAppFontSizes().ui ?? UI_DEFAULT_PX;
      setPx((prev) => (prev === next ? prev : next));
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  return px;
}

export type Usage = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["listUsage"]>>;
type Provider = Usage["providers"][number];
type Window = Provider["windows"][number];

/**
 * 사용량 — 30초마다 데몬에 묻는다(실패하면 1분·2분, 값은 데몬 기억). 왼쪽 아래 표와 오른쪽 위 사용량 단추(usageButton)가 같이 쓴다.
 * 소리 담당 호스트(이 PC)가 공급자로 올라와 있으면 그 데몬에 묻는다 — 서버 작업 공간의 단추도 같은 숫자를 보이게(10-06).
 * 아직 안 올라왔으면 이 호스트 데몬에 묻는다.
 * 묻기는 화면 전체에 하나만 돈다(10-15). 두 칸이 따로 1분씩 물으니 데몬이 새 값을 받은 직후 한쪽만 바뀌어
 * 리셋 직후 위 4%·아래 74% 처럼 달라 보였다 — 이제 한 번 받은 값을 모두가 같이 그린다
 */
type UsageSnap = { usage: Usage | null; error: string | null };
type UsageHub = {
  snap: UsageSnap; subs: Set<(s: UsageSnap) => void>;
  stop: (() => void) | null; force: (() => Promise<void>) | null;
  dedupe: UsageDedupeView;
};
// 연결마다 번들을 따로 평가하므로 화면 전체 상태는 globalThis에 둔다.
const usageHub = ((globalThis as { __claudeStateBar_usage_v2?: UsageHub }).__claudeStateBar_usage_v2 ??= {
  snap: { usage: null, error: null }, subs: new Set(), stop: null, force: null,
  dedupe: { mode: "legacy", hidden: 0, reason: null },
});

// 같은 계정 카드 두 장 거르기(10-18 C2 — 판정 규칙은 shared/usageIdentity). 거르려면 데몬 원본 보고(계정 열쇠가 든 보고 번호)가 있어야 해서
// 공급자가 usageReports 를 줄 때만 한다(그 데몬의 listUsageReports, 기억 건너뛰기 없음). 없거나(옛 판·이 판에서 못 함) 실패하면 예전처럼
// 옛 목록(providers.listUsage)을 그대로 써 두 장이 다 보인다 — 이름으로 대신 맞추지 않는다. 사용량과 판정이 늘 같은 데몬·같은 한 번의 묻기에서
// 나오므로 PC↔서버 담당이 바뀌어도 섞이지 않는다. 지금 어느 쪽으로 그렸는지는 usageDedupeState 로 보고, 설정 화면 기능 상태 칸에도 알린다
// (client/health.ts reportUsageDedupe — 못 한 이유: "no-provider" 공급자가 옛 판 · web.ts 의 연결 이유 · "shape-mismatch" 보고 모양이 다름 · 요청 오류 글)
/** 마지막 묻기가 같은 계정 거르기를 했는가 — mode "reports" = 원본 보고로 거름(hidden = 숨긴 카드 수: 내장 + 같은 계정 팀 카드) · "legacy" = 못 해서 옛 목록 그대로 */
export function usageDedupeState(): UsageDedupeView {
  return usageHub.dedupe;
}
function setDedupe(next: UsageDedupeView): void {
  usageHub.dedupe = next;
  reportUsageDedupe(next);
}
async function readUsage(provider: ReturnType<typeof uiProvider> | ReturnType<typeof soundProvider>, paseo: ReturnType<typeof usePaseo>): Promise<{ usage: Usage; dedupe: UsageDedupeView }> {
  const reports = provider?.usageReports;
  let reason = "no-provider";
  if (reports) {
    let raw: unknown = null;
    try {
      raw = await reports();
      reason = raw === null || raw === undefined ? "no-client" : "shape-mismatch";
    } catch (e) {
      reason = e instanceof Error && e.message ? e.message : String(e);
    }
    const built = raw === null ? null : usageFromReports(raw);
    if (built) {
      return { usage: built.usage as unknown as Usage, dedupe: { mode: "reports", hidden: built.hiddenIds.length, reason: null } };
    }
  }
  return { usage: await (provider?.usage ? provider.usage() : paseo.providers.listUsage()), dedupe: { mode: "legacy", hidden: 0, reason } };
}

function startUsagePoll(paseo: ReturnType<typeof usePaseo>): () => void {
  let alive = true;
  let generation = 0;
  let step = 0; // POLL_STEPS_MS 몇 번째 간격인지 — 실패할 때마다 한 칸 물러나고 받으면 처음으로
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = (next: UsageSnap) => { usageHub.snap = next; for (const fn of usageHub.subs) fn(next); };
  const load = async (force = false) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!alive || (!force && pageHidden())) return; // 다시 보이면 아래 onPageVisible 이 부른다
    const mine = ++generation;
    const provider = uiProvider() ?? soundProvider();
    void provider?.keepLogin?.().catch(() => null);
    let failed = false;
    try {
      // 갱신 아이콘을 눌렀을 때만 데몬 기억(5분)을 건너뛴다 — 개인 Claude·Codex·팀 카드 모두
      if (force) {
        if (!provider?.refreshUsage) throw new Error("사용량 공급자가 갱신을 지원하지 않습니다. 화면을 새로고침해 주세요");
        const refreshed = await provider.refreshUsage();
        if (refreshed !== true && refreshed !== undefined) throw new Error("사용량 즉시 갱신 연결을 확인할 수 없습니다");
      }
      const next = await readUsage(provider, paseo);
      if (alive && mine === generation) {
        setDedupe(next.dedupe);
        publish({ usage: next.usage, error: null });
      }
    } catch (e) {
      failed = true;
      if (alive && mine === generation) publish({ usage: usageHub.snap.usage, error: String(e) });
    }
    if (!alive || mine !== generation) return;
    step = failed ? Math.min(step + 1, POLL_STEPS_MS.length - 1) : 0;
    timer = setTimeout(() => void load(), POLL_STEPS_MS[step]);
  };
  void load();
  const off = onUiRole(() => { publish({ usage: null, error: null }); void load(); });
  const offVisible = onPageVisible(() => void load());
  const forceNow = () => load(true);
  usageHub.force = forceNow;
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
    off();
    offVisible();
    if (usageHub.force === forceNow) usageHub.force = null;
  };
}

/** 사용량 칸 "지금 갱신" — 데몬 기억을 건너뛰고 바로 받아 모든 칸에 다시 그린다(10-17 리규형님) */
export function refreshUsageNow(): Promise<void> {
  return usageHub.force ? usageHub.force() : Promise.resolve();
}

export function useUsage(): UsageSnap {
  const paseo = usePaseo();
  const [snap, setSnap] = useState<UsageSnap>(usageHub.snap);
  useEffect(() => {
    usageHub.subs.add(setSnap);
    setSnap(usageHub.snap);
    if (!usageHub.stop) usageHub.stop = startUsagePoll(paseo);
    return () => {
      usageHub.subs.delete(setSnap);
      if (!usageHub.subs.size && usageHub.stop) { usageHub.stop(); usageHub.stop = null; }
    };
  }, [paseo]);
  return snap;
}

/** 카드 순서(리규형님 10-15 "Claude → Claude (como) → Claude (hrg) → Codex"): 개인 Claude → 팀 Claude(이름순) → 그 밖은 받은 순서.
 *  데몬은 원천을 등록한 순서(개인 Claude → Codex → 팀)로 주므로 여기서 맞춘다 — 사용량 칸·접힌 줄 요약·위쪽 단추가 모두 이 함수를 거친다 */
const usageRank = (p: Provider): number => (isTeamUsageSource(p.providerId) ? 1 : /^claude/i.test(p.providerId) ? 0 : 2);
/** 보일 계정 — 사용량을 읽을 수 있고 창이 하나라도 있는 것 */
export const availableProviders = (usage: Usage | null): Provider[] => (usage?.providers ?? [])
  .filter((p) => p.status === "available" && p.windows.length)
  .map((p, index) => ({ p, index, rank: usageRank(p) }))
  .sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.p.displayName.localeCompare(b.p.displayName) : 0) || a.index - b.index)
  .map(({ p }) => p);
/** 보일 창 — Paseo 가 요약에 쓰라고 표시한 것(summary)만, 없으면 전부 */
export const shownWindows = (p: Provider): Window[] => (p.windows.some((w) => w.summary) ? p.windows.filter((w) => w.summary) : p.windows);
/** 계정 이름에서 뒤의 "(메일 주소)"를 뗀 짧은 이름 — "Claude (a@b.com)" → "Claude". 팀 공급자 카드는 메일 없이 공급자 이름
 *  그대로("Claude (como)")라 떼면 개인 카드와 같은 "Claude" 가 된다 → 그대로 둔다(10-15) */
export const shortName = (p: Provider): string =>
  isTeamUsageSource(p.providerId) ? p.displayName : p.displayName.replace(/\s*\([^)]*\)\s*$/, "") || p.providerId;
export const clampPct = (n: number | null | undefined): number | null => (typeof n === "number" ? Math.max(0, Math.min(100, n)) : null);
/** 요약 한 줄 — 숫자마다 % 를 붙인다(리규형님 10-07: 숫자만으로는 직관적이지 않다) — "Claude 3%·31% │ Codex 13%".
 *  상단 사용량 단추 글자와 접힌 왼쪽 아래 줄이 같이 쓴다 */
export function summaryLabel(providers: Provider[]): string {
  const now = Date.now();
  return providers.map((p) => `${shortName(p)} ${shownWindows(p).map((w) => windowPctText(w, now)).join("·")}`).join(" │ ");
}

/** 창 이름 — Paseo 가 주는 짧은 이름 그대로, 단 모델별 주간 창 "wk Fable" 은 "wkF" 로(리규형님 10-15: 이것만 길어 칸이
 *  어긋나 보인다). 다른 모델의 주간 창도 같은 규칙(첫 글자). 표·단추 설명이 같이 쓴다 */
export function windowName(w: Window): string {
  const name = w.shortLabel || w.label;
  const m = /^wk\s+(\S)/i.exec(name);
  return m ? `wk${m[1].toUpperCase()}` : name;
}

/** 창 하나의 퍼센트 글자 — "74%" · 값 없음 "—" · 리셋 지난 옛 값 "리셋됨". 요약 줄과 단추 설명이 같이 쓴다 */
export function windowPctText(w: Window, now: number = Date.now()): string {
  if (resetPassed(w, now)) return RESET_PASSED;
  const v = clampPct(w.usedPct);
  return v === null ? "—" : `${Math.round(v)}%`;
}

// 리셋 시각이 지났는데 받은 값이 그 전 것일 때(10-15 리규형님 결정). 데몬이 바깥 조회 결과를 5분 기억하고
// (UsageSourceRegistry ttlMs 300000), 플러그인에는 그 기억을 건너뛰는 통로가 없다 — 그래서 리셋 직후 길어야 5분은
// 옛 퍼센트(예: 74%)가 남는다. 틀린 숫자 대신 이 글자를 보이고, 새 값이 오면(리셋 시각이 앞으로 바뀌면) 저절로 숫자로 돌아간다
const RESET_PASSED = "리셋됨";
const resetPassed = (w: Window, now: number): boolean => {
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return Number.isFinite(t) && t <= now;
};

/** 끝나는 시각 — 늘 날짜까지 "10/10 14:59"(리규형님 10-15: 24시간 안이면 시각만 보이던 것을 모든 줄에 — 오늘·내일이 헷갈리지 않게) */
function resetText(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 남은 시간 — 큰 단위 둘까지: "2일 22시간" · "2시간 12분" · "12분". 지났으면 "곧" */
function leftText(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((t - now) / 60_000);
  if (min <= 0) return "곧";
  const day = Math.floor(min / 1440);
  const hour = Math.floor((min % 1440) / 60);
  if (day > 0) return hour ? `${day}일 ${hour}시간` : `${day}일`;
  if (hour > 0) return min % 60 ? `${hour}시간 ${min % 60}분` : `${hour}시간`;
  return `${min}분`;
}

// 한 줄 = 이름 · 막대 · % · 남은 시간 · 끝나는 시각(리규형님 10-07 결정: 막대를 짧게 하고 남은 시간과 끝나는 시각을 함께,
// Paseo 가 주는 창 전부 — Fable 같은 모델별 주간 창 포함). 줄마다 막대가 같은 자리에서 시작하도록 칸을 세로 열로 나눈다.
// 상단 사용량 단추의 작은 창도 이 표를 그대로 쓴다(단추 글자는 요약 창만 — usageButton).
// action 은 첫 계정 이름 줄 오른쪽 끝에 붙는다(왼쪽 아래 칸의 접기 단추)
// 다음 갱신까지 남은 시간(10-17 리규형님 "몇 분 몇 초 후 갱신" + 갱신 아이콘) — 데몬은 받아 온 사용량을 5분 기억한다(Paseo
// UsageSourceRegistry ttlMs 300000). 목록의 fetchedAt 은 가장 오래된 카드를 받은 시각이라 거기에 5분을 더한 때가 다음에 바뀌는
// 때다(그 뒤 첫 묻기 — 최대 30초 늦을 수 있다). 지났으면 "곧 갱신". 누르면 바로 갱신. 남은 시간 글자만 1초마다 다시 그린다
const DAEMON_USAGE_TTL_MS = 300_000;
function RefreshLine({ theme, ui, fetchedAt, busy, onPress }: Pick<PluginHostProps, "theme"> & { ui: number; fetchedAt: string | null; busy: boolean; onPress: () => void }) {
  const c = theme.colors;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const left = Number.isFinite(at) ? at + DAEMON_USAGE_TTL_MS - now : NaN;
  const min = Math.floor(left / 60_000);
  const sec = Math.floor((left % 60_000) / 1000);
  // 글자 먼저, 아이콘 뒤(리규형님 10-17 "2분 44초 후 갱신 아이콘 — 순서를 바꿔줘")
  const text = busy ? "갱신 중…" : !Number.isFinite(left) ? "" : left <= 0 ? "곧 갱신" : min > 0 ? `${min}분 ${sec}초 후 갱신` : `${sec}초 후 갱신`;
  return (
    <Pressable onPress={onPress} disabled={busy} accessibilityRole="button" accessibilityLabel="사용량 지금 갱신" hitSlop={6}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: ui - 2 }}>{text}</Text>
      <Icon name="RefreshCw" size={ui} color={c.foregroundMuted} />
    </Pressable>
  );
}

function UsageRows({ theme, usage, error, ui, action, top }: Pick<PluginHostProps, "theme"> & { usage: Usage | null; error: string | null; ui: number; action?: ReactNode; top?: ReactNode }) {
  const c = theme.colors;
  const toneColor = (w: Window) => (w.tone === "danger" ? c.statusDanger : w.tone === "warning" ? c.statusWarning : c.accent);
  const now = Date.now();
  const providers = availableProviders(usage);
  const rowH = Math.round(ui * 1.45);
  // 막대 말고 글자 칸의 폭은 모든 카드가 같이 쓴다(리규형님 10-15 "como 만 막대가 길다") — 카드마다 따로 줄을 그려서 오른쪽 글자가
  // 짧은 카드일수록 막대가 남는 폭을 더 먹었다. 칸마다 카드별로 글자 묶음의 폭을 재고, 지금 있는 카드 중 가장 넓은 값을 모든 카드의
  // 최소 폭으로 준다. 재는 것은 칸 안쪽 글자 묶음이라 글자가 짧아지면 폭도 다시 줄어든다
  const widths = useRef(new Map<string, number>());
  const [, remeasured] = useState(0);
  const widthOf = (column: string) => Math.max(0, ...providers.map((p) => widths.current.get(`${column}|${p.providerId}`) ?? 0));
  const onWidth = (column: string, providerId: string) => (e: LayoutChangeEvent) => {
    const key = `${column}|${providerId}`;
    const width = Math.ceil(e.nativeEvent.layout.width);
    if (widths.current.get(key) === width) return;
    widths.current.set(key, width);
    remeasured((n) => n + 1);
  };

  if (!usage)
    return error ? (
      <View ref={setNoTranslate} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 6 }}>
        <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: ui - 1 }}>사용량을 못 읽었습니다</Text>
        {action}
      </View>
    ) : null;
  if (!providers.length) return null;
  return (
    // 브라우저 번역이 날짜·창 이름을 길게 바꿔 칸 밖으로 밀어내지 않게(web.ts setNoTranslate)
    <View ref={setNoTranslate} style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }} accessibilityLabel="Claude·Codex 사용량">
      {top}
      {providers.map((p, index) => {
        const rows = p.windows;
        const cell = { height: rowH, justifyContent: "center" } as const;
        // align = 글자 칸이 붙는 쪽(모든 카드가 같은 폭) · "bar" = 막대 칸(남는 폭을 다 쓴다, 폭을 맞추지 않는다)
        const column = (key: string, render: (w: Window) => ReactNode, align: "start" | "end" | "bar") => {
          const cells = rows.map((w) => (
            <View key={w.id} style={cell}>
              {render(w)}
            </View>
          ));
          if (align === "bar") return <View key={key} style={{ flex: 1, minWidth: ui * 2 }}>{cells}</View>;
          return (
            <View key={key} style={{ minWidth: widthOf(key), alignItems: align === "start" ? "flex-start" : "flex-end" }}>
              <View onLayout={onWidth(key, p.providerId)}>{cells}</View>
            </View>
          );
        };
        return (
          <View key={p.providerId} style={{ gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: ui, fontWeight: "600" }} numberOfLines={1}>
                {p.displayName}
              </Text>
              {index === 0 ? action : null}
            </View>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {column("label", (w) => (
                <Text style={{ color: c.foregroundMuted, fontSize: ui - 1 }} numberOfLines={1}>
                  {windowName(w)}
                </Text>
              ), "start")}
              {column(
                "bar",
                (w) => {
                  const pct = resetPassed(w, now) ? null : clampPct(w.usedPct);
                  return (
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}>
                      {pct !== null ? <View style={{ width: `${pct}%`, height: 6, backgroundColor: toneColor(w) }} /> : null}
                    </View>
                  );
                },
                "bar",
              )}
              {column(
                "pct",
                (w) => {
                  if (resetPassed(w, now)) return <Text style={{ color: c.foregroundMuted, fontSize: ui - 1, textAlign: "right" }}>{RESET_PASSED}</Text>;
                  const pct = clampPct(w.usedPct);
                  return <Text style={{ color: c.foreground, fontSize: ui - 1, textAlign: "right" }}>{pct !== null ? `${Math.round(pct)}%` : "—"}</Text>;
                },
                "end",
              )}
              {column(
                "left",
                (w) => (
                  <Text style={{ color: resetPassed(w, now) ? c.foregroundMuted : c.foreground, fontSize: ui - 2, textAlign: "right" }} numberOfLines={1}>
                    {resetPassed(w, now) ? "새 값 받는 중" : leftText(w.resetsAt, now)}
                  </Text>
                ),
                "end",
              )}
              {column(
                "reset",
                (w) => (
                  <Text style={{ color: c.foregroundMuted, fontSize: ui - 2, textAlign: "right" }} numberOfLines={1}>
                    {resetPassed(w, now) ? "" : resetText(w.resetsAt)}
                  </Text>
                ),
                "end",
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** 상단 사용량 단추의 작은 창 — 표를 늘 펼쳐 보인다 */
export function UsageTable({ theme }: Pick<PluginHostProps, "theme">) {
  const ui = useUiPx();
  const { usage, error } = useUsage();
  return <UsageRows theme={theme} usage={usage} error={error} ui={ui} />;
}

// 왼쪽 아래 칸 — 처음엔 접혀 요약 한 줄만 보인다(리규형님 10-09 "사용량 기본은 접혀 있고"). 줄 오른쪽 위로 화살표로 올리고(펼치고),
// 펼친 표의 첫 계정 이름 옆 아래로 화살표로 내린다(접는다). 올리고 내린 것을 이 기기 앱 저장소에 기억해 새로고침해도 그대로다.
// 기기마다 따로다 — 기기 사이 설정 맞추기는 설정 화면의 설정만 맞춘다(10-07 결정). 폰 원본 앱은 저장소가 없어 늘 접힌 채 시작한다
const OPEN_KEY = "claude-state-bar:usage-open";
export function UsageFooter({ theme }: Pick<PluginHostProps, "theme">) {
  const ui = useUiPx();
  const { usage, error } = useUsage();
  const [open, setOpen] = useState(() => readLocal(OPEN_KEY) === "1");
  const c = theme.colors;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeLocal(OPEN_KEY, next ? "1" : "0");
  };

  // 지금 갱신(10-17 리규형님 "내가 원할 때 사용량 패널에서 아이콘을 누르면 즉시") — 받는 동안은 흐리게, 다시 못 누름
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    if (busy) return;
    setBusy(true);
    void refreshUsageNow().finally(() => setBusy(false));
  };

  if (open) {
    const fold = (
      <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel="사용량 내리기" accessibilityState={{ expanded: true }} hitSlop={8}>
        <Icon name="ChevronDown" size={ui + 2} color={c.foregroundMuted} />
      </Pressable>
    );
    // 카드 목록 맨 위 한 줄에 갱신(왼쪽)·접기(오른쪽)(리규형님 10-17 스크린샷 빨간 네모 자리 · "접기 아이콘도 같은 행으로").
    // 사용량을 못 읽은 상태엔 이 줄이 없어 접기를 그 줄 옆에 둔다
    const top = (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <RefreshLine theme={theme} ui={ui} fetchedAt={(usage as { fetchedAt?: string } | null)?.fetchedAt ?? null} busy={busy} onPress={refresh} />
        </View>
        {fold}
      </View>
    );
    return <UsageRows theme={theme} usage={usage} error={error} ui={ui} action={usage ? undefined : fold} top={top} />;
  }
  const providers = availableProviders(usage);
  if (usage && !providers.length) return null;
  const line = providers.length ? summaryLabel(providers) : error ? "사용량을 못 읽었습니다" : "사용량";
  return (
    <Pressable
      ref={setNoTranslate}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel="사용량 올리기"
      accessibilityState={{ expanded: false }}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}
    >
      <Icon name="Gauge" size={ui} color={c.foregroundMuted} />
      <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: ui - 1 }} numberOfLines={1}>
        {line}
      </Text>
      <Icon name="ChevronUp" size={ui + 2} color={c.foregroundMuted} />
    </Pressable>
  );
}
