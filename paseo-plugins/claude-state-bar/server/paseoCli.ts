import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// 이 기기의 paseo 명령어 위치 — 데몬 실행 파일 옆(PC 는 Paseo.exe 옆 resources\bin\paseo.cmd)을 먼저 보고 없으면 PATH.
// 서버 데몬은 PATH 가 짧을 수 있다(콜어드민은 데몬 PATH 에 paseo 가 없었다). 10-10 보관 동기화(rcSync)를 걷으며 거기서 옮겨 왔다.
export function findCli(): string | null {
  const dir = dirname(process.execPath);
  const win = process.platform === "win32";
  const near = win ? [join(dir, "resources", "bin", "paseo.cmd"), join(dir, "paseo.cmd")] : [join(dir, "paseo")];
  for (const c of near) if (existsSync(c)) return c;
  const names = win ? ["paseo.cmd", "paseo.exe"] : ["paseo"];
  for (const p of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    for (const n of names) if (p && existsSync(join(p, n))) return join(p, n);
  }
  return null;
}

/** paseo 명령 실행. .cmd(윈도우)는 cmd 를 거치므로 칸마다 큰따옴표로 싼다 — cmd 는 따옴표 안의 %…% 도 풀어서 " % 가 든 글은 받지 않는다.
 *  위쪽 제목(headerTitles)에서 계정 바꾸기(account)와 같이 쓰려고 옮겨 왔다(10-14) */
export function runPaseo(cli: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // Paseo 데몬이 켜 둔 값 — 남기면 명령어가 Electron 앱으로 뜨지 않는다(rcSync 와 같다)
  const shell = cli.toLowerCase().endsWith(".cmd");
  if (shell && args.some((a) => /["%\r\n]/.test(a))) return Promise.resolve({ ok: false, out: '이름에 " 나 % 가 있어 윈도우 명령으로 넘길 수 없습니다' });
  const argv = shell ? args.map((a) => `"${a}"`) : args;
  return new Promise((resolve) => {
    // 60초는 명령어가 멈췄을 때 다음 요청을 막지 않게 하는 안전장치(rcSync 와 같다)
    execFile(shell ? `"${cli}"` : cli, argv, { env, shell, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim().replace(/\s+/g, " ").slice(0, 200) }),
    );
  });
}
