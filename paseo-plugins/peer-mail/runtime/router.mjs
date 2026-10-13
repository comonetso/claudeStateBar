// router.mjs — PC 의 peer_mail 중계기 (Paseo 의 Node 로 돈다 — 플러그인 peer-mail 이 띄운다)
//
// 리규형님 결정(2026-10-13): 리모트 컨트롤을 쓰지 않는다. PC 가 중계한다. 서버에 PC 열쇠를 새로 주지 않는다.
//   · PC 가 서버마다 SSH 연결 하나를 열어 서버의 bridge.cjs 를 띄운다 — 서버가 보낸 우편이 그 연결로 올라온다
//   · 상대 대화에 넣는 일은 Paseo 의 대화 연결(paseo CLI 가 쓰는 연결 기능)로 한다 — PC 는 그대로, 서버는 ssh:// 로
//   · 넣을 때는 "끼워 넣기(steer)" — 일하는 중인 대화를 끊지 않는다(2026-10-13 실측: 이 대화에서 확인)
//   · 받는 대화에 권한·질문 창이 떠 있으면 넣지 않고 기다린다 — 넣으면 그 창이 "거부"로 닫힌다(Paseo 0.11.1 코드)
//   · 짝 = 프로젝트 매니저 "보임" 프로젝트. 보낸 대화는 그 기기 Paseo 에 실제로 열린 대화이고 그 폴더가 보임이어야 한다
//   · 답(접수 확인·결과)은 원래 보낸 대화에만, 요청을 넣은 그 대화가 보낸 것만 돌려준다(ledger)
// 🔴 이 파일은 플러그인 묶기 밖이다(플러그인 서버 코드는 @getpaseo/client 를 가져오지 못한다). Paseo 앱 묶음 안의
//    CLI 연결 기능을 가져다 쓴다 — Paseo 업데이트로 그 경로·함수가 바뀌면 시작 때 실패하고 멈춘다(끊는 쪽으로 넘어가지 않는다).
// 🔴 기록(router.log)에 본문을 남기지 않는다. 번호·상태만.
//
// 정한 값(근거): 핑 30초·재연결 5초→최대 60초·보류 재확인 10초는 Claude 가 정했다(2026-10-13, 리규형님 "알아서" — 보고함).
//               SSH ServerAliveInterval 15 · CountMax 3 은 기존 browser-check 터널 설정(~/.ssh/config bc-tunnel-calladmin)과 같다.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const util = require("./lib/util.cjs");
const envl = require("./lib/envelope.cjs");
const mailbox = require("./lib/mailbox.cjs");
const projects = require("./lib/projects.cjs");

const PING_MS = 30_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const HELD_MS = 10_000;

const ROUTER_DIR = path.join(mailbox.base(), "router");
util.mkdirp(ROUTER_DIR);
const LOG = path.join(ROUTER_DIR, "router.log");

function log(msg) {
  const line = new Date().toISOString() + " " + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {
    /* 기록 실패는 무시 */
  }
}

// ── 한 대만: router.pid
const PID = path.join(ROUTER_DIR, "router.pid");
try {
  const old = Number(fs.readFileSync(PID, "utf8"));
  if (old && old !== process.pid) {
    try {
      process.kill(old, 0);
      log("another router is running (pid " + old + ") — exiting");
      process.exit(0);
    } catch {
      /* 죽은 기록 */
    }
  }
} catch {
  /* 없음 */
}
fs.writeFileSync(PID, String(process.pid));

// ── 상태 파일
function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROUTER_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(name, value) {
  util.writeJsonAtomic(path.join(ROUTER_DIR, name), value);
}
const ledger = loadJson("ledger.json", {}); // request_id → { src_host, src_agent, src_key, dst_host, dst_agent, dst_key, at }
const seen = loadJson("seen.json", {}); // item id → 처리한 때
const memory = loadJson("memory.json", {}); // 프로젝트 열쇠 → 받았다고 답한 대화 id
let held = loadJson("held.json", []); // 권한 창 때문에 미룬 넣기
const pendingInbox = loadJson("pending-inbox.json", {}); // host → 연결이 끊겨 못 넣은 알림

