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
