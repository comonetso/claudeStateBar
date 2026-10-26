import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { confirmItem, saveMemo, viewLedger } from "../shared/ledger";
import { LedgerView } from "../shared/ledger";

// 데몬은 장부 명령(설치본)을 부를 뿐 — 장부 읽기·쓰기 규칙은 그 명령 하나에 있다
const LEDGER = path.join(os.homedir(), ".work-ledger", "app", "ledger.mjs");

/** 사람이 누른 단추로 부르는 것이라 AI 표시 환경변수를 지운다 — 장부 명령이 AI 로 보고 "확인됨"을 거부하지 않게 */
function humanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WORK_LEDGER_HOOKS: "0" };
  for (const k of Object.keys(env)) {
    if (k.startsWith("CLAUDE") || k.startsWith("CODEX_") || k.startsWith("CR_")) delete env[k];
  }
  delete env.PASEO_AGENT_ID;
  delete env.GEMINI_CLI;
  delete env.WORK_LEDGER_AGENT;
  return env;
}

function run(args: string[], cwd: string, input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(LEDGER)) {
      resolve({ code: 127, out: "", err: `장부 명령이 설치되지 않았습니다: ${LEDGER}` });
      return;
    }
    const child = spawn("node", [LEDGER, ...args], { cwd: fs.existsSync(cwd) ? cwd : os.homedir(), env: humanEnv(), windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.stdin.end(input ?? "");
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

export async function handleView({ directory }: RpcInput<typeof viewLedger>): Promise<RpcOutput<typeof viewLedger>> {
  const r = await run(["view", "--cwd", directory], directory);
  if (r.code === 0) {
    try {
      return LedgerView.parse(JSON.parse(r.out));
    } catch (e) {
      return empty(`장부를 읽지 못했습니다: ${String(e)}`);
    }
  }
  return empty(r.err.trim() || `장부 명령 실패(${r.code})`);
}

function empty(error: string): RpcOutput<typeof viewLedger> {
  return { project: "", enabled: false, owner: "", behind: 0, builtAt: "", error, items: [] };
}

export async function handleMemo({ directory, id, text }: RpcInput<typeof saveMemo>): Promise<RpcOutput<typeof saveMemo>> {
  const target = id ? [id] : ["project", "--cwd", directory];
  const args = text.trim() ? ["memo", ...target, "-"] : ["memo", ...target, "--clear"];
  const r = await run(args, directory, text);
  return { ok: r.code === 0, message: (r.code === 0 ? r.out : r.err).trim() };
}

export async function handleConfirm({ id }: RpcInput<typeof confirmItem>): Promise<RpcOutput<typeof confirmItem>> {
  const r = await run(["status", id, "확인됨"], os.homedir());
  return { ok: r.code === 0, message: (r.code === 0 ? r.out : r.err).trim() };
}
