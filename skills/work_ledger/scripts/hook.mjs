#!/usr/bin/env node
// work-ledger hook — one script for Claude Code and Codex (same hook shapes).
//   node hook.mjs session-start   inject the ledger rules + this project's open items
//   node hook.mjs prompt          mark the start of a turn (a person spoke)
//   node hook.mjs stop            block the end of a turn that left no ledger record
// Runs only in projects turned on with `ledger on`. Silent everywhere else.
// Instructions to the agent are in English (plugin convention); item titles stay as written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, detectProject, loadAll, activitySince, CONFIG_DIR, unpushedCount } from "./ledger.mjs";

const APP = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_CMD = `node "${path.join(APP, "ledger.mjs").replace(/\\/g, "/")}"`;
const TURNS = path.join(CONFIG_DIR, "turns");

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}
function excluded() {
  const e = process.env;
  if (e.WORK_LEDGER_HOOKS === "0") return true;
  // codex_rescue runs (no person in the loop) carry CR_* variables
  return Object.keys(e).some((k) => k.startsWith("CR_"));
}
function sessionKey(input) {
  return String(input.session_id || input.sessionId || input.thread_id || process.env.CLAUDE_CODE_SESSION_ID || "").replace(/[^\w.-]/g, "");
}

const ORDER = { "끝냄": 0, "진행 중": 1, "할 일": 2, "제안": 3, "보류": 4 };
// AI 가 범위 전부 검증한 끝냄은 사람 확인 대기가 아니다(10-27 리규형님)
const labelOf = (it) => (it.state === "끝냄" && it.verify ? (it.verify.ai ? "AI verified" : "awaiting user: " + it.verify.ask) : LABEL[it.state]);
const LABEL = { "끝냄": "awaiting user check", "진행 중": "in progress", "할 일": "todo", "제안": "suggestion", "보류": "on hold" };

function sessionStart(cfg, project) {
  const all = loadAll(cfg);
  const open = all.filter((it) => it.project === project && ORDER[it.state] !== undefined)
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (a.updated < b.updated ? 1 : -1));
  const lines = [
    `[work-ledger] Project "${project}" keeps a work ledger shared by the user and every AI tool. Command: ${LEDGER_CMD}  (in Git Bash also just: ledger)`,
    "Rules:",
    '- Three levels: AREA > TASK > PIECE. An area is a long-running line of work (e.g. "작업 장부(work-ledger)", a plugin, deployment). One user request = ONE task under the area it belongs to: ledger add "<title in the user\'s language, the context a person remembers>" --under <area id>. Make a PIECE only for a part that must be tracked or finished on its own (ledger add "<piece>" --under <task id>); plain edits, test runs and progress go on the task itself as notes: ledger note <task id> "<what you did>". Adding a piece under a task that is already finished or confirmed reopens that task (the old confirmation covered only the old scope). If no listed area fits, create one first: ledger area "<area name>" (areas have no state; the screen shows a summary of their tasks). Put follow-up requests in the same context under the existing task. Never add pieces at the top level. Move loose items with: ledger move <id...> --under <area or task id> (a task takes its pieces along).',
    '- Choosing the area: pick by each area\'s rule line below, not by its name. When you create a new TASK, tell the user in one line of chat which area and title you used, so a wrong placement is caught at once. Creating a new AREA is rare: first ask the user with buttons (2-3 name candidates, each with its one-line rule), then: ledger area "<name>" --desc "<rule: what belongs here>". Without buttons, ask in plain text. In an unattended run, never create an area — add the task without --under (it shows under "no area") and report it.',
    '- Starting: ledger status <id> 진행 중 (this records the start time). Finished: ledger status <id> 끝냄 --why "<how you verified it>" (records the finish time; pieces too, then the task). Only the user marks 확인됨 — on the task, which also confirms its finished pieces.',
    '- Verify it yourself first. When finishing, say what is left for the user: add --verified if you checked the WHOLE scope yourself (tests, real screen via browser-check, real run) — it leaves the check list of the user. Add --ask "<one plain question for the user>" when part of it only a person can judge (sound, feel on the phone, taste, a real-world result) — only that question is shown to the user. Type checks or unit tests alone do not verify what a person sees or hears. Never ask the user to approve every finished task.',
    '- Keep the "where are we" summary current: when a task finishes or the picture changes, rewrite the area summary in 2-3 plain lines (what works now · what is left · next candidates): ledger summary <area id> "<text>". Rewrite the project summary the same way when the big picture moves: ledger summary project "<text>". These are the first thing the user reads.',
    '- When the user changes something already decided or built (a layout, a rule, an approach), record it on the task: ledger change <id> "<before> → <after>" --why "<the user\'s reason>". It shows only in the ? popup, so it is the trail of why things ended up this way.',
    '- When you offer several options or next steps, put them in: ledger suggest "<title>" "<title>" ...',
    '- If this turn has nothing to record (a question answered, a chat), run: ledger skip "<reason>". A turn that ends with no ledger record is blocked by a hook.',
    "- Use the 4-character id (e.g. a7k2). Keep titles short and concrete. Never edit the ledger files by hand.",
  ];
  const n = unpushedCount(cfg);
  if (n > 0) lines.push(`- Note: ${n} ledger commit(s) are not on GitHub yet — run: ledger sync`);
  // areas (all of them, so a new task can be placed) → their open tasks → open pieces
  const areas = all.filter((it) => it.project === project && it.area);
  const tasks = open.filter((it) => !it.area && (!it.parent || areas.some((a) => a.id === it.parent) || !all.some((x) => x.id === it.parent)));
  const pieces = open.filter((it) => !it.area && !tasks.includes(it));
  // 대작업마다 "여기에 들어가는 일" 기준 한 줄(설명 첫 줄)을 같이 보인다 — AI 가 이름만 보고 짐작하지 않게(10-26 리규형님)
  if (areas.length) {
    lines.push("Areas (pick the one whose rule fits; create a new area only when none fits):");
    for (const a of areas) {
      const rule = (a.desc || "").split("\n").map((s) => s.trim()).find(Boolean) || "(no rule yet)";
      lines.push(`  ${a.id.slice(-4)} ${a.title} — ${rule}`);
    }
  }
  if (tasks.length || pieces.length) {
    lines.push(`Open items (${tasks.length + pieces.length}; area > task > piece):`);
    let n = 0;
    const show = (t, pad) => {
      if (n >= 40) return;
      lines.push(`${pad}${t.id.slice(-4)} [${labelOf(t)}] ${t.title}`); n++;
      for (const k of pieces.filter((x) => x.parent === t.id)) { if (n >= 40) return; lines.push(`${pad}    └ ${k.id.slice(-4)} [${labelOf(k)}] ${k.title}`); n++; }
    };
    for (const a of areas) {
      const mine = tasks.filter((t) => t.parent === a.id);
      if (!mine.length || n >= 40) continue;
      lines.push(`  ▣ ${a.id.slice(-4)} ${a.title}`);
      for (const t of mine) show(t, "    ");
    }
    const loose = tasks.filter((t) => !t.parent || !areas.some((a) => a.id === t.parent));
    if (loose.length && n < 40) { lines.push("  ▣ (no area — move these under one)"); for (const t of loose) show(t, "    "); }
    const shown = n;
    if (tasks.length + pieces.length > shown) lines.push(`  … ${tasks.length + pieces.length - shown} more: ledger list`);
  } else lines.push("Open items: none.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function prompt(cfg, project, input) {
  const key = sessionKey(input);
  if (!key) return;
  fs.mkdirSync(TURNS, { recursive: true });
  fs.writeFileSync(path.join(TURNS, `${key}.json`), JSON.stringify({ t: Date.now(), project }), "utf8");
}

