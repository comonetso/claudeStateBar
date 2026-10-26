import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

// 다른 대화에서 온 글(peer_mail) 접기(10-16 리규형님 "내가 읽지도 않은 걸 뿌릴 필요 없잖아 — 받았다·보냈다, 어떤 게 왔다,
// 어떻게 답했다를 Claude 가 요약해 주면 되잖아"). 중계기가 받는 대화에 넣는 글(영어 처리 안내 + 본문 + 봉투 JSON)은 Claude 가
// 처리하는 데 그대로 필요해서, 화면에서만 첫 줄 한 줄로 접는다 — 누르면 본문만 펼친다(안내·봉투는 안 보임).
// 판별 = 사용자 말이 중계기 머리 `[peer_mail/1] ` 로 시작(사람은 이렇게 치지 않는다)

const KIND = "peer-mail";
const PREFIX = "[peer_mail/1] ";
type Data = { title: string; body: string };
const schema = z.object({ title: z.string(), body: z.string() });

/** 첫 줄(종류 · 보낸 곳 → 받는 곳 · 요청 번호)과 본문(── body ── 와 ── envelope 사이)만 */
export function parsePeerMail(text: string): Data | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  const title = text.slice(PREFIX.length).split("\n", 1)[0].trim();
  const start = text.indexOf("── body ──");
  const end = text.indexOf("── envelope");
  const body = start >= 0 ? text.slice(start + "── body ──".length, end > start ? end : undefined).trim() : "";
  return { title, body };
}

function PeerMailCard(props: PluginTimelineItemProps<Data>) {
  const c = props.theme.colors;
  const { title, body } = props.item.data;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginVertical: 2, alignSelf: "flex-end", maxWidth: "100%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`다른 대화에서 온 글 ${title} ${open ? "접기" : "펼치기"}`}
        disabled={!body}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}
      >
        <Icon name="Mail" size={13} color={c.foregroundMuted} />
        <Text style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
          다른 대화에서 온 글 — {title}
        </Text>
        {body ? <Icon name={open ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} /> : null}
      </Pressable>
      {open ? (
        <Text selectable style={{ marginTop: 4, padding: 10, borderRadius: 8, backgroundColor: c.surface1, color: c.foreground, fontSize: 13 }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

export function registerPeerMailCard(client: PluginClientContext, log: (message: string) => void): () => void {
  const a = client.addTimelineTransformer({
    id: "peer-mail",
    query: { itemType: "user_message" },
    transform: ({ item }) => {
      try {
        const data = typeof item.text === "string" ? parsePeerMail(item.text) : undefined;
        return data ? { items: [{ type: "plugin", kind: KIND, version: 1, data }] } : undefined;
      } catch (error) {
        log(`peer mail card: ${String(error)}`);
        return undefined;
      }
    },
  });
  const b = client.addTimelineRenderer({ kind: KIND, version: 1, schema, Component: PeerMailCard });
  return () => {
    void a();
    void b();
  };
}
