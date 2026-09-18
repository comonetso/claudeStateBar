# peer_req

A Claude Code plugin that lets your open sessions ask and notify each other directly — two repositories on the same PC, your PC and a server, or two servers — without SSH keys between them.

[한국어](README.ko.md)

> [!IMPORTANT]
> **Remote Control must be on in every session you want to pair. If it is off, this plugin does not work.**
> Sessions on other machines are reachable only through Remote Control. Turn on *auto-connect* on every machine you use — your PC and every server — as described in [Turn on Remote Control](#turn-on-remote-control-first). This is the one step that cannot be skipped.

## What it does

You work in one session and need something from another one: the server session that owns the API, the app session that consumes it, a second repository on the same PC. You say

```
/peer-req:peer_req api what does the login endpoint return?
```

and the question goes to the API server's session that is already open. That session reads it, investigates only what was asked, and sends the answer back into your conversation. You don't copy anything between windows, and the other session doesn't need anyone to tell it that a message arrived.

It builds on Claude Code's own cross-session messaging (`ListAgents` and `SendMessage`). What the plugin adds is the part that makes this dependable for real work:

- **Pairs are named once.** An address book in the sending repository (`.peer_req.json`) says who each peer is and where it lives. Group several peers and send to all of them at once.
- **Every request has an ID, an acknowledgement and a record.** The receiving session records the request and replies "received" before it starts; the result comes back under the same ID. "Sent" and "read" are never confused.
- **Nothing runs twice.** A resent request is recognised and answered from the existing record. The same ID with a different body is refused.
- **The receiver stays in its lane.** A question is answered, a notice is checked for impact only, and a change request is logged for that session's own user to act on — nothing is edited on another session's behalf.
- **Both sides keep a record** under `docs/_msg/peer_req/<request id>/`, committed to Git by default.
- **When a session starts**, the plugin tells you it is loaded, how many peers the repository has, and whether anything arrived or finished while you were away.

## Turn on Remote Control first

Do this on **every** machine — your PC and each server.

**The easy way.** Inside Claude Code run `/config` and set **Enable Remote Control for all sessions** to `true`. In the VS Code extension the same switch is in the command menu's Settings section.

**The explicit way (recommended).** Add this to `~/.claude/settings.json`:

```json
{
  "remoteControlAtStartup": true
}
```

Why write it down explicitly: when the key is absent, Claude Code follows Anthropic's current default, and that default can change. There has already been a case where auto-connect stopped on every machine at once because the default changed underneath it. With the key set, it stays on. Sessions that are already open pick the change up right away — you don't need to restart them.

A `true` in a project's `.claude/settings.json` is ignored on purpose (a repository can't turn Remote Control on for everyone who opens it), so this has to go in your user settings.

**On a Linux server there are three usual traps:**

1. **A long-lived token.** If your shell profile (`.bashrc` or similar) exports `CLAUDE_CODE_OAUTH_TOKEN`, remove or comment it out. Tokens from `claude setup-token` can only make model requests; they cannot open a Remote Control session.
2. **The VS Code server is still holding the old environment.** If you use the server through VS Code Remote-SSH, run **Remote-SSH: Kill VS Code Server on Host** and reconnect. A running server process keeps the environment it started with, token included. This is the one that catches most people.
3. **Sign in again** on that server with `claude auth login`.

**How to check.** Open claude.ai/code or the Claude app on another device and look for the session in the list. A modest server can take a while to appear — give it a moment before concluding it failed.

**Who can use it.** Remote Control is available on Pro, Max, Team and Enterprise plans; on Team and Enterprise an Owner has to switch it on in the Claude Code admin settings first. It does not work with an API key, with Amazon Bedrock, Google Cloud or Microsoft Foundry, with a custom `ANTHROPIC_BASE_URL`, or when any of `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK` is set.

## Install

```
/plugin marketplace add comonetso/claudeStateBar
/plugin install peer-req@comonetso
```

**Turn on auto-update.** Claude Code keeps auto-update off for marketplaces outside Anthropic's own, so without this you stay on the version you installed. Add to `~/.claude/settings.json` on each machine:

```json
{
  "extraKnownMarketplaces": {
    "comonetso": { "source": { "source": "github", "repo": "comonetso/claudeStateBar" }, "autoUpdate": true }
  }
}
```

If you use the Claude State Bar extension, it offers to do this for you with one **Turn on** button — on this PC in a local window, on the server in a Remote-SSH window. New versions arrive when Claude Code starts. The switch covers every plugin from this marketplace, so it also keeps codex_rescue current.

Install it on every machine whose sessions should take part, then start a new session. The plugin's scripts run on Node.js, so `node` must be on the PATH. The version doesn't matter: the scripts avoid newer language features, and they have been run on Node 10 through 22.

## The address book

Put `.peer_req.json` at the root of the repository you send from.

```json
{
  "schema_version": 1,
  "self": { "endpoint_id": "pc.admin", "machine_id": "my-pc", "root": "C:/work/admin" },
  "peers": {
    "api": {
      "endpoint_id": "srv.api", "machine_id": "api-server",
      "location": { "os": "linux", "root": "/srv/api", "host_alias": "api-server" },
      "session_selector": { "rc_title": "API server", "accept_numeric_suffix": true }
    },
    "app": {
      "endpoint_id": "pc.app", "machine_id": "my-pc",
      "location": { "os": "windows", "root": "C:/work/app" }
    }
  },
  "groups": { "everyone": ["api", "app"] },
  "records": { "commit": true },
  "unattended": { "permission": "read_only" }
}
```