// Another session of the same project whose turn had started by time t and has not been closed by its stop hook
function otherOpenTurn(key, project, t) {
  let files = [];
  try { files = fs.readdirSync(TURNS); } catch { return false; }
  for (const f of files) {
    if (!f.endsWith(".json") || f === `${key}.json`) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(TURNS, f), "utf8"));
      if (o && !o.done && o.project === project && o.t <= t) return true;
    } catch {}
  }
  return false;
}

function stop(cfg, project, input) {
  const key = sessionKey(input);
  if (input.stop_hook_active) { // already continued once for this turn — never loop; close the turn for otherOpenTurn
    if (key) try { const p = path.join(TURNS, `${key}.json`); fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), done: true }), "utf8"); } catch {}
    return;
  }
  if (!key) return;
  let turn;
  try { turn = JSON.parse(fs.readFileSync(path.join(TURNS, `${key}.json`), "utf8")); } catch { return; }
  if (!turn || turn.done) return;
  // A record without a session id counts only when no other conversation of this project has a turn open —
  // otherwise one conversation's record or skip let another one's unrecorded turn through (10-26 Codex review).
  const proj = turn.project || project;
  const hits = activitySince(turn.t).filter((a) => a.session === key || (!a.session && a.project === proj && !otherOpenTurn(key, proj, a.t)));
  if (hits.length) {
    fs.writeFileSync(path.join(TURNS, `${key}.json`), JSON.stringify({ ...turn, done: true }), "utf8");
    return;
  }
  const reason = [
    "[work-ledger] This turn left no ledger record.",
    'If the user asked for work, add or update it (ledger add / ledger status). If you offered several options, ledger suggest them. If the user changed something already decided, ledger change it.',
    'If there is truly nothing to record, run: ledger skip "<reason>".',
    `Command: ${LEDGER_CMD}`,
    "Then finish your reply as before — do not repeat what you already told the user.",
  ].join(" ");
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

function main() {
  const event = process.argv[2];
  const input = readInput();
  if (excluded()) return;
  const cfg = loadConfig();
  const cwd = input.cwd || process.cwd();
  const project = detectProject(cfg, cwd);
  if (!(cfg.enabledProjects || []).includes(project)) return;
  try {
    if (event === "session-start") sessionStart(cfg, project);
    else if (event === "prompt") prompt(cfg, project, input);
    else if (event === "stop") stop(cfg, project, input);
  } catch (e) {
    process.stderr.write(`work-ledger hook: ${e.message}\n`); // never break the session over the ledger
  }
}

main();
