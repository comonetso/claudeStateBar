import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SHARE_SCREEN_ID } from "../../shared/team/share";
import { listShares, shareGateReachable, type ShareBrief } from "./shareGate";

// 같이 보기 — 왼쪽 목록 맨 위 "공유" 묶음(10-25 · 10-20 리규형님 구상 "팀원 화면 프로젝트 탭 안 공유"). 공유받은 대화가 있을 때만 보이고,
// 누르면 별도 화면(shareScreen.tsx)이 열린다. 게이트에 15초마다 묻는다(목록만 — 글은 화면을 열 때).
// 10-25 명시 지시 6-3 — 팀원이 리규형님께도 공유하므로 리규형님 웹에도 뜬다. 관리자는 대상이 아닌 공유도 미리 볼 수 있지만 여기엔 나에게 온 것만

type Theme = { colors: Record<string, string> };
type OpenScreen = (input: { screenId: string; params?: Record<string, string> }) => void;
const LIST_MS = 15_000;

export function ShareGroup({ theme, openScreen }: { theme: Theme; openScreen: OpenScreen }) {
  const c = theme.colors;
  const [shares, setShares] = useState<ShareBrief[]>([]);

  useEffect(() => {
    if (!shareGateReachable()) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await listShares();
        // forMe 가 없는 옛 게이트는 팀원에게 대상인 것만 주므로 그대로 보인다
        if (!stop) setShares(r.status === 200 && Array.isArray(r.json?.shares) ? (r.json!.shares as ShareBrief[]).filter((s) => s.forMe !== false) : []);
      } catch {
        if (!stop) setShares([]);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), LIST_MS);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  if (!shares.length) return null;
  return (
    <View style={{ marginBottom: 8, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingVertical: 4 }}>
        <Icon name="Users" size={13} color={c.foregroundMuted} />
        <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>공유 {shares.length}</Text>
      </View>
      {shares.map((s) => (
        <Pressable
          key={s.id}
          accessibilityRole="button"
          onPress={() => openScreen({ screenId: SHARE_SCREEN_ID, params: { id: s.id } })}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, backgroundColor: pressed ? c.surface2 : "transparent" })}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: s.running ? (c.statusSuccess ?? c.accent) : c.border }} />
          <Text style={{ color: c.foreground, fontSize: 13, flex: 1 }} numberOfLines={1}>{s.title}</Text>
          {s.ownerName ? <Text style={{ color: c.foregroundMuted, fontSize: 11, maxWidth: 90 }} numberOfLines={1}>{s.ownerName}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}
