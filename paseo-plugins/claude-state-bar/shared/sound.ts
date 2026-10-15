import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// compact = 압축 준비(10-15 리규형님) — 체크포인트 보고로 끝난 차례에 끝남 대신 낸다(server/soundEvents 가 가른다)
export const soundKinds = ["warning", "danger", "completion", "question", "workflow", "compact"] as const;
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

// 이 호스트에 있는 시스템 소리 파일 목록(10-12 리규형님: 경로를 직접 쓰는 칸 대신 선택 상자로 고르기).
// Windows = C:\Windows\Media 의 WAV, 맥 = /System/Library/Sounds. 그 밖(리눅스 서버)은 빈 목록
export const soundList = defineRpc({
  name: "sound.list",
  input: z.object({}),
  output: z.object({ files: z.array(z.object({ path: z.string(), name: z.string() })) }),
});

// 내 파일 고르기(10-12 리규형님: 컴퓨터에서 파일을 골라야) — 브라우저는 고른 파일의 경로를 주지 않으므로 내용을 이 데몬에 보내
// 플러그인 폴더(sounds/)에 저장하고 그 경로를 돌려준다. 상한 2MB(리규형님 결정). 확장자 wav·mp3·ogg
export const SOUND_UPLOAD_MAX = 2 * 1024 * 1024;
export const soundUpload = defineRpc({
  name: "sound.upload",
  input: z.object({ kind: z.enum(soundKinds), name: z.string().max(200), base64: z.string() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), path: z.string() }),
    z.object({ ok: z.literal(false), reason: z.enum(["type", "size", "write"]) }),
  ]),
});

// 이 호스트에서 소리를 낼 수 있는지(윈도우·맥 데몬) 묻는다. 리눅스 서버는 소리 파일이 없다.
export const hostInfo = defineRpc({
  name: "host.info",
  input: z.object({}),
  // serverId·hostname(10-07): 웹 연결 목록에서 이 PC 항목 이름을 서버 번호 대신 컴퓨터 이름으로 보이게. 옛 판 데몬은 안 준다
  // home(10-11): 직원용 Paseo 면 직원 홈(/home/<아이디>) — 직원이 시작 화면으로 들어오면 그 홈을 바로 연다
  output: z.object({
    platform: z.string(),
    canPlay: z.boolean(),
    serverId: z.string().nullable().optional(),
    hostname: z.string().optional(),
    team: z.boolean().optional(),
    home: z.string().optional(),
  }),
});

// v2 자동 알림 음원. 구버전 자동 요청과 분리해 옛 catch/fallback도 무음 처리한다.
export const soundDataV2 = defineRpc({ name: "sound.data-v2", input: soundData.input, output: soundData.output });
