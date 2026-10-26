import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { transcribeSpeech } from "./stt";

// 폰 받아쓰기의 받는 곳(10-10). Paseo 데몬 설정의 OpenAI 받아쓰기 칸을
//   providers.openai.stt = { baseUrl: "http://127.0.0.1:6768/v1", apiKey: <이 기기 stt.secret> }
// 로 돌리면 데몬이 말한 소리를 OpenAI 형식(multipart, POST /v1/audio/transcriptions)으로 여기 보내고 { text } 를 받는다.
// 이 기기 안에서만 열고(127.0.0.1), 키 칸의 값이 이 기기 비밀값과 같은 요청만 받는다.
// 포트는 데몬 기본 6767 바로 옆 — 10-10 PC·서버 3대 모두 비어 있음 확인(Claude 가 고름)
export const STT_PORT = 6768;
const DIR = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar");
export const STT_SECRET_FILE = join(DIR, "stt.secret");
// 플러그인을 다시 읽으면 새 판 모듈이 뜨는데 옛 판 서버가 포트를 쥐고 있을 수 있다 — 데몬 전역에 하나만 두고 새 판이 닫고 연다
const GLOBAL_KEY = "__claudeStateBar_sttServer";

function loadSecret(): string {
  try {
    const value = readFileSync(STT_SECRET_FILE, "utf8").trim();
    if (value) return value;
  } catch {
    /* 처음 — 만든다 */
  }
  const value = randomBytes(24).toString("hex");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STT_SECRET_FILE, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(STT_SECRET_FILE, 0o600);
  } catch {
    /* Windows */
  }
  console.log("[stt] created secret file");
  return value;
}

function sameSecret(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "", "utf8");
  const want = Buffer.from(secret, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// OpenAI 형식 오류 — 데몬은 이 message 를 "STT transcription failed: …" 로 받아 화면에 받아쓰기 실패로 알린다
const fail = (res: ServerResponse, status: number, message: string) =>
  sendJson(res, status, { error: { message, type: "server_error" } });

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || path !== "/v1/audio/transcriptions") return fail(res, 404, "not found");
  if (!sameSecret(req.headers.authorization, secret)) return fail(res, 401, "bad key");
  const started = Date.now();
  let audio: Buffer;
  let mimeType: string;
  try {
    const body = await readBody(req);
    const form = await new Response(body, { headers: { "content-type": String(req.headers["content-type"] ?? "") } }).formData();
    // 타입은 화면 쪽(React Native) FormData 가 잡혀 get 이 없다 — 데몬(Node)의 FormData 에는 있다
    const file = (form as unknown as { get(name: string): unknown }).get("file") as { arrayBuffer(): Promise<ArrayBuffer>; type: string } | string | null;
    if (!file || typeof file === "string") return fail(res, 400, "no audio file");
    audio = Buffer.from(await file.arrayBuffer());
    // 데몬은 늘 WAV 를 보낸다(openai/stt.js convertPCMToWavBuffer) — 형식이 비어 오면 WAV 로 본다
    mimeType = file.type && file.type !== "application/octet-stream" ? file.type : "audio/wav";
  } catch (error) {
    return fail(res, 400, `bad request: ${(error as Error).message}`);
  }
  const result = await transcribeSpeech(audio, mimeType);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!result.ok) {
    console.log(`[stt] failed ${result.status} ${result.error} audio=${Math.round(audio.length / 1024)}KB in ${seconds}s`);
    return fail(res, result.status, result.error);
  }
  console.log(`[stt] ok audio=${Math.round(audio.length / 1024)}KB text=${result.text.length} chars in ${seconds}s`);
  sendJson(res, 200, { text: result.text });
}

export function startSttServer(): () => void {
  const store = globalThis as unknown as Record<string, Server | undefined>;
  const previous = store[GLOBAL_KEY];
  let server: Server | undefined;
  let stopped = false;
  const open = () => {
    if (stopped) return;
    let secret: string;
    try {
      secret = loadSecret();
    } catch (error) {
      console.log(`[stt] secret file failed: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
      return;
    }
    server = createServer((req, res) => {
      handle(req, res, secret).catch((error) => {
        console.log(`[stt] error ${(error as Error).message}`);
        if (!res.headersSent) fail(res, 500, "internal error");
      });
    });
    server.on("error", (error) => console.log(`[stt] listen failed: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    server.listen(STT_PORT, "127.0.0.1", () => console.log(`[stt] listening 127.0.0.1:${STT_PORT}`));
    store[GLOBAL_KEY] = server;
  };
  // close 는 열린 연결이 다 끝나야 콜백이 온다 — 데몬이 붙잡은 연결도 같이 끊는다(이미 닫혔으면 오류 인자로 바로 온다)
  if (previous) {
    previous.close(() => open());
    previous.closeAllConnections();
  } else open();
  return () => {
    stopped = true;
    if (server && store[GLOBAL_KEY] === server) store[GLOBAL_KEY] = undefined;
    server?.close();
    server?.closeAllConnections();
  };
}