// ── Paseo 대화 연결 (paseo CLI 가 쓰는 연결 기능)
const ASAR = process.env.PEER_MAIL_ASAR;
if (!ASAR || !fs.existsSync(ASAR)) {
  log("PEER_MAIL_ASAR is not set or missing — cannot reach Paseo. exiting");
  process.exit(3);
}
let connectToDaemon;
try {
  ({ connectToDaemon } = await import(pathToFileURL(path.join(ASAR, "node_modules", "@getpaseo", "cli", "dist", "utils", "client.js")).href));
  if (typeof connectToDaemon !== "function") throw new Error("connectToDaemon not exported");
} catch (e) {
  log("cannot load the Paseo connection module (" + e.message + ") — a Paseo update may have moved it. exiting");
  process.exit(3);
}

const clients = new Map();
function getClient(host) {
  if (!clients.has(host)) {
    const target = host === "PC" ? { kind: "instance", home: mailbox.paseoHome() } : { kind: "endpoint", host: "ssh://" + host };
    const p = connectToDaemon({ target, timeout: 20_000 });
    p.catch(() => clients.delete(host));
    clients.set(host, p);
  }
  return clients.get(host);
}
function dropClient(host) {
  const p = clients.get(host);
  clients.delete(host);
  if (p) p.then((c) => c.close()).catch(() => {});
}
async function withDaemon(host, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(await getClient(host));
    } catch (e) {
      dropClient(host);
      if (attempt >= 1) throw e;
    }
  }
}
const agentOf = (r) => (r && (r.agent || r)) || null;
async function getAgent(host, id) {
  return agentOf(await withDaemon(host, (c) => c.fetchAgent({ agentId: id })));
}
async function listAgents(host) {
  const r = await withDaemon(host, (c) => c.fetchAgents({}));
  return ((r && (r.entries || r.agents)) || []).map(agentOf).filter((a) => a && a.id && !a.archivedAt);
}

// 넣기 — 권한·질문 창이 떠 있으면 넣지 않는다. 일하는 중이면 끼워 넣는다(steer)
async function inject(host, agentId, text, messageId) {
  const a = await getAgent(host, agentId);
  if (!a || a.archivedAt) return { ok: false, reason: "gone" };
  if ((a.pendingPermissions || []).length) return { ok: false, reason: "permission" };
  await withDaemon(host, (c) => c.sendAgentMessage(agentId, text, { activeTurnBehavior: "steer", messageId }));
  return { ok: true, status: a.status, title: a.title || null };
}

// ── 연결(채널): PC 자신 + 서버마다 SSH
const channels = new Map(); // host → { send(obj), hello }

function mailPathFor(host) {
  const ch = channels.get(host);
  return ch && ch.hello && ch.hello.mail ? ch.hello.mail : null;
}

function sendInbox(host, item) {
  const ch = channels.get(host);
  if (ch && ch.ready) {
    ch.send({ op: "inbox", item });
    return;
  }
  (pendingInbox[host] = pendingInbox[host] || []).push(item);
  saveJson("pending-inbox.json", pendingInbox);
}
function flushInbox(host) {
  const list = pendingInbox[host];
  if (!list || !list.length) return;
  const ch = channels.get(host);
  delete pendingInbox[host];
  saveJson("pending-inbox.json", pendingInbox);
  for (const item of list) ch.send({ op: "inbox", item });
}

function startLocal() {
  const ch = {
    ready: true,
    hello: { host: "PC", mail: path.join(mailbox.base(), "mail.cjs") },
    send(m) {
      if (m.op === "ack") mailbox.move("outbox", "sent", m.name);
      else if (m.op === "inbox") {
        try {
          mailbox.put("inbox", m.item);
        } catch (e) {
          log("local inbox write failed: " + e.message);
        }
      }
    },
  };
  channels.set("PC", ch);
  mailbox.ensureDirs();
  const scan = () => {
    for (const name of mailbox.list("outbox")) {
      const item = mailbox.read("outbox", name);
      if (item) void handleItem("PC", name, item);
    }
  };
  scan();
  fs.watch(mailbox.dir("outbox"), () => scan());
  setInterval(scan, PING_MS).unref();
  flushInbox("PC");
}

