import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useHealth, type FeatureHealth, type HealthState } from "./health";
import { FoldTitle, SectionTitle } from "./sectionTitle";
import { claimOwner, refreshOwner, releaseOwner, useScreenRole } from "./screenRole";
import type { SettingsText } from "./settingsI18n";
import { useSyncSlots } from "./settingsSync";
import { appBundleId, isCompactWidth, isDesktopApp, PASEO_BUNDLES } from "./web";

// 설정 화면 위쪽 "Paseo 버전·기능 상태" 칸(10-08 리규형님 결정: 판이 안 맞아 조용히 꺼진 기능을 화면에 알리기. 10-09 "이 화면의
// Paseo 판이 무슨 뜻이냐"로 이름을 바꿈 — 화면 글은 "판" 대신 "버전").
// 0.11.1 업데이트 때 무엇이 안 되는지 알 길이 없었다("어떤게 안돼는지 조차 모르겠음").
// 같은 날 Codex 업데이트 대비 연구(261008_150613)가 "아는 판 = 모두 켜짐" 문구가 실제 동작을 안 본 잘못된 안심이라고 짚어
// 기능별 상태(client/health.ts — 정상·제한·중단·확인 중·해당 없음)로 바꿨다. 제한·중단은 왼쪽 칸 맨 위에도 한 줄 뜬다(projectsSidebar).
// 판이 다른 화면에서 더 나중에 바꾼 설정은 이 화면을 열기 전 것까지 참고로 적는다 — 기능 상태에는 연 뒤 것만 센다(옛 칸 오경보 방지).
// 폰 공식 앱은 화면 코드 지문이 없어 이 칸을 그리지 않는다. 글자는 설정 화면 사전(client/settingsI18n — 한글·영어).

type PluginTheme = PluginSurfaceProps["theme"];

function versionLabel(slot: string, t: SettingsText): string {
  return PASEO_BUNDLES[slot]?.version ?? t.versionUnknown(slot.slice(0, 12));
}

function when(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 이유 글 — 다른 판 칸은 지문 대신 판 이름으로 */
function reasonText(f: FeatureHealth, t: SettingsText): string {
  if (!f.reason) return "";
  const detail = f.reason === "other-version" ? (f.detail ?? "").split(",").map((s) => versionLabel(s, t)).join(t.listJoin) : f.detail ?? "";
  const fallback = f.state === "limited" ? t.featureFallback[f.id] : undefined;
  return [t.healthReason(f.reason, detail), fallback].filter(Boolean).join(" — ");
}

/**
 * 기준 화면 줄(10-08 리규형님 결정: 대표 PC 웹은 설정 화면 버튼으로 지정 — client/screenRole).
 * 지정 버튼은 넓은 화면의 브라우저에서만(좁은 화면은 Paseo 가 칸 하나로 그려 화면 구성 기준이 될 수 없다 · PC 앱은 대표가 없을 때 이미 기준).
 * 풀기 버튼은 대표 브라우저 자신과 PC 앱에서 — 웹 중심이 잘 안 될 때 앱에서 되돌릴 수 있게. 설정을 열 때마다 PC 에 다시 묻는다
 */
function RoleBlock({ t, theme }: { t: SettingsText; theme: PluginTheme }) {
  const role = useScreenRole();
  const { width } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void refreshOwner().catch(() => {});
  }, []);
  const c = theme.colors;
  const desktop = isDesktopApp();
  const line = !role.known
    ? t.roleUnknown
    : !role.owner
      ? t.roleNone
      : role.mine
        ? t.roleMine(role.owner.label, when(role.owner.at))
        : t.roleOther(role.owner.label, when(role.owner.at));
  // width 는 좁은 화면 판정을 창 크기에 따라 다시 하게 하는 값이다
  const canClaim = role.known && !role.mine && !desktop && width > 0 && !isCompactWidth();
  const canRelease = role.known && !!role.owner && (role.mine || desktop);
  const run = (fn: () => Promise<void>) => () => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const button = { alignSelf: "flex-start" as const, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surface2, opacity: busy ? 0.6 : 1 };
  return (
    <>
      <Text style={{ color: c.foreground, fontSize: 14 }}>{line}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{t.roleHint}</Text>
      {canClaim ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={run(claimOwner)} style={button}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>{busy ? t.roleBusy : t.roleClaim}</Text>
        </Pressable>
      ) : null}
      {canRelease ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={run(releaseOwner)} style={button}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>{busy ? t.roleBusy : t.roleRelease}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={{ color: c.statusWarning, fontSize: 13 }}>{t.roleFailed(error)}</Text> : null}
    </>
  );
}

