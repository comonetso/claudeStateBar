import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const soundKinds = ["warning", "danger", "completion", "question", "workflow"] as const;
export type SoundKind = (typeof soundKinds)[number];

// 이 호스트의 소리 하나를 설정(파일·크기)대로 읽어 data URL 로 준다.
// file·gain 을 주면 저장된 설정 대신 그 값으로 읽는다(설정 화면의 미리 듣기).
export const soundData = defineRpc({
  name: "sound.data",
  input: z.object({
    kind: z.enum(soundKinds),
    file: z.string().optional(),
    gain: z.number().optional(),
  }),
  output: z.object({ dataUrl: z.string(), path: z.string() }),
});

// 이 호스트에서 소리를 낼 수 있는지(윈도우·맥 데몬) 묻는다. 리눅스 서버는 소리 파일이 없다.
export const hostInfo = defineRpc({
  name: "host.info",
  input: z.object({}),
  // serverId·hostname(10-07): 웹 연결 목록에서 이 PC 항목 이름을 서버 번호 대신 컴퓨터 이름으로 보이게. 옛 판 데몬은 안 준다
  output: z.object({ platform: z.string(), canPlay: z.boolean(), serverId: z.string().nullable().optional(), hostname: z.string().optional() }),
});

// v2 자동 알림 음원. 구버전 자동 요청과 분리해 옛 catch/fallback도 무음 처리한다.
export const soundDataV2 = defineRpc({ name: "sound.data-v2", input: soundData.input, output: soundData.output });