function startRemote(host) {
  if (channels.has(host)) return;
  const ssh = util.findOnPath("ssh");
  if (!ssh) {
    log("ssh not found in PATH — cannot reach " + host);
    return;
  }
  let retry = RETRY_MIN_MS;
  let stopped = false;
  const ch = { ready: false, hello: null, child: null, send(m) {
    if (ch.child && ch.child.stdin.writable) ch.child.stdin.write(JSON.stringify(m) + "\n");
  }, stop() {
    stopped = true;
    if (ch.child) ch.child.kill();
  } };
  channels.set(host, ch);
  const open = () => {
    if (stopped) return;
    const args = ["-T", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ClearAllForwardings=yes", "--", host, "bash -lc 'exec node \"$HOME/.paseo/peer-mail/bridge.cjs\"'"];
    const child = spawn(ssh, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    ch.child = child;
    let buf = "";
    let errTail = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.op === "hello") {
          if (m.host !== host) {
            log(host + ": bridge says it is " + JSON.stringify(m.host) + " — closing (name mismatch)");
            child.kill();
            return;
          }
          ch.hello = m;
          ch.ready = true;
          retry = RETRY_MIN_MS;
          log(host + ": connected (node " + m.node + ")");
          flushInbox(host);
        } else if (m.op === "item" && typeof m.name === "string") {
          void handleItem(host, m.name, m.item);
        } else if (m.op === "error") {
          log(host + ": bridge error " + String(m.detail).slice(0, 200));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (errTail = (errTail + d).slice(-500)));
    const ping = setInterval(() => ch.send({ op: "ping" }), PING_MS);
    child.on("exit", (code) => {
      clearInterval(ping);
      ch.ready = false;
      ch.child = null;
      if (stopped) return;
      log(host + ": connection closed (exit " + code + ")" + (errTail.trim() ? " " + errTail.trim().split("\n").pop() : "") + " — retry in " + retry / 1000 + "s");
      setTimeout(open, retry);
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    });
  };
  open();
}

function ack(host, name) {
  const ch = channels.get(host);
  if (ch) ch.send({ op: "ack", name });
}

// 프로젝트 목록이 바뀌면 서버 연결을 맞춘다(보임 프로젝트가 있는 서버만)
function reconcile() {
  const p = projects.load();
  if (!p.ok) {
    log("project list: " + p.error);
    return;
  }
  const hosts = new Set(p.entries.filter((e) => e.enabled && e.host !== "PC").map((e) => e.host));
  for (const h of hosts) startRemote(h);
  for (const [h, ch] of channels) if (h !== "PC" && !hosts.has(h)) {
    ch.stop();
    channels.delete(h);
    log(h + ": no visible project any more — disconnected");
  }
}

// ── 우편 처리
const working = new Set();

function validItem(item) {
  return item && typeof item === "object" && envl.UUID_RE.test(item.id || "") && envl.UUID_RE.test(item.request_id || "") && ["request", "ack", "result"].includes(item.kind) && typeof item.message === "string" && typeof item.from_agent === "string" && item.from_agent.length > 0;
}

async function handleItem(host, name, item) {
  const key = host + "/" + name;
  if (working.has(key)) return;
  working.add(key);
  try {
    if (!validItem(item) || name !== item.id + ".json") {
      log(host + ": dropped a malformed item " + name);
      ack(host, name);
      return;
    }
    if (seen[item.id]) {
      ack(host, name);
      return;
    }
    if (item.kind === "request") await routeRequest(host, item);
    else await routeReply(host, item);
    seen[item.id] = new Date().toISOString();
    saveJson("seen.json", seen);
    ack(host, name);
  } catch (e) {
    log(host + ": item " + item.id + " failed (" + (e && e.message ? e.message : e) + ") — will retry");
  } finally {
    working.delete(key);
  }
}

function composeFor(host, message, kind, requestId) {
  const mail = mailPathFor(host);
  const nl = message.indexOf("\n");
  const first = nl < 0 ? message : message.slice(0, nl);
  const rest = nl < 0 ? "" : message.slice(nl);
  const m = mail ? '"' + mail + '"' : "<peer-mail>/mail.cjs";
  const how =
    kind === "request"
      ? [
          "How to handle it (peer_mail relay — if a skill named peer_mail is available, load it first):",
          "1. Save this whole message unchanged to a file in your temp folder.",
          "2. Run: node " + m + ' receive --message-file "<that file>" — it records the request and queues the acknowledgement for you. Follow its instruction.',
          "3. Write the answer to a file, then run: node " + m + " reply --id " + requestId + ' --status <completed|awaiting_user|failed> --body-file "<file>"',
        ]
      : ["How to handle it (peer_mail relay):", "1. Save this whole message unchanged to a file in your temp folder.", "2. Run: node " + m + ' ingest --message-file "<that file>"', "Then tell the user. Never reply to this message."];
  return first + "\n\n" + how.join("\n") + "\n" + rest;
}

function noticeText(host, requestId, status, reason, candidates) {
  const mail = mailPathFor(host);
  const m = mail ? '"' + mail + '"' : "<peer-mail>/mail.cjs";
  const lines = [
    "[" + util.PROTOCOL + "] 전달 안 됨(" + status + ") · 요청 " + util.shortId(requestId),
    "",
    "This notice comes from the peer_mail relay, not from the user. Your request could not be delivered: " + reason,
  ];
  if (candidates && candidates.length) {
    lines.push("", "Open conversations in that project — ask the user which one, then resend to it:");
    for (const c of candidates) lines.push("  · " + c.id + "  " + (c.title || "(no title)") + "  [" + c.status + "]");
    lines.push("", "Resend: node " + m + " send --request-id " + requestId + " --agent <conversation id>");
  }
  lines.push("", "Record this notice first: node " + m + " inbox", "Then tell the user in one or two lines.");
  return lines.join("\n");
}

async function notifySender(srcHost, srcAgent, requestId, attemptId, status, reason, candidates, wake) {
  sendInbox(srcHost, { id: util.uuid(), kind: "relay", request_id: requestId, attempt_id: attemptId, status, detail: reason, candidates: candidates || null, at: new Date().toISOString() });
  if (!wake) return;
  const text = noticeText(srcHost, requestId, status, reason, candidates);
  const r = await inject(srcHost, srcAgent, text, util.uuid()).catch((e) => ({ ok: false, reason: e.message }));
  if (!r.ok && r.reason === "permission") holdInject(srcHost, srcAgent, text, util.uuid(), null);
}

function holdInject(host, agent, text, messageId, after) {
  held.push({ host, agent, text, messageId, after, since: new Date().toISOString() });
  saveJson("held.json", held);
}

async function routeRequest(host, item) {
  const p = projects.load();
  if (!p.ok) throw new Error("project list: " + p.error);
  let env;
  try {
    env = envl.extractEnvelope(item.message);
  } catch (e) {
    log(host + ": request " + item.request_id + " has no readable envelope — dropped");
    return;
  }
  const problems = envl.checkEnvelope(env);
  if (problems.length || env.type !== "request" || env.request_id !== item.request_id || env.attempt_id !== item.id) {
    log(host + ": request " + item.request_id + " envelope check failed — dropped (" + problems.join("; ") + ")");
    return;
  }
  // 보낸 대화 확인 — 그 기기에 실제로 열린 대화이고, 그 폴더가 보임 프로젝트이며, 봉투의 보낸 곳과 같아야 한다
  const src = await getAgent(host, item.from_agent);
  if (!src || src.archivedAt) {
    log(host + ": request " + item.request_id + " from an unknown conversation " + item.from_agent + " — dropped");
    return;
  }
  const srcProj = projects.projectOf(p.entries, host, src.cwd);
  const plat = projects.platformOfHost(host);
  if (!srcProj || !srcProj.enabled || env.sender_host !== host || !util.samePath(env.sender_root, srcProj.path, plat)) {
    log(host + ": request " + item.request_id + " sender check failed (cwd " + src.cwd + ") — refused");
    await notifySender(host, item.from_agent, item.request_id, item.id, "unreachable", "the sending conversation's folder is not a visible project in the project manager (or the envelope does not match it)", null, true);
    return;
  }
  // 받는 프로젝트 — 보임이어야 한다
  const to = item.to || {};
  const tKey = projects.keyOf(String(to.host || ""), String(to.path || ""));
  const target = p.entries.find((e) => e.key === tKey);
  if (!target || !target.enabled || env.recipient_host !== target.host || !util.samePath(env.recipient_root, target.path, projects.platformOfHost(target.host))) {
    await notifySender(host, item.from_agent, item.request_id, item.id, "unreachable", "the target is not a visible project in the project manager (or the envelope does not match it)", null, true);
    return;
  }
  // 받을 대화 고르기 — 그 프로젝트에서 가장 구체적으로 열린 대화
  const agents = await listAgents(target.host);
  const cands = agents.filter((a) => {
    const pr = projects.projectOf(p.entries, target.host, a.cwd);
    return pr && pr.key === tKey && !(target.host === host && a.id === item.from_agent);
  });
  const brief = (a) => ({ id: a.id, title: a.title || null, status: a.status || null });
  let chosen = null;
  if (to.agent) {
    const hit = cands.filter((a) => a.id === to.agent || (to.agent.length >= 8 && a.id.indexOf(to.agent) === 0));
    if (hit.length !== 1) {
      await notifySender(host, item.from_agent, item.request_id, item.id, "ask", 'the chosen conversation "' + to.agent + '" is not open in ' + target.name, cands.map(brief), true);
      return;
    }
    chosen = hit[0];
  } else if (memory[tKey] && cands.some((a) => a.id === memory[tKey])) {
    chosen = cands.find((a) => a.id === memory[tKey]);
  } else if (cands.length === 1) {
    chosen = cands[0];
  } else if (cands.length === 0) {
    await notifySender(host, item.from_agent, item.request_id, item.id, "unreachable", "no Paseo conversation is open in " + target.name + " (" + target.host + ":" + target.path + ")", null, true);
    return;
  } else {
    await notifySender(host, item.from_agent, item.request_id, item.id, "ask", cands.length + " conversations are open in " + target.name, cands.map(brief), true);
    return;
  }
  ledger[item.request_id] = { src_host: host, src_agent: item.from_agent, src_key: srcProj.key, dst_host: target.host, dst_agent: chosen.id, dst_key: tKey, at: new Date().toISOString() };
  saveJson("ledger.json", ledger);
  const text = composeFor(target.host, item.message, "request", item.request_id);
  const r = await inject(target.host, chosen.id, text, item.id);
  if (r.ok) {
    log("delivered request " + util.shortId(item.request_id) + " " + host + " → " + target.host + " " + chosen.id.slice(0, 8));
    await notifySender(host, item.from_agent, item.request_id, item.id, "delivered", "delivered to " + target.name + " · " + (chosen.title || chosen.id.slice(0, 8)) + (r.status === "running" ? " (it was working — slipped in without interrupting)" : ""), null, false);
  } else if (r.reason === "permission") {
    holdInject(target.host, chosen.id, text, item.id, { kind: "request", request_id: item.request_id, src_host: host, src_agent: item.from_agent, attempt_id: item.id, target: target.name });
    log("held request " + util.shortId(item.request_id) + " — " + target.host + " " + chosen.id.slice(0, 8) + " is waiting on a permission prompt");
    await notifySender(host, item.from_agent, item.request_id, item.id, "held", target.name + " is waiting on its user's permission/question prompt — it will be delivered once that is answered", null, false);
  } else {
    await notifySender(host, item.from_agent, item.request_id, item.id, "unreachable", "the conversation in " + target.name + " closed before delivery", null, true);
  }
}

async function routeReply(host, item) {
  const L = ledger[item.request_id];
  if (!L) {
    log(host + ": " + item.kind + " for an unknown request " + item.request_id + " — dropped");
    return;
  }
  if (host !== L.dst_host || item.from_agent !== L.dst_agent) {
    log(host + ": " + item.kind + " for " + util.shortId(item.request_id) + " came from a conversation that did not receive it — refused");
    return;
  }
  let env;
  try {
    env = envl.extractEnvelope(item.message);
  } catch {
    log(host + ": " + item.kind + " without a readable envelope — dropped");
    return;
  }
  if (envl.checkEnvelope(env).length || env.type !== item.kind || env.request_id !== item.request_id) {
    log(host + ": " + item.kind + " envelope check failed — dropped");
    return;
  }
  if (item.kind === "ack") {
    sendInbox(L.src_host, { id: item.id, kind: "ack", request_id: item.request_id, message: item.message });
    if (env.status === "received" || env.status === "duplicate") {
      memory[L.dst_key] = L.dst_agent;
      saveJson("memory.json", memory);
    }
    if (env.status === "wrong_target" || env.status === "conflict") {
      const text = composeFor(L.src_host, item.message, "reply", item.request_id);
      const r = await inject(L.src_host, L.src_agent, text, item.id).catch((e) => ({ ok: false, reason: e.message }));
      if (!r.ok && r.reason === "permission") holdInject(L.src_host, L.src_agent, text, item.id, null);
    }
    log("ack(" + env.status + ") " + util.shortId(item.request_id) + " → " + L.src_host);
    return;
  }
  const text = composeFor(L.src_host, item.message, "reply", item.request_id);
  const r = await inject(L.src_host, L.src_agent, text, item.id);
  if (r.ok) log("result(" + env.status + ") " + util.shortId(item.request_id) + " → " + L.src_host + " " + L.src_agent.slice(0, 8));
  else if (r.reason === "permission") holdInject(L.src_host, L.src_agent, text, item.id, null);
  else log("result " + util.shortId(item.request_id) + ": the sending conversation is gone — kept in the receiver's records");
}

// 권한 창 때문에 미룬 넣기를 다시 해 본다
let heldBusy = false;
setInterval(async () => {
  if (heldBusy || !held.length) return;
  heldBusy = true;
  try {
    const rest = [];
    for (const h of held) {
      try {
        const r = await inject(h.host, h.agent, h.text, h.messageId);
        if (r.ok) {
          log("delivered a held message to " + h.host + " " + h.agent.slice(0, 8));
          if (h.after && h.after.kind === "request") await notifySender(h.after.src_host, h.after.src_agent, h.after.request_id, h.after.attempt_id, "delivered", "delivered to " + h.after.target + " after its permission prompt was answered", null, false);
        } else if (r.reason === "permission") rest.push(h);
        else log("dropped a held message — " + h.host + " " + h.agent.slice(0, 8) + " is gone");
      } catch (e) {
        rest.push(h);
      }
    }
    held = rest;
    saveJson("held.json", held);
  } finally {
    heldBusy = false;
  }
}, HELD_MS).unref();

// ── 시작
log("router starting (pid " + process.pid + ")");
startLocal();
reconcile();
try {
  fs.watch(path.dirname(projects.canonicalFile()), () => reconcile());
} catch (e) {
  log("cannot watch the project list: " + e.message);
}
const shutdown = () => {
  for (const [, ch] of channels) if (ch.stop) ch.stop();
  for (const h of [...clients.keys()]) dropClient(h);
  try {
    if (Number(fs.readFileSync(PID, "utf8")) === process.pid) fs.unlinkSync(PID);
  } catch {
    /* 없음 */
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown); // 띄운 플러그인이 끝나면 함께 끝난다
process.stdin.resume();
