import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { claudeStats, type ClaudeStatsView, type HeatDay } from "../shared/stats";
import { scaled, useFontScale } from "./fontScale";
import { panelStyles, type PanelStyles } from "./ui";
import { setHoverTitle } from "./web";

// 작업 현황 "통계" 탭(리규형님 10-08 결정) — VS Code 확장 Claude Status 패널의 통계 탭(media/status.js renderStats ·
// media/status.css)과 같은 순서·같은 내용: 활동(날짜별 칸) → 누적(숫자 아홉 칸 + 토큰 네 가지) → 모델별(막대).
// 계산은 전부 데몬(server/stats/claudeStats.ts)이 하고 여기선 모양만 낸다(확장도 그렇게 나눴다).
// 돌고 있는 수가 없는 탭이라 탭 옆 숫자도 없다. 글자 크기는 다른 탭과 같이 패널 A−/A+ 를 따른다.
// 화면 글자는 확장 한국어 문구(i18n.ts cs.stats.*)를 바탕으로 기호·영어 약어 없이 고쳤다.

// 확장은 상태바 새로 고침(refreshInterval 기본 30초)마다 열린 패널을 다시 그린다 — 같은 간격.
// 데몬은 결과를 20초 기억해 여러 화면(PC 앱·웹·폰)이 같이 물어도 한 번만 읽는다
const POLL_MS = 30_000;

// ── 표기 ─────────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 1234567 → "1,234,567" (폰 앱 실행기의 지역 설정에 기대지 않으려고 직접 쉼표를 찍는다) */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "없음";
  const s = String(Math.round(Math.abs(n)));
  const body = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${body}` : body;
}

/** 소수 한 자리, 끝의 ".0" 은 뗀다(확장 trim1) */
function trim1(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * 토큰 수 — 확장은 "8.3b · 43.7m · 217.7k"(CLI 와 같은 영어 단위). 화면 글자 규칙(영어 약어 금지)에 맞춰 만·억으로:
 * 83억 · 4,370만 · 21.8만 · 9,876
 */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "없음";
  const a = Math.abs(n);
  const unit = (v: number, name: string) => `${v >= 100 ? fmtInt(v) : trim1(v)}${name}`;
  if (a >= 1e8) return unit(n / 1e8, "억");
  if (a >= 1e4) return unit(n / 1e4, "만");
  return fmtInt(n);
}

/** 환산 금액 — 소수 둘째 자리까지, 0 이 아닌 작은 금액이 "0달러"로 보이지 않게(확장 fmtMoney 와 같은 규칙, "$" 대신 "달러") */
function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "없음";
  if (v <= 0) return "0달러";
  if (v < 0.01) return "0.01달러 미만";
  const [whole, cents] = v.toFixed(2).split(".");
  return `${fmtInt(Number(whole))}.${cents}달러`;
}

/** 1,463,384,765ms → "16일 22시간 29분"(확장 fmtDuration, 한국어 단위) */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "없음";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}일`);
  if (h) parts.push(`${h}시간`);
  if (m || (!d && !h)) parts.push(`${m}분`);
  return parts.join(" ");
}

