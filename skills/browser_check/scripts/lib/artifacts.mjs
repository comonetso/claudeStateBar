// artifacts.retentionDays had no code behind it: 646 result folders, 77 MB, the oldest 24 days old under a 7-day setting
// (measured 2026-11-02), and they hold the text and captures of logged-in pages. Only folders with the exact name a run
// gives its folder are removed, only under the artifacts folder, and at most once a day. A folder from --out is never
// under it unless the caller put it there, and then only a name of this exact form would go.
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN_FOLDER = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const DAY = 86400000;
const MARK = '.last-prune';

/** A run's folder name → its time in ms, or null when the name is not one of ours. */
export function runFolderTime(name) {
  const m = RUN_FOLDER.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Remove run folders older than `days`. Returns how many went; never throws. */
export function pruneArtifacts(dir, days, now = Date.now()) {
  if (!dir || !(days >= 1)) return 0;
  const mark = join(dir, MARK);
  try { if (now - statSync(mark).mtimeMs < DAY) return 0; } catch { /* first time */ }
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const t = runFolderTime(name);
      if (t === null || now - t <= days * DAY) continue;
      try { rmSync(join(dir, name), { recursive: true, force: true }); removed++; } catch { /* in use — next time */ }
    }
    writeFileSync(mark, new Date(now).toISOString() + '\n');
  } catch { /* no folder yet */ }
  return removed;
}
