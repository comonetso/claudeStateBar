import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { googleKeysFile } from "./googleKeys";
import { isTeamDaemon } from "./sound";

// 리규형님 키가 바뀌면 같은 서버 팀원의 키 사본도 같은 내용으로 맞춘다(10-13 리규형님 결정 "따라가게 하기").
// 그 전에는 팀원 관리 화면의 "서버에 반영" 때만 서버 팀원 도구(team-daemon ctl.py)가 복사해서, 리규형님이 나중에 넣은
// Anthropic 키가 대표님 사본엔 없었다. 반영 때 복사하는 쪽은 그대로 둔다(팀원을 새로 만들 때 첫 사본).
// 팀원 폴더 = 서버 팀원 도구의 인스턴스 자리(ctl.py DATA + '/instances/<아이디>/paseo') — 팀원 데몬의 PASEO_HOME 이 여기에 붙는다

/** 시험에서만 바꾼다 */
const INSTANCES = process.env.CSB_TEAM_INSTANCES || "/var/lib/paseo-team/instances";

/** 지금 리규형님 키로 팀원 사본을 맞추고 바꾼 팀원 아이디를 돌려준다. 키 값은 어디에도 찍지 않는다 */
export function syncTeamKeys(): string[] {
  let source: string;
  // 리규형님 키 파일이 없거나 못 읽으면 아무것도 하지 않는다 — 통째로 바꿔 넣는 중일 수 있어 팀원 사본을 지우지 않는다
  try { source = readFileSync(googleKeysFile(), "utf8"); } catch { return []; }
  let ids: string[];
  try { ids = readdirSync(INSTANCES); } catch { return []; }
  const changed: string[] = [];
  for (const id of ids) {
    const home = join(INSTANCES, id, "paseo");
    let owner: { uid: number; gid: number };
    try {
      const st = statSync(home);
      if (!st.isDirectory()) continue;
      owner = { uid: st.uid, gid: st.gid };
    } catch { continue; }
    const dir = join(home, "claude-state-bar");
    const target = join(dir, "google.env");
    try { if (readFileSync(target, "utf8") === source) continue; } catch { /* 사본이 아직 없다 */ }
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { mode: 0o700 });
        chownSync(dir, owner.uid, owner.gid);
      }
      // 팀원 데몬이 반쯤 쓴 파일을 읽지 않게 옆에 쓰고 바꿔 넣는다. 팀원만 읽게(서버 팀원 도구와 같은 600)
      const temp = `${target}.csb-${process.pid}`;
      writeFileSync(temp, source, { mode: 0o600 });
      chmodSync(temp, 0o600);
      chownSync(temp, owner.uid, owner.gid);
      renameSync(temp, target);
      changed.push(id);
    } catch (error) {
      console.log(`[team-keys] ${id} 사본을 맞추지 못했습니다: ${(error as NodeJS.ErrnoException).code ?? "오류"}`);
    }
  }
  if (changed.length) console.log(`[team-keys] 팀원 키 사본을 리규형님 키와 맞춤: ${changed.join(", ")}`);
  return changed;
}

/** 서버의 리규형님 데몬에서만 켠다 — PC·팀원 도구가 없는 서버·팀원 데몬(울타리 안) 자신은 아무것도 안 한다 */
export function startTeamKeySync(): () => void {
  if (process.platform !== "linux" || isTeamDaemon() || !existsSync(INSTANCES)) return () => {};
  syncTeamKeys();
  // 키 파일은 손으로 고치거나 통째로 바꿔 넣는다 — 바꿔 넣으면 파일 감시가 끊기므로 폴더를 본다
  const file = googleKeysFile();
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(file), (_event, name) => {
      if (!name || name === basename(file)) syncTeamKeys();
    });
  } catch { /* 폴더가 아직 없으면 시작할 때 한 번만 맞춘다 */ }
  return () => watcher?.close();
}