/** "2026-08-19" → 그 날 0시(이 화면 시간대). 날짜 글자는 데몬 기기 기준이라 요일만 여기서 계산한다 */
function parseDate(key: string): Date {
  const p = key.split("-");
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "2026-08-19" → "8월 19일" (확장은 "Aug 19") */
function monthDay(key: string): string {
  const p = key.split("-");
  if (p.length !== 3) return key;
  return `${Number(p[1])}월 ${Number(p[2])}일`;
}

/** "2026-08-19" → "2026년 8월 19일" */
function fullDate(key: string): string {
  const p = key.split("-");
  if (p.length !== 3) return key;
  return `${p[0]}년 ${Number(p[1])}월 ${Number(p[2])}일`;
}

function fmtClockSec(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ── 조각 ─────────────────────────────────────────────────────────────────────

/** 확장 .section · .section-header: 굵은 제목 + 아래 선 */
function Section({ title, styles, theme, children }: { title: string; styles: PanelStyles; theme: PluginTheme; children: ReactNode }) {
  return (
    <View style={{ gap: 10, marginBottom: 12 }}>
      <View style={{ paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        <Text style={[styles.small, { fontWeight: "700" }]}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/** 확장 칸 색: 기록 없는 날 = 글자색 9%, 1~4 단계 = 초록 28·50·74·100%(media/status.css .heat-cell) */
const LEVEL_OPACITY = [0.09, 0.28, 0.5, 0.74, 1];

function cellColor(theme: PluginTheme, level: number | null): { backgroundColor: string; opacity: number } {
  if (level === null) return { backgroundColor: "transparent", opacity: 1 };
  if (level <= 0) return { backgroundColor: theme.colors.foreground, opacity: LEVEL_OPACITY[0] };
  return { backgroundColor: theme.colors.statusSuccess, opacity: LEVEL_OPACITY[Math.min(4, level)] };
}

type HeatColumn = { label: string; cells: { key: string; rec: HeatDay | undefined; inRange: boolean }[] };

/**
 * 요일 7줄 × 주 N칸, 오래된 주가 왼쪽(확장 buildHeatmap — CLI 와 같은 모양). 첫 기록 앞은 빈 칸으로 채워 첫 열이 제 요일에서 시작한다.
 * 칸 크기는 확장 값(11px · 사이 3px)에 패널 글자 배율을 곱한다. 칸 설명(날짜·메시지 수)은 마우스를 올리면 뜬다(웹·데스크톱만).
 */
function Heatmap({ days, styles, theme, scale }: { days: HeatDay[]; styles: PanelStyles; theme: PluginTheme; scale: number }) {
  const cols = useMemo<HeatColumn[]>(() => {
    if (!days.length) return [];
    const byDate = new Map(days.map((d) => [d.date, d] as const));
    const first = parseDate(days[0].date);
    const last = parseDate(days[days.length - 1].date);
    // 첫 주의 일요일까지 물러나 열 경계가 실제 주가 되게 한다
    const cursor = new Date(first.getTime());
    cursor.setDate(cursor.getDate() - cursor.getDay());
    const out: HeatColumn[] = [];
    let lastMonth = -1;
    while (cursor <= last) {
      // 열마다 이름 하나, 달이 바뀔 때만 적는다(확장·CLI 와 같은 성긴 머리줄)
      const month = cursor.getMonth();
      const col: HeatColumn = { label: month === lastMonth ? "" : `${month + 1}월`, cells: [] };
      lastMonth = month;
      for (let row = 0; row < 7; row++) {
        const key = isoDate(cursor);
        col.cells.push({ key, rec: byDate.get(key), inRange: cursor >= first && cursor <= last });
        cursor.setDate(cursor.getDate() + 1);
      }
      out.push(col);
    }
    return out;
  }, [days]);

  if (!days.length) return <Text style={styles.muted}>기록된 활동이 없습니다.</Text>;

  const cell = scaled(11, scale);
  const gap = scaled(3, scale);
  const step = cell + gap;
  const monthFont = styles.fs(10);
  const legendCell = scaled(9, scale);
  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
        {/* 오른쪽 끝 열의 달 이름이 칸 밖으로 나가도 잘리지 않게 여유를 둔다 */}
        <View style={{ paddingRight: monthFont * 3, paddingBottom: 4 }}>
          <View style={{ height: Math.ceil(monthFont * 1.5), width: cols.length * step, marginBottom: 4 }}>
            {cols.map((col, i) =>
              col.label ? (
                <Text key={`m${i}`} style={{ position: "absolute", left: i * step, top: 0, color: theme.colors.foregroundMuted, fontSize: monthFont }} numberOfLines={1}>
                  {col.label}
                </Text>
              ) : null,
            )}
          </View>
          <View style={{ flexDirection: "row", gap }}>
            {cols.map((col, i) => (
              <View key={`c${i}`} style={{ gap }}>
                {col.cells.map((c) => {
                  const level = c.rec ? c.rec.level : c.inRange ? 0 : null;
                  const title = c.rec ? `${fullDate(c.key)} · 메시지 ${fmtInt(c.rec.count)}개` : c.inRange ? fullDate(c.key) : "";
                  return (
                    <View
                      key={c.key}
                      ref={title ? (node: unknown) => setHoverTitle(node, title) : undefined}
                      style={[{ width: cell, height: cell, borderRadius: 2 }, cellColor(theme, level)]}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: monthFont }}>적음</Text>
        {[0, 1, 2, 3, 4].map((lv) => (
          <View key={lv} style={[{ width: legendCell, height: legendCell, borderRadius: 2 }, cellColor(theme, lv)]} />
        ))}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: monthFont }}>많음</Text>
      </View>
    </View>
  );
}

/** 확장 .stat-grid: 왼쪽 선이 있는 숫자 칸들, 폭에 따라 여러 줄로 */
function StatGrid({ items, styles, theme, scale }: { items: { label: string; value: string; sub?: string }[]; styles: PanelStyles; theme: PluginTheme; scale: number }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12, columnGap: 18 }}>
      {items.map((it) => (
        <View key={it.label} style={{ flexGrow: 1, flexBasis: scaled(150, scale), borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 10, gap: 2 }}>
          <Text style={[styles.muted, { fontSize: styles.fs(11) }]}>{it.label}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: styles.fs(15), fontWeight: "600" }} selectable>
            {it.value}
          </Text>
          {it.sub ? <Text style={[styles.muted, { fontSize: styles.fs(11) }]}>{it.sub}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** 확장 .token-row: "입력 1.2억 · 출력 …" */
function TokenRow({ parts, styles, theme }: { parts: [string, number][]; styles: PanelStyles; theme: PluginTheme }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 6, columnGap: 20, marginTop: 4 }}>
      {parts.map(([label, v]) => (
        <Text key={label} style={styles.muted}>
          {`${label} `}
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{fmtTokens(v)}</Text>
        </Text>
      ))}
    </View>
  );
}

/** 확장 .bar-row: 모델 이름 · 막대(전체 토큰 중 몫) · 토큰. 마우스를 올리면 이름 · 토큰 · 환산 금액(웹·데스크톱만 — 확장도 설명 글에만 있다) */
function ModelRows({ stats, styles, theme, scale }: { stats: ClaudeStatsView; styles: PanelStyles; theme: PluginTheme; scale: number }) {
  const c = theme.colors;
  return (
    <View style={{ gap: 7 }}>
      {stats.byModel.map((m) => {
        const money = m.unknownRate ? "단가 모름" : fmtMoney(m.costUSD);
        return (
          <View
            key={m.model}
            ref={(node: unknown) => setHoverTitle(node, `${m.label} · ${fmtTokens(m.tokens)} · ${money}`)}
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <Text style={[styles.mono, { minWidth: scaled(96, scale) }]} numberOfLines={1}>
              {m.label}
            </Text>
            <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}>
              <View style={{ width: `${Math.max(0, Math.min(100, m.percent))}%`, height: "100%", borderRadius: 3, backgroundColor: c.accent }} />
            </View>
            <Text style={[styles.muted, { fontSize: styles.fs(11), minWidth: scaled(60, scale), textAlign: "right" }]}>{fmtTokens(m.tokens)}</Text>
          </View>
        );
      })}
    </View>
  );
}

// ── 패널 ─────────────────────────────────────────────────────────────────────

export function StatsPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const fetchStats = useRpc(claudeStats);
  const [data, setData] = useState<{ computedAt: number; stats: ClaudeStatsView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scale = useFontScale();
  const styles = useMemo(() => panelStyles(theme, layout.compact, scale), [theme, layout.compact, scale]);

  // 마지막에 시작한 읽기의 답만 반영한다(늦게 온 옛 답이 새 값을 덮지 않게 — 다른 탭과 같은 방식). 탭을 떠나면 답을 버린다
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      seq.current++;
      alive.current = false;
    },
    [],
  );
  const load = useCallback(
    async (force: boolean) => {
      const mine = ++seq.current;
      if (force) setBusy(true);
      try {
        const next = await fetchStats({ force });
        if (mine !== seq.current) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(String(e));
      } finally {
        // 새로고침 중에 30초 읽기가 끼어들어 이 답이 버려져도 단추는 풀어 준다(안 풀면 "읽는 중…"에 멈춘다)
        if (force && alive.current) setBusy(false);
      }
    },
    [fetchStats],
  );

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const s = data?.stats;
  const footer = (
    <View style={[styles.head, { marginTop: 4 }]}>
      <Text style={styles.muted}>{data ? `${fmtClockSec(data.computedAt)} 기준` : ""}</Text>
      <View style={{ flex: 1 }} />
      <Pressable style={styles.button} onPress={() => void load(true)} accessibilityRole="button" accessibilityLabel="통계를 다시 읽습니다" disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "읽는 중…" : "새로고침"}</Text>
      </Pressable>
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.muted}>이 작업 공간이 있는 기기의 Claude Code 기록 전체(모든 폴더)를 모은 통계입니다. 비용은 공식 단가로 환산한 값이고, 구독이라면 실제로 청구되지 않습니다.</Text>
      {error ? <Text style={styles.error}>통계를 읽지 못했습니다: {error}</Text> : null}
      {!data && !error ? <Text style={styles.muted}>이 기기의 대화 기록을 읽는 중…</Text> : null}
      {s && !s.available ? <Text style={styles.muted}>아직 통계가 없습니다. Claude Code 를 쓰는 동안 쌓입니다.</Text> : null}
      {s && s.available ? (
        <>
          <Section title="활동" styles={styles} theme={theme}>
            <Heatmap days={s.daily} styles={styles} theme={theme} scale={scale} />
          </Section>
          <Section title="누적" styles={styles} theme={theme}>
            <StatGrid
              styles={styles}
              theme={theme}
              scale={scale}
              items={[
                { label: "총 토큰", value: fmtTokens(s.totalTokens) },
                { label: "공식 단가로 환산한 비용", value: fmtMoney(s.costUSD), sub: s.hasUnknownRate ? "단가 모름 모델은 합계에서 뺐습니다" : undefined },
                { label: "가장 많이 쓴 모델", value: s.favoriteModelLabel || "없음" },
                { label: "대화 수", value: fmtInt(s.sessions) },
                { label: "가장 긴 대화", value: fmtDuration(s.longestSessionMs) },
                { label: "활동한 날", value: `${s.windowDays}일 중 ${s.activeDays}일` },
                { label: "최장 연속", value: `${s.longestStreak}일` },
                { label: "가장 활발했던 날", value: s.mostActiveDay ? monthDay(s.mostActiveDay) : "없음" },
                { label: "현재 연속", value: `${s.currentStreak}일` },
              ]}
            />
            <TokenRow
              styles={styles}
              theme={theme}
              parts={[
                ["입력", s.input],
                ["출력", s.output],
                ["캐시 읽기", s.cacheRead],
                ["캐시 쓰기", s.cacheWrite],
              ]}
            />
          </Section>
          {s.byModel.length ? (
            <Section title="모델별" styles={styles} theme={theme}>
              <ModelRows stats={s} styles={styles} theme={theme} scale={scale} />
            </Section>
          ) : null}
          {/* 누적은 Claude Code 가 정리해 둔 파일(stats-cache.json)에서, 오늘만 대화 기록에서 직접 센다(확장과 같다).
              그 파일이 며칠 전에 멈춰 있으면 그 사이가 비어 보여서 기준일을 함께 적는다 */}
          {s.lastComputedDate ? (
            <Text style={styles.muted}>
              {`누적은 Claude Code 가 ${fullDate(s.lastComputedDate)}까지 정리해 둔 기록이고, 오늘(${monthDay(s.today)})은 대화 기록에서 직접 셉니다.`}
            </Text>
          ) : null}
        </>
      ) : null}
      {footer}
    </ScrollView>
  );
}
