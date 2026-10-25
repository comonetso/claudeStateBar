import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 중계기(router.mjs)는 플러그인 묶기 밖에서 Paseo 의 Node 로 돈다 — 플러그인 서버 코드는 Paseo 대화 연결 모듈
// (@getpaseo/client)을 가져오지 못하기 때문이다. 이 파일은 그 프로세스를 띄우고 지켜보기만 한다.
// 정한 값(근거): 다시 띄우기 5초는 Claude 가 정했다(2026-10-13, 리규형님 "알아서" — 보고함).
const RESTART_MS = 5_000;
// router.mjs 의 끝 번호: 3 = Paseo 연결 모듈을 못 찾았다(업데이트로 바뀜) — 다시 띄우지 않는다.
// 0 = 이미 다른 중계기가 돈다 — 플러그인을 다시 불러올 때 옛 중계기와 잠깐 겹치면 새 것이 0 으로 끝나고 옛 것도 곧 끝나
// 중계기가 하나도 없게 됐다(10-26 고침). 그래서 0 은 길게 기다렸다 다시 띄워 본다 — 진짜 다른 중계기가 돌면 또 0 으로 끝날 뿐이다.
// 정한 값(근거): 60초는 Claude 가 정했다(10-26 — 보고함).
const NO_RESTART = new Set([3]);
const BUSY_RECHECK_MS = 60_000;

export function startRouter(): () => void {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const script = join(home, "peer-mail", "router.mjs");
  const canonical = join(home, "plugin-data", "claude-state-bar", "project-list", "projects.json");
  const asar = join(dirname(process.execPath), "resources", "app.asar");
  if (!existsSync(canonical)) {
    console.log("[peer-mail] no canonical project list on this daemon — not the PC, router not started");
    return () => {};
  }
  if (!existsSync(script)) {
    console.log("[peer-mail] router.mjs is missing at " + script + " — run the peer-mail install script");
    return () => {};
  }
  if (!existsSync(asar)) {
    console.log("[peer-mail] the Paseo app bundle is not next to " + process.execPath + " — router not started");
    return () => {};
  }
  let child: ChildProcess | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (stopped) return;
    const c = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PEER_MAIL_ASAR: asar },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = c;
    c.stdout?.on("data", (d) => process.stdout.write(d));
    c.stderr?.on("data", (d) => process.stderr.write(d));
    c.on("exit", (code) => {
      child = null;
      if (stopped) return;
      if (code !== null && NO_RESTART.has(code)) {
        console.log("[peer-mail] router ended (" + code + ") — not restarting");
        return;
      }
      if (code === 0) {
        console.log("[peer-mail] another router is running — check again in " + BUSY_RECHECK_MS / 1000 + "s");
        timer = setTimeout(run, BUSY_RECHECK_MS);
        return;
      }
      console.log("[peer-mail] router exited (" + code + ") — restart in " + RESTART_MS / 1000 + "s");
      timer = setTimeout(run, RESTART_MS);
    });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (child) {
      child.stdin?.end();
      child.kill();
    }
  };
}
