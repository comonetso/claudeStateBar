import { constants } from "node:fs";
import { copyFile, link, mkdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

// 휴지통 두 개(실행 .trash · 채팅 .chat_trash)가 같이 쓰는 파일 다루기. Codex 독립 검토(10-05)에서 재현된 자료 손실 세 건을
// 막으려고 따로 뺐다: 다시 넣기가 휴지통 칸을 지움 · 확인과 옮기기 사이에 생긴 파일을 덮어씀 · 건너뛴 파일까지 칸째 지움.

/**
 * 휴지통 목록(meta.json)에 적힌 이름이 순수한 파일 이름인가. 경로 구분자·드라이브 접두·NTFS 대체 스트림(:)·'.'·'..'은
 * 받지 않는다. 이름 안의 점 두 개(`fixture..part.md`)는 경로 조각이 아니라서 받는다.
 */
export function isPlainName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\/:\0]/.test(name);
}

/**
 * 파일 하나를 dst 로 옮기되 dst 가 있으면 절대 덮어쓰지 않는다. "없는지 확인 → 옮기기"는 그 사이에 생긴 파일을 덮어쓰므로
 * 만들기 자체가 "있으면 실패"인 방법을 쓴다: 같은 볼륨이면 하드 링크(원래 파일 그대로, 수정 시각 보존) 뒤 원본 지우기,
 * 안 되면 "있으면 실패" 복사 뒤 수정 시각을 옮기고 원본 지우기. 수정 시각은 턴 시계가 읽어서 지켜야 한다.
 */
export async function moveNoClobber(src: string, dst: string): Promise<"moved" | "exists" | "failed"> {
  try {
    await link(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    try {
      const st = await stat(src);
      await copyFile(src, dst, constants.COPYFILE_EXCL);
      await utimes(dst, st.atime, st.mtime).catch(() => {});
    } catch (copyError) {
      return (copyError as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
    }
  }
  try {
    await unlink(src);
  } catch {
    /* 원본이 남아도 dst 에는 온전한 사본이 있다 — 칸 정리 때 남은 것으로 다시 본다 */
  }
  return "moved";
}

/** 같은 열쇠(휴지통 칸 하나)의 작업을 한 줄로 세운다. 같은 실행을 두 번 누르거나 넣기·꺼내기가 겹쳐도 차례로 돈다 */
const queues = new Map<string, Promise<unknown>>();
export function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** 실행 기록 폴더(.log)를 만들 때는 git 이 커밋 후보로 내밀지 않게 send.sh 와 같은 .gitignore 를 둔다 */
export async function ensureLogDir(logDir: string): Promise<void> {
  await mkdir(logDir, { recursive: true });
  try {
    await writeFile(join(logDir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch {
    /* 이미 있다 */
  }
}
