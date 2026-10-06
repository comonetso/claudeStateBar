// 확장 media/codexruns.js 와 같은 표기

// 진행 중 색 — 확장 Codex 카드 점(media/codexruns.css .dot.running)과 같은 주황. 테마 강조색은 테마에 따라 완료(초록)와 헷갈려서 고정(리규형님 10-06)
export const RUNNING_COLOR = "#e3b341";

const pad2 = (n: number) => String(n).padStart(2, "0");

export function fmtDur(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtClock(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return today ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

// Codex 진행 카드 시계(확장 fmtClock·fmtElapsed·fmtHM): "10/05 04:12 · 소요 01:20"
export function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtHM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtElapsed(ms: number): string {
  const t = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** 1023 B · 4.2 KB · 87 MB · 1.2 GB — 확장 usageFile.ts formatBytes */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

function trimZero(x: number): string {
  const v = x.toFixed(1);
  return v.endsWith(".0") ? v.slice(0, -2) : v;
}

export function fmtTok(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1000) return `${trimZero(n / 1000)}k`;
  return String(n);
}
