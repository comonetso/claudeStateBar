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
const LABEL = { "끝냄": "awaiting user check", "진행 중": "in progress", "할 일": "todo", "제안": "suggestion", "보류": "on hold" };

function sessionStart(cfg, project) {
  const open = loadAll(cfg).filter((it) => it.project === project && ORDER[it.state] !== undefined)
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (a.updated < b.updated ? 1 : -1));
  const lines = [
    `[work-ledger] Project "${project}" keeps a work ledger shared by the user and every AI tool. Command: ${LEDGER_CMD}  (in Git Bash also just: ledger)`,
    "Rules:",
    '- One user request = ONE big task: ledger add "<title in the user\'s language, the context a person remembers>". Each piece you fix or change inside it is a sub-item under it: ledger add "<piece>" --under <big task id>. Do not add pieces as top-level items — a person scans the big tasks and opens one to see its pieces. Put follow-up requests in the same context under the existing big task. Existing loose items can be moved: ledger move <id...> --under <big task id>.',
    '- Starting: ledger status <id> 진행 중. Finished: ledger status <id> 끝냄 --why "<how you verified it>" (sub-items too, then the big task). Only the user marks 확인됨 — on the big task, which also confirms its finished sub-items.',
    '- When the user changes something already decided or built (a layout, a rule, an approach), record it on the big task: ledger change <id> "<before> → <after>" --why "<the user\'s reason>". It shows only in the ? popup, so it is the trail of why things ended up this way.',
    '- When you offer several options or next steps, put them in: ledger suggest "<title>" "<title>" ...',
    '- If this turn has nothing to record (a question answered, a chat), run: ledger skip "<reason>". A turn that ends with no ledger record is blocked by a hook.',
    "- Use the 4-character id (e.g. a7k2). Keep titles short and concrete. Never edit the ledger files by hand.",
  ];
  const n = unpushedCount(cfg);
  if (n > 0) lines.push(`- Note: ${n} ledger commit(s) are not on GitHub yet — run: ledger sync`);
  if (open.length) {
    // big tasks first, their open sub-items indented under them
    const ids = new Set(open.map((it) => it.id));
    const heads = open.filter((it) => !it.parent || !ids.has(it.parent));
    lines.push(`Open items (${open.length}; big tasks with their sub-items indented):`);
    let n = 0;
    for (const h of heads) {
      if (n >= 40) break;
      lines.push(`  ${h.id.slice(-4)} [${LABEL[h.state]}] ${h.title}${h.parent ? ` (sub-item of ${h.parent.slice(-4)})` : ""}`); n++;
      for (const k of open.filter((x) => x.parent === h.id)) { lines.push(`      └ ${k.id.slice(-4)} [${LABEL[k.state]}] ${k.title}`); n++; }
    }
    if (open.length > n) lines.push(`  … ${open.length - n} more: ledger list`);
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
