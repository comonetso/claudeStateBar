import type { PluginHostProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { soundProvider } from "./sounds";
import { readAppFontSizes } from "./web";

// 왼쪽 목록 칸 맨 아래에 Claude·Codex 사용량을 늘 펼쳐 둔다(리규형님 10-05 결정 — Paseo 자체 "사용량" 줄은 눌러야 보인다).
// 값은 Paseo 데몬이 이미 받아 둔 것을 그대로 쓴다(providers.listUsage — 데몬이 5분 동안 기억하므로 1분마다 물어도
// 바깥 조회는 5분에 한 번 이하). 창은 Paseo 가 요약에 쓰라고 표시한 것(summary)만, 없으면 전부.

const POLL_MS = 60_000;
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
 * 사용량 — 1분마다 데몬에 묻는다. 왼쪽 아래 표와 오른쪽 위 사용량 단추(usageButton)가 같이 쓴다.
 * 소리 담당 호스트(이 PC)가 공급자로 올라와 있으면 그 데몬에 묻는다 — 서버 작업 공간의 단추도 같은 숫자를 보이게(10-06).
 * 아직 안 올라왔으면 이 호스트 데몬에 묻는다
 */
export function useUsage(): { usage: Usage | null; error: string | null } {
  const paseo = usePaseo();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const fromProvider = soundProvider()?.usage;
        const next = fromProvider ? await fromProvider() : await paseo.providers.listUsage();
        if (alive) {
          setUsage(next);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [paseo]);
  return { usage, error };
}

/** 보일 계정 — 사용량을 읽을 수 있고 창이 하나라도 있는 것 */
export const availableProviders = (usage: Usage | null): Provider[] => (usage?.providers ?? []).filter((p) => p.status === "available" && p.windows.length);
/** 보일 창 — Paseo 가 요약에 쓰라고 표시한 것(summary)만, 없으면 전부 */
export const shownWindows = (p: Provider): Window[] => (p.windows.some((w) => w.summary) ? p.windows.filter((w) => w.summary) : p.windows);
/** 계정 이름에서 뒤의 "(메일 주소)"를 뗀 짧은 이름 — "Claude (a@b.com)" → "Claude" */
export const shortName = (p: Provider): string => p.displayName.replace(/\s*\([^)]*\)\s*$/, "") || p.providerId;
export const clampPct = (n: number | null | undefined): number | null => (typeof n === "number" ? Math.max(0, Math.min(100, n)) : null);

function resetText(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return t - now < 86_400_000 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

export function UsageFooter({ theme }: Pick<PluginHostProps, "theme">) {
  const ui = useUiPx();
  const { usage, error } = useUsage();

  const c = theme.colors;
  const toneColor = (w: Window) => (w.tone === "danger" ? c.statusDanger : w.tone === "warning" ? c.statusWarning : c.accent);
  const now = Date.now();
  const providers = availableProviders(usage);

  if (!usage) return error ? <Text style={{ color: c.foregroundMuted, fontSize: ui - 1, paddingHorizontal: 12 }}>사용량을 못 읽었습니다</Text> : null;
  if (!providers.length) return null;
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }} accessibilityLabel="Claude·Codex 사용량">
      {providers.map((p) => {
        const shown = shownWindows(p);
        return (
          <View key={p.providerId} style={{ gap: 3 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: ui, fontWeight: "600" }} numberOfLines={1}>
              {p.displayName}
            </Text>
            {shown.map((w) => {
              const pct = clampPct(w.usedPct);
              const reset = resetText(w.resetsAt, now);
              return (
                <View key={w.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: ui - 1, width: ui * 2 }} numberOfLines={1}>
                    {w.shortLabel || w.label}
                  </Text>
                  <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}>
                    {pct !== null ? <View style={{ width: `${pct}%`, height: 6, backgroundColor: toneColor(w) }} /> : null}
                  </View>
                  <Text style={{ color: c.foreground, fontSize: ui - 1, minWidth: ui * 2.6, textAlign: "right" }}>{pct !== null ? `${Math.round(pct)}%` : "—"}</Text>
                  {reset ? <Text style={{ color: c.foregroundMuted, fontSize: ui - 2, minWidth: ui * 3, textAlign: "right" }}>{reset}</Text> : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}