`machine_id` is a label you choose. A peer with the same `machine_id` as `self` is on the same machine; the plugin finds its session by the working folder. A peer on another machine is found by its Remote Control title. If you always give that peer's session the same title, put it in `rc_title`. The title matches exactly, or with a trailing " · 2", " · 3"; if more than one session matches, you are asked which one. You can leave it out — you then pick the session once, the first time you send (see "Finding the right session on another machine" below). `self.root` must be the folder the file sits in, which catches address books copied over from another repository.

**Every repository that takes part needs this file, including one that only receives.** A receiving repository can leave out `peers`, but it must have `self` — that is how it checks that a message was meant for it. Without a valid `self` it turns every request away as the wrong target rather than guessing.

## Using it

```
/peer-req:peer_req api what does the login endpoint return?      a question
/peer-req:peer_req app I renamed the user_id field, tell them     a notice
/peer-req:peer_req api please add paging to /orders               a change request
/peer-req:peer_req everyone ...                                   the whole group
```

The command is `/peer-req:peer_req` because Claude Code puts the plugin's name in front of its skills. Typing `/peer` is enough for the input box to complete it, and you can also just ask in words — "ask the api server what the login endpoint returns".

Claude works out from your wording whether it is a question, a notice or a change request, and says which before sending. What the other side does differs:

- **Question** — it investigates only what was asked and answers with file:line references and anything it couldn't confirm.
- **Notice** — it checks what the change affects in its own code and reports back. It doesn't fix anything.
- **Change request** — it acknowledges and records it, then tells its own user. The work happens only when that user says so.

Other commands, each after `/peer-req:peer_req`: `here` marks the current conversation as this repository's session (useful when several windows are open on the same folder), `status` lists recent requests, `inbox` shows what arrived or finished that you haven't been told about yet, and `doctor` checks the address book and settings without sending anything. `forget <peer>` clears the session remembered for a peer, so the next send looks it up again.

**Finding the right session on the same machine.** If exactly one session is open in the peer's folder, the message goes there and that session is remembered. If there are none or several, you are asked to pick, and your choice is remembered. The memory follows the conversation, so it survives a VS Code reload. When that conversation is closed, the next send looks the folder up again the same way.

**Finding the right session on another machine.** The Remote Control list shows only each session's title, not which machine or folder it runs in. So if the address book has an `rc_title`, that title is used; if not, you pick the session from the list once. If, after leaving out sessions already used by other peers, only one session from another machine is listed, the message goes there without asking. Your pick is remembered on this PC and you aren't asked again. A Remote Control title stays the same for the same conversation, across a VS Code reload and when you leave the conversation and come back. If you rename the session, it is still recognised as long as its reference in the list (such as `[87f895]`) is unchanged. A new conversation gets a new title, so you pick once more then. If a message does reach the wrong session, the receiving side checks its address book, sees the message isn't for it, and sends it back as "not the target"; that session is then forgotten and left out of the choices from then on.

## When the other session isn't open

The normal path is between open sessions. If the peer's session isn't open, Claude asks whether to send it *unattended*: a fresh Claude Code run is started in the peer's repository just for this request, answers it, and exits. On the same machine it runs in the peer's folder; on another machine it runs over SSH using `location.host_alias` from your `~/.ssh/config`. It only works in the direction SSH reaches — typically from your PC to a server, not from one server to another.

By default an unattended run gets read-only tools (Read, Grep, Glob): it can look but not change anything. Setting `"unattended": { "permission": "bypass" }` lets it run without permission checks, so it can run shell commands and query a database — and also change things. Deny rules in that machine's `~/.claude/settings.json` still apply, but they don't cover every way of doing the same thing. Turn bypass on only for machines where that is acceptable. A change request is never worked on unattended; it is only logged. When the other side's user later finishes it, running the same unattended request again fetches the stored result — the other side recognises the request and doesn't run anything a second time. A message that the other session held, refused or let expire is never retried this way, and a retry only goes to the same target the request was first sent to.

## Limits

- Sessions in different permission modes may hold messages for approval. A session that skips permission prompts holds messages from sessions that don't, and the other way round; an unanswered approval dialog drops the message after five minutes. On the same machine the sender is told; across machines nothing reports back, which is why the plugin waits for an acknowledgement instead of trusting "sent".
- On the same machine a single message is capped at about a million characters.
- A session's address changes when it restarts. If a reply can't be delivered, the receiving side looks up the sender's current session in the same folder and tries again. If the sender is gone, the result stays in the receiver's record. On the same machine the sender picks it up from there the next time it checks its status or starts a session; across machines it stays only on the receiving side.
- The plugin reads Claude Code's local session registry to find sessions on the same machine, and puts the chosen session's ID in the message so the receiver can check the message was meant for it. That file is not a documented interface. If a Claude Code update changes it, the plugin stops sending to sessions on the same machine rather than guess — cross-machine messaging is unaffected.

## Files

```
.claude-plugin/plugin.json
hooks/hooks.json              session-start notice
skills/peer_req/SKILL.md      what Claude follows
scripts/peer.cjs              address book, envelopes, hashes, records, state
scripts/session-start.cjs
test/peer.test.mjs            node --test skills/peer_req/test/peer.test.mjs  (the tests need Node 18+; the plugin doesn't)
```
