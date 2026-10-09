import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STT_HINTS } from "../shared/stt";
import { listProjects } from "./projects";
import { SAFE_HOST, sendRemoteFile } from "./projectLabels";

// 받아쓰기 이름 힌트(10-10) — 키 파일(google.env)과 같은 폴더의 글 파일 하나. 파일이 없으면 처음 내용, 비워 두면 힌트 없이.
// 설정 화면은 PC 플러그인만 붙으므로 저장은 PC 데몬이 받고, 프로젝트 목록에 있는 서버들에도 같은 파일을 보낸다.
const DIR = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar");
const NAME = "stt-hints.txt";
const FILE = join(DIR, NAME);

export function readSttHints(): string {
  try {
    return readFileSync(FILE, "utf8").replace(/^﻿/, "").trim();
  } catch {
    return DEFAULT_STT_HINTS;
  }
}

export async function saveSttHints(hints: string):
  Promise<{ ok: true; hosts: { host: string; ok: boolean }[] } | { ok: false; reason: "write" }> {
  const text = `${hints.replace(/\s+/g, " ").trim()}\n`;
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, FILE);
  } catch (error) {
    console.log(`[stt-hints] write failed: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    return { ok: false, reason: "write" };
  }
  const list = await listProjects();
  const servers = [...new Set(list.entries.map((e) => e.host))].filter((host) => host !== "PC" && SAFE_HOST.test(host));
  const hosts = await Promise.all(servers.map(async (host) => {
    // 서버 데몬도 ~/.paseo/claude-state-bar 에서 읽는다(google.env 와 같은 자리)
    const r = await sendRemoteFile(host, "~/.paseo/claude-state-bar", NAME, text);
    if (!r.ok) console.log(`[stt-hints] ${host} send failed: ${r.out}`);
    return { host, ok: r.ok };
  }));
  console.log(`[stt-hints] saved, sent ${hosts.filter((h) => h.ok).length}/${hosts.length}`);
  return { ok: true, hosts };
}
