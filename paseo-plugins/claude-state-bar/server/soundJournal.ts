import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function soundDataFile(name: string): string {
  return join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", name);
}

// 손상/쓰기 실패는 무음으로 닫는다. 파일 sync 후에만 승인 응답을 보낸다. 단일 Paseo 플러그인 subprocess가 유일한 작성자다.
// 오래된 기록은 쓰는 쪽이 rewrite 로 정리한다(PC 원장은 데몬이 켜질 때 — server/soundClaim, 10-08 Claude).
export class SoundJournal<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private failed: unknown;
  constructor(private readonly file: string, private readonly restore: (value: T) => void) {}
  serial<R>(run: () => Promise<R>): Promise<R> {
    const next = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.loaded) {
        try {
          let text = "";
          try { text = await readFile(this.file, "utf8"); }
          catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
          if (text && !text.endsWith("\n")) throw new Error("소리 기록의 마지막 줄이 불완전함");
          for (const line of text.split("\n")) if (line) this.restore(JSON.parse(line) as T);
          this.loaded = true;
        } catch (e) { this.failed = e; throw e; }
      }
      return run();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async append(value: T): Promise<void> {
    let handle;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      handle = await open(this.file, "a");
      await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
      await handle.sync();
    } catch (e) { this.failed = e; throw e; }
    finally { await handle?.close(); }
  }
  /** 남길 줄만으로 파일을 바꿔 끼운다 — 임시 파일에 다 쓰고 sync 한 뒤 이름을 바꿔, 중간에 끊겨도 옛 파일이나 새 파일 둘 중 하나만 남는다.
   *  실패해도 옛 파일은 그대로라 기록이 닫히지 않는다(부르는 쪽이 로그만 남긴다). serial 안에서 부른다 */
  async rewrite(values: T[]): Promise<void> {
    const temp = `${this.file}.compact`;
    let handle;
    try {
      handle = await open(temp, "w");
      await handle.writeFile(values.map((v) => JSON.stringify(v) + "\n").join(""), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, this.file);
    } catch (e) {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      throw e;
    }
  }
}