/**
 * "기준 브라우저" 칸 — 10-09 버전 칸 안 작은 소제목에서 독립 대제목으로 꺼냈다(리규형님이 "이 브라우저를 대표 화면으로"
 * 단추를 못 찾음 — 이름이 "기준 화면·대표"로 둘이었고 버전 칸 아래 묻혀 있었다). 버전 칸처럼 화면 코드 지문이 없는
 * 폰 공식 앱에서는 그리지 않는다
 */
export function MainDeviceSection({ theme, t }: { theme: PluginTheme; t: SettingsText }) {
  const c = theme.colors;
  if (!appBundleId()) return null;
  return (
    <>
      <SectionTitle icon="MonitorCheck" title={t.roleHead} theme={theme} />
      <View style={{ gap: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
        <RoleBlock t={t} theme={theme} />
      </View>
    </>
  );
}

export function VersionStatusSection({ theme, t }: { theme: PluginTheme; t: SettingsText }) {
  const slot = appBundleId();
  const view = useSyncSlots();
  const health = useHealth();
  // 항목이 여럿이라 접힌 채로 연다(10-09 리규형님)
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const styles = useMemo(
    () => ({
      card: { gap: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 },
      text: { color: c.foreground, fontSize: 14 },
      muted: { color: c.foregroundMuted, fontSize: 13 },
      warn: { color: c.statusWarning, fontSize: 13 },
    }),
    [c],
  );
  if (!slot) return null;

  const known = slot in PASEO_BUNDLES;
  const mine = view?.slots.find((s) => s.slot === slot)?.at ?? 0;
  const newerOthers = (view?.slots ?? []).filter((s) => s.slot !== slot && s.at > mine);
  const tone: Record<HealthState, string> = { ok: c.statusSuccess, limited: c.statusWarning, stopped: c.statusDanger, checking: c.foregroundMuted, na: c.foregroundMuted };

  return (
    <>
      <FoldTitle icon="ShieldCheck" title={t.versionSection} theme={theme} open={open} onToggle={() => setOpen(!open)} labels={t.fold} />
      {open ? (
      <View style={styles.card}>
        <Text style={styles.text}>{t.versionLine(versionLabel(slot, t), isDesktopApp())}</Text>
        <Text style={known ? styles.muted : styles.warn}>{known ? t.versionTableReady : t.versionTableMissing}</Text>
        <Text style={[styles.text, { fontWeight: "600", marginTop: 4 }]}>{t.healthHead}</Text>
        {health.map((f) => {
          const why = reasonText(f, t);
          const dim = f.state === "na" || f.state === "checking";
          return (
            <View key={f.id} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: tone[f.state] }} />
              <Text style={[dim ? styles.muted : styles.text, { flex: 1 }]}>
                {t.featureName[f.id]} — <Text style={{ color: tone[f.state], fontWeight: "600" }}>{t.healthState[f.state]}</Text>
                {why ? <Text style={styles.muted}>{`  ${why}`}</Text> : null}
              </Text>
            </View>
          );
        })}
        <Text style={styles.muted}>{t.healthEvidence}</Text>
        {newerOthers.length > 0 ? (
          <Text style={styles.warn}>
            {t.versionNewerOthers(newerOthers.map((s) => `${versionLabel(s.slot, t)} ${when(s.at)}`).join(t.listJoin))}
          </Text>
        ) : null}
      </View>
      ) : null}
    </>
  );
}
