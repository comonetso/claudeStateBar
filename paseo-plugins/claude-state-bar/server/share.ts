import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renameRetry, serializeFileWrite } from "./renameRetry";
import { soundDataFile } from "./soundJournal";
import { ADMIN_LABEL, SHARE_FILES_MAX, SHARE_MODE_DEFAULT, SHARE_REPLY_KIND, SHARE_REPLY_VERSION, shareFileKind, shareReplyNative, shareSizeText,
  type ShareMember, type ShareMode, type ShareReplyData, type ShareReplyFile } from "../shared/share";

// 같이 보기 — 리규형님 쪽(10-25 리규형님 결정, shared/share.ts 머리 설명). 공유를 켠 대화만 몇 초마다 기록 끝을 다시 읽어 사람 말·답 글만
// 콜어드민 웹 게이트에 사본으로 올린다(바뀌었을 때만). 팀원 답글은 게이트에서 기다렸다 받아 이 대화 화면에 플러그인 줄로 넣고(Claude 에게 안 감)
// 질문처럼 소리·폰 알림을 낸다. 리규형님이 줄의 "대화에 넣기"를 누르면 "<이름> 답글: …" 으로 대화에 보낸다(쉬고 있을 때만).
// 게이트 열쇠는 폰 알림 중앙 경로와 같다(push-route — 이 데몬이 중앙 경로가 아니면 공유를 못 켠다). 팀원 데몬에서는 돌지 않는다.

type PaseoApi = PluginHookContext["paseo"];
type Agent = PluginLifecycleEvents["agent.turn_started"]["agent"];
type Route = { url: string; originId: string; secret: string };
type Item = { role: "user" | "assistant"; text: string; at: string | null };
type ReplyRecord = ShareReplyData & { agentId: string; createdAt: number };
/** mode 는 10-25 뒤 — 없으면 바로 보냄(리규형님 "기본은 바로보냄") */
type State = { v: 1; shares: Record<string, { members: string[]; mode?: ShareMode }>; replies: Record<string, ReplyRecord> };
const modeOf = (s: { mode?: ShareMode } | undefined): ShareMode => s?.mode ?? SHARE_MODE_DEFAULT;
type Entry = { item?: { type?: string; text?: unknown; agentMessage?: { text?: unknown } }; timestamp?: string; seqEnd?: number };
type TimelineAppend = (item: { type: "plugin"; id: string; kind: string; version: number; data: unknown }) => Promise<unknown>;

/** 공유 중이고 진행 중인 대화를 다시 읽는 간격 — 팀원 화면은 이만큼 늦게 따라온다 */
export const SHARE_SYNC_MS = 3000;
/** 기록 끝에서 읽는 항목 수 — 도구 호출까지 센 수라 사람 말·답 글은 이보다 적다. 더 앞은 "앞부분 생략" */
export const SHARE_TAIL = 400;
/** 사본 글자 상한 — 게이트 상한 2MB 안에 들게(한글 3바이트). 넘치면 오래된 것부터 뺀다 */
export const SHARE_TEXT_MAX = 500_000;
/** 처리한 답글 기록 보관 — 그 뒤엔 대화 화면의 줄만 남는다 */
const REPLY_KEEP_MS = 7 * 24 * 3600_000;
const GATE_TIMEOUT_MS = 20_000;
const REPLY_WAIT_MS = 15_000;
const MEMBERS_REFRESH_MS = 60_000;

const FILE = soundDataFile("share-v1.json");
/** 팀원 답글 첨부를 받아 두는 곳(답글마다 폴더) — "파일"로 넣는 첨부는 이 경로를 대화에 적는다. 답글 기록과 함께 7일 뒤 지운다 */
export const shareFilesDir = () => join(dirname(FILE), "share-files");
/** 첨부 하나 받기 — 10MB 를 늦은 회선으로도 받게 */
const FILE_TIMEOUT_MS = 60_000;
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** 저장 이름 — 경로 구분자·제어 문자를 빼고 끝 100자 */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(-100) || "file";

// 소리 판정(soundEvents valid)이 읽는다 — 아직 처리 안 한 답글이면 울려도 된다
const pendingReplies = new Map<string, string>(); // replyId → agentId
export function shareReplyPending(agentId: string, replyId: string): boolean {
  return pendingReplies.get(replyId) === agentId;
}

/** 기록 항목 → 사람 말·답 글만. 이어진 같은 쪽 글은 하나로(답 사이 도구 호출을 빼면 한 차례 답이 여러 조각이 된다) */
export function shareItemsOf(entries: readonly Entry[], max = SHARE_TEXT_MAX): { items: Item[]; dropped: boolean } {
  const ordered = entries.every((e) => typeof e.seqEnd === "number") ? [...entries].sort((a, b) => a.seqEnd! - b.seqEnd!) : [...entries];
  const items: Item[] = [];
  for (const e of ordered) {
    const type = e.item?.type;
    // 사람이 친 말(user_message)과 다른 대화가 보낸 말(0.13.0 — tool_call 에 agentMessage{event,sender,text}, 10-25 실측: Mesa 지휘가
    // 하위 대화에 보내는 말·Paseo 도구로 보낸 말)을 "말" 쪽으로
    const sentByAgent = type === "tool_call" && typeof e.item?.agentMessage?.text === "string";
    const role = type === "user_message" || sentByAgent ? "user" : type === "assistant_message" ? "assistant" : null;
    const text = sentByAgent ? str(e.item?.agentMessage?.text) : str(e.item?.text);
    if (!role || !text.trim()) continue;
    const last = items[items.length - 1];
    if (last && last.role === role) last.text += (role === "assistant" ? "\n\n" : "\n") + text;
    else items.push({ role, text, at: e.timestamp ?? null });
  }
  let total = items.reduce((n, it) => n + it.text.length, 0);
  let dropped = false;
  while (items.length > 1 && total > max) {
    total -= items.shift()!.text.length;
    dropped = true;
  }
  if (items.length === 1 && items[0].text.length > max) {
    items[0] = { ...items[0], text: items[0].text.slice(-max) };
    dropped = true;
  }
  return { items, dropped };
}

export function createShare(options: {
  log?: (message: string) => void;
  /** 이 데몬의 게이트 길(폰 알림 중앙 경로) — 없으면 이유 */
  route: () => Promise<{ route: Route | null; reason: string | null }>;
  /** PC 팀원 정보의 "부를 이름"(서버엔 없다) */
  callNames?: () => Promise<Record<string, string>>;
  /** 답글이 오면 질문처럼 울리기 · 처리하면 거두기(server/push.ts) */
  ring?: (agent: Agent, paseo: PaseoApi, nativeId: string, title: string, body: string) => unknown;
  unring?: (agentId: string, nativeId: string) => void;
  fetchImpl?: typeof fetch;
  syncMs?: number;
  /** 시험용 — 공유가 없을 때·실패 뒤 쉬는 시간 */
  idleMs?: number;
  retryMs?: number;
}) {
  const log = options.log ?? ((m: string) => console.log(`[share] ${m}`));
  const fetchImpl = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const syncMs = options.syncMs ?? SHARE_SYNC_MS;
  const idleMs = options.idleMs ?? 5000;
  const retryMs = options.retryMs ?? 10_000;
  let state: State = { v: 1, shares: {}, replies: {} };
  let loaded: Promise<void> | null = null;
  let paseo: PaseoApi | null = null;
  let stopped = false;
  let rev = 0;
  let available = false;
  let reason: string | null = null;
  let members: ShareMember[] = [];
  let membersAt = 0;
  const errors = new Map<string, string>();
  const lastHash = new Map<string, string>();
  const dirty = new Set<string>();
  const running = new Set<string>();
  const shapeLogged = new Set<string>();
  const waiters = new Set<() => void>();
  const changed = () => {
    rev++;
    for (const wake of [...waiters]) wake();
  };

  const load = () => (loaded ??= (async () => {
    try {
      const j = JSON.parse(await readFile(FILE, "utf8")) as State;
      if (j?.v === 1 && j.shares && j.replies) state = j;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`state unreadable: ${String(error)}`);
    }
    const t = Date.now();
    for (const [id, r] of Object.entries(state.replies)) {
      if (r.state !== "new" && t - r.createdAt > REPLY_KEEP_MS) {
        delete state.replies[id];
        if (r.files?.length) void rm(join(shareFilesDir(), id.replace(/[^A-Za-z0-9-]/g, "")), { recursive: true, force: true }).catch(() => {});
      } else if (r.state === "new") pendingReplies.set(id, r.agentId);
    }
    for (const id of Object.keys(state.shares)) dirty.add(id);
  })());
  const save = () => serializeFileWrite(FILE, async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await renameRetry(tmp, FILE);
  });

  async function gate(path: string, body: unknown, timeoutMs = GATE_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const { route, reason: why } = await options.route();
    if (!route) throw new Error(why ?? "게이트 길 없음");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    let json: Record<string, unknown> | null;
    try {
      res = await fetchImpl(`${route.url}/__gate/share/origin/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${route.originId}.${route.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: abort.signal,
      });
      json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`게이트 ${res.status} ${str(json?.error)}`.trim());
    return json ?? {};
  }

  async function refreshMembers(force = false) {
    if (!force && Date.now() - membersAt < MEMBERS_REFRESH_MS) return;
    membersAt = Date.now();
    try {
      const { route, reason: why } = await options.route();
      const nextAvailable = !!route;
      if (nextAvailable !== available || why !== reason) {
        available = nextAvailable;
        reason = why;
        changed();
      }
      if (!route) return;
      const r = await gate("members", {});
      const names = await (options.callNames?.() ?? Promise.resolve({} as Record<string, string>)).catch(() => ({} as Record<string, string>));
      // 게이트는 관리자에 admin 표시를 붙여 준다(10-25 — 팀원 Paseo 도 리규형님께 공유) — 이름이 없으면 "관리자"
      const next = (Array.isArray(r.members) ? r.members : []).map((m) => ({ id: str((m as { id?: unknown }).id), admin: (m as { admin?: unknown }).admin === true }))
        .filter((m) => m.id).map(({ id, admin }) => ({ id, label: names[id]?.trim() || (admin ? ADMIN_LABEL : id) }));
      if (JSON.stringify(next) !== JSON.stringify(members)) {
        members = next;
        changed();
      }
    } catch (error) {
      log(`members: ${String(error)}`);
    }
  }
  const labelOf = (id: string) => members.find((m) => m.id === id)?.label ?? id;

  // ── 사본 올리기 ──
  async function syncOne(agentId: string) {
    const p = paseo;
    const share = state.shares[agentId];
    if (!p || !share) return;
    const short = agentId.slice(0, 8);
    try {
      const handle = p.agents.ref(agentId);
      await handle.refresh();
      const now = handle.current() as (Agent & { title?: string | null; status?: string; archivedAt?: string | null }) | null;
      if (!now || now.archivedAt) {
        log(`${short}: 대화가 없거나 보관됨 — 공유를 끕니다`);
        await set(agentId, []);
        return;
      }
      if (now.status === "running") running.add(agentId);
      else running.delete(agentId);
      // 바로 보냄 — 쉬는 중이면 기다리던 답글을 넣는다(못 넣어도 사본 올리기는 계속)
      if (!running.has(agentId)) await deliverDirect(agentId).catch((error: unknown) => log(`${short}: 바로 보냄 실패 — ${String(error)}`));
      const page = await handle.timeline.refetch({ direction: "tail", limit: SHARE_TAIL, projection: "canonical" });
      if (!page || page.error) throw new Error(`기록을 못 읽음${page?.error ? ` (${page.error})` : ""}`);
      if (!shapeLogged.has(agentId)) {
        // 기록 항목 종류·칸 이름만(글 없음) — 사람 말이 다른 종류로 들어오는 대화를 가리려고(10-25 시험: 다른 대화가 보낸 말이 빠짐)
        shapeLogged.add(agentId);
        const shapes = new Map<string, number>();
        for (const e of (page.entries ?? []) as unknown as Entry[]) {
          const am = (e.item as { agentMessage?: unknown } | undefined)?.agentMessage;
          const key = `${e.item?.type ?? "?"}{${Object.keys(e.item ?? {}).sort().join(",")}}${am && typeof am === "object" ? `<${Object.keys(am).sort().join(",")}>` : ""}`;
          shapes.set(key, (shapes.get(key) ?? 0) + 1);
        }
        log(`${short}: 기록 항목 ${[...shapes].map(([k, n]) => `${k}×${n}`).join(" ")}`);
      }
      const { items, dropped } = shareItemsOf((page.entries ?? []) as unknown as Entry[]);
      const body = { agentId, title: str(now.title) || "대화", ownerName: "", members: share.members, items,
        truncated: dropped || (page as { hasOlder?: boolean }).hasOlder === true, running: now.status === "running" };
      const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (lastHash.get(agentId) === hash) return;
      await gate("put", body);
      lastHash.set(agentId, hash);
      if (errors.delete(agentId)) changed();
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (errors.get(agentId) !== message) {
        errors.set(agentId, message);
        changed();
        log(`${short}: 사본 올리기 실패 — ${message}`);
      }
      dirty.add(agentId);
    }
  }

  // ── 답글 받기 ──
  async function takeReplies() {
    const r = await gate("replies", { wait: true, waitMs: REPLY_WAIT_MS }, REPLY_WAIT_MS + 5000);
    const list = Array.isArray(r.replies) ? (r.replies as Record<string, unknown>[]) : [];
    if (!list.length) return;
    await refreshMembers();
    const ack: string[] = [];
    let failed: string | null = null;
    for (const x of list) {
      const replyId = str(x.id);
      const agentId = str(x.agentId);
      if (!replyId || !agentId) continue;
      if (state.replies[replyId]) { ack.push(replyId); continue; }
      // 첨부는 줄을 넣기 전에 이 기기에 다 받아 둔다 — 못 받으면 이 답글은 게이트에 남겨 두고 다음 차례에 다시 받는다
      let files: ShareReplyFile[];
      try {
        files = await fetchFiles(replyId, x.files);
      } catch (error) {
        failed = `${agentId.slice(0, 8)}: 답글 첨부 받기 실패 — ${String((error as Error)?.message ?? error)}`;
        continue;
      }
      const label = x.admin === true && !members.some((m) => m.id === str(x.member)) ? ADMIN_LABEL : labelOf(str(x.member));
      const rec: ReplyRecord = { replyId, member: str(x.member), label, text: str(x.text), at: str(x.at), state: "new", agentId,
        createdAt: Date.now(), ...(files.length ? { files } : {}) };
      state.replies[replyId] = rec;
      pendingReplies.set(replyId, agentId);
      await save();
      try {
        await showRow(rec);
        await ringFor(rec);
      } catch (error) {
        log(`${agentId.slice(0, 8)}: 답글 줄 넣기 실패 — ${String(error)}`);
      }
      ack.push(replyId);
      log(`${agentId.slice(0, 8)}: ${rec.label} 답글 받음`);
    }
    if (ack.length) await gate("ack", { ids: ack });
    for (const id of new Set(list.map((x) => str(x.agentId)).filter(Boolean))) {
      await deliverDirect(id).catch((error: unknown) => log(`${id.slice(0, 8)}: 바로 보냄 실패 — ${String(error)}`));
    }
    changed();
    // 못 받은 첨부가 있으면 실패로 끝내 다시 시도 간격(retryMs)을 둔다 — 게이트가 그 답글을 바로 다시 주므로 쉬지 않으면 계속 돈다
    if (failed) throw new Error(failed);
  }
  /** 답글 첨부를 게이트에서 하나씩 받아 이 기기에 저장 — 종류(이미지·글·파일)는 받은 내용으로 정한다 */
  async function fetchFiles(replyId: string, meta: unknown): Promise<ShareReplyFile[]> {
    const list = Array.isArray(meta) ? meta.slice(0, SHARE_FILES_MAX) : [];
    if (!list.length) return [];
    const dir = join(shareFilesDir(), replyId.replace(/[^A-Za-z0-9-]/g, ""));
    await mkdir(dir, { recursive: true });
    const out: ShareReplyFile[] = [];
    for (let n = 0; n < list.length; n++) {
      const r = await gate("file", { replyId, n }, FILE_TIMEOUT_MS);
      const data = Buffer.from(str(r.data), "base64");
      const name = safeName(str(r.name) || str((list[n] as { name?: unknown } | null)?.name));
      const mimeType = str(r.mimeType) || "application/octet-stream";
      const path = join(dir, `${n + 1}-${name}`);
      await writeFile(path, data);
      let kind = shareFileKind(name, mimeType, data.length);
      // 글로 보이는 이름이어도 UTF-8 이 아니면(옛 한글 인코딩 등) 글 첨부로 넣지 않는다 — 깨진 글 대신 파일 경로로
      if (kind === "text" && data.toString("utf8").includes("�")) kind = "file";
      out.push({ name, mimeType, size: data.length, kind, path });
    }
    return out;
  }
  async function showRow(rec: ReplyRecord) {
    const handle = paseo!.agents.ref(rec.agentId);
    const append = (handle.timeline as unknown as { append?: TimelineAppend }).append;
    if (typeof append !== "function") throw new Error("이 Paseo 판은 대화 화면에 줄을 넣을 수 없음");
    const { agentId: _a, createdAt: _c, ...data } = rec;
    await append.call(handle.timeline, { type: "plugin", id: `csb-share-reply-${rec.replyId}`, kind: SHARE_REPLY_KIND, version: SHARE_REPLY_VERSION, data });
  }
  async function ringFor(rec: ReplyRecord) {
    if (!options.ring) return;
    const handle = paseo!.agents.ref(rec.agentId);
    await handle.refresh();
    const agent = handle.current() as Agent | null;
    const files = rec.files?.length ? `(첨부 ${rec.files.length}개)` : "";
    if (agent) await options.ring(agent, paseo!, shareReplyNative(rec.replyId), `${rec.label} 답글`, (rec.text ? `${rec.text.slice(0, 200)} ${files}` : files).trim());
  }

  // ── 반복 ──
  function startLoops() {
    void (async () => {
      while (!stopped) {
        await load();
        for (const id of Object.keys(state.shares)) {
          if (stopped) break;
          if (dirty.has(id) || running.has(id)) {
            dirty.delete(id);
            await syncOne(id);
          }
        }
        await new Promise((r) => setTimeout(r, syncMs).unref?.());
      }
    })();
    void (async () => {
      while (!stopped) {
        await load();
        if (!Object.keys(state.shares).length || !available) {
          await refreshMembers();
          await new Promise((r) => setTimeout(r, idleMs).unref?.());
          continue;
        }
        try {
          await takeReplies();
        } catch (error) {
          log(`replies: ${String(error)}`);
          await new Promise((r) => setTimeout(r, retryMs).unref?.());
        }
      }
    })();
  }

  /**
   * 답글 줄의 단추와 바로 보냄이 같이 쓴다 — insert = 대화에 넣기(쉬고 있을 때만) · dismiss = 닫기.
   * 같은 답글을 두 곳(단추·답글 받기·대화 다시 읽기)이 동시에 넣으면 Claude 에게 두 번 간다 — 답글마다 하나만 돈다.
   * 넣은 뒤엔 그 대화를 진행 중으로 본다(Paseo 상태가 바뀌기 전 틈에 다음 답글이 겹쳐 들어가지 않게 — 다시 읽기가 실제 상태로 바로잡는다)
   */
  const acting = new Set<string>();
  async function act(agentId: string, replyId: string, action: "insert" | "dismiss"): Promise<{ ok: boolean; error?: string }> {
    if (acting.has(replyId)) return { ok: false, error: "처리하는 중입니다" };
    acting.add(replyId);
    try {
      const r = await actNow(agentId, replyId, action);
      if (r.ok && action === "insert" && state.shares[agentId]) running.add(agentId);
      return r;
    } finally {
      acting.delete(replyId);
    }
  }
  async function actNow(agentId: string, replyId: string, action: "insert" | "dismiss"): Promise<{ ok: boolean; error?: string }> {
    await load();
    const rec = state.replies[replyId];
    if (!rec || rec.agentId !== agentId) return { ok: false, error: "없는 답글입니다" };
    if (rec.state !== "new") return { ok: false, error: rec.state === "inserted" ? "이미 대화에 넣었습니다" : "이미 닫았습니다" };
    if (!paseo) return { ok: false, error: "아직 연결 전입니다" };
    const handle = paseo.agents.ref(agentId);
    if (action === "insert") {
      await handle.refresh();
      const now = handle.current() as { status?: string; activeTurn?: unknown; archivedAt?: string | null } | null;
      if (!now || now.archivedAt) return { ok: false, error: "대화가 없거나 보관됐습니다" };
      if (now.status === "running" || now.activeTurn) return { ok: false, error: "대화가 진행 중입니다 — 끝난 뒤 넣어 주세요" };
      // 첨부(10-25) — 이미지는 Claude 에게 이미지로, 글 파일은 글 첨부로, 그 밖은 이 기기에 저장한 경로를 글 끝에 적는다
      const images: { data: string; mimeType: string }[] = [];
      const attachments: { type: "text"; mimeType: "text/plain"; title: string; text: string }[] = [];
      const paths: string[] = [];
      for (const f of rec.files ?? []) {
        try {
          if (f.kind === "image" && f.path) images.push({ data: (await readFile(f.path)).toString("base64"), mimeType: f.mimeType });
          else if (f.kind === "text" && f.path) attachments.push({ type: "text", mimeType: "text/plain", title: f.name, text: await readFile(f.path, "utf8") });
          else if (f.path) paths.push(`- ${f.path} (${f.name}, ${shareSizeText(f.size)})`);
        } catch {
          return { ok: false, error: `첨부 "${f.name}" 를 이 기기에서 찾지 못했습니다` };
        }
      }
      const count = images.length + attachments.length;
      const body = `${rec.label} 답글:${rec.text ? ` ${rec.text}` : count && !paths.length ? ` (첨부 ${count}개)` : ""}` +
        (paths.length ? `\n\n첨부 파일(이 기기에 저장됨 — 필요하면 열어 보세요):\n${paths.join("\n")}` : "");
      await handle.send(body, {
        messageId: `csb-share-reply-${replyId}`,
        ...(images.length ? { images } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
    }
    rec.state = action === "insert" ? "inserted" : "dismissed";
    pendingReplies.delete(replyId);
    await save();
    await showRow(rec).catch((error: unknown) => log(`${agentId.slice(0, 8)}: 답글 줄 바꾸기 실패 — ${String(error)}`));
    options.unring?.(agentId, shareReplyNative(replyId));
    log(`${agentId.slice(0, 8)}: ${rec.label} 답글 ${action === "insert" ? "대화에 넣음" : "닫음"}`);
    changed();
    return { ok: true };
  }
  /**
   * 바로 보냄(10-25 리규형님 — 공유할 때 고른 방식, 기본) — 이 대화의 아직 안 넣은 답글 중 가장 오래된 하나를 대화에 넣는다.
   * 진행 중이면 넣지 않는다 — 차례가 끝나면(onTurnEnded → 다시 읽기) 다시 온다. 한 번에 하나만: 넣으면 그 대화가 곧 진행 중이 되므로
   * 다음 답글은 그 차례가 끝난 뒤에 들어간다(진행 중인 대화에 겹쳐 넣지 않게)
   */
  const delivering = new Set<string>();
  async function deliverDirect(agentId: string) {
    const share = state.shares[agentId];
    if (!share || modeOf(share) !== "direct" || running.has(agentId) || delivering.has(agentId)) return;
    const next = Object.values(state.replies).filter((r) => r.agentId === agentId && r.state === "new").sort((x, y) => x.createdAt - y.createdAt)[0];
    if (!next) return;
    delivering.add(agentId);
    try {
      const r = await act(agentId, next.replyId, "insert");
      if (!r.ok) log(`${agentId.slice(0, 8)}: 바로 보냄 못 함 — ${r.error ?? "?"} (차례가 끝나면 다시)`);
    } finally {
      delivering.delete(agentId);
    }
  }

  async function set(agentId: string, next: string[], mode?: ShareMode): Promise<{ ok: boolean; error?: string }> {
    await load();
    const clean = [...new Set(next.map((m) => m.trim()).filter(Boolean))];
    const nextMode = mode ?? modeOf(state.shares[agentId]);
    try {
      if (!clean.length) {
        if (!state.shares[agentId]) return { ok: true };
        await gate("end", { agentId });
        delete state.shares[agentId];
        lastHash.delete(agentId);
        errors.delete(agentId);
        running.delete(agentId);
        log(`${agentId.slice(0, 8)}: 공유 끔`);
      } else {
        state.shares[agentId] = { members: clean, mode: nextMode };
        lastHash.delete(agentId);
        dirty.add(agentId);
        log(`${agentId.slice(0, 8)}: 공유 — ${clean.join(", ")} · ${nextMode}`);
      }
      await save();
      changed();
      // 승인 후 보냄에서 바로 보냄으로 바꾸면 기다리던 답글도 넣는다(syncOne 이 쉬는 중이면 넣는다)
      if (clean.length) await syncOne(agentId);
      return errors.has(agentId) ? { ok: false, error: errors.get(agentId) } : { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  }

  let started = false;
  return {
    /** RPC·훅 문맥에서 Paseo 연결을 받는다 — 처음 받으면 반복을 시작한다 */
    attach(p: PaseoApi) {
      paseo = p;
      if (started || stopped) return;
      started = true;
      void refreshMembers(true);
      startLoops();
    },
    async wait(known: number | null) {
      await load();
      void refreshMembers();
      if (known === rev) {
        await new Promise<void>((resolve) => {
          const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, 25_000);
          waiters.add(wake);
        });
      }
      return {
        rev, available, reason,
        shares: Object.fromEntries(Object.entries(state.shares).map(([id, s]) => [id, s.members])),
        modes: Object.fromEntries(Object.entries(state.shares).map(([id, s]) => [id, modeOf(s)])),
        members, errors: Object.fromEntries(errors),
      };
    },
    set,
    /** 답글 줄의 이미지 미리보기 — 이 기기에 받아 둔 n 번째 첨부(이미지만) */
    async replyFile(agentId: string, replyId: string, n: number): Promise<{ ok: boolean; mimeType?: string; data?: string; error?: string }> {
      await load();
      const rec = state.replies[replyId];
      const f = rec && rec.agentId === agentId ? rec.files?.[n] : undefined;
      if (!f || f.kind !== "image" || !f.path) return { ok: false, error: "없는 이미지입니다" };
      try {
        return { ok: true, mimeType: f.mimeType, data: (await readFile(f.path)).toString("base64") };
      } catch {
        return { ok: false, error: "이 기기에서 찾지 못했습니다(보관 7일이 지났을 수 있음)" };
      }
    },
    replyAction: act,
    onTurnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"]) {
      if (!state.shares[agent.id]) return;
      running.add(agent.id);
      dirty.add(agent.id);
    },
    onTurnEnded({ agent }: PluginLifecycleEvents["agent.turn_ended"]) {
      if (!state.shares[agent.id]) return;
      running.delete(agent.id);
      dirty.add(agent.id);
    },
    onArchived({ agent }: PluginLifecycleEvents["agent.archived"]) {
      if (state.shares[agent.id]) void set(agent.id, []);
    },
    stop() {
      stopped = true;
      for (const wake of [...waiters]) wake();
    },
  };
}

/** 팀원 데몬의 답글 소리(10-25 명시 지시 5 — 팀원도 같이 보기). 팀원 Paseo 엔 폰 등록이 없어 폰 알림 장치(server/push.ts)를 만들지 않으므로,
 *  답글만 담은 "다시 울릴 질문" 목록을 같은 요청(pushCompactWait)으로 화면에 준다 — 화면(client/compactReady.ts)이 새 항목마다 질문 소리를 낸다.
 *  기다림 25초·판 0 시작은 push.ts 와 같다 */
export function createStaffShareRinger() {
  const rings = new Map<string, { agentId: string; nativeId: string }>();
  const waiters = new Set<() => void>();
  let rev = 0;
  const changed = () => {
    rev++;
    for (const wake of [...waiters]) wake();
  };
  const snapshot = () => ({ rev, agentIds: [] as string[], questionRepeats: [...rings.values()] });
  return {
    ring(agentId: string, nativeId: string) {
      rings.set(`${agentId} ${nativeId}`, { agentId, nativeId });
      changed();
    },
    unring(agentId: string, nativeId: string) {
      if (rings.delete(`${agentId} ${nativeId}`)) changed();
    },
    async wait(known: number | null) {
      if (known !== rev) return snapshot();
      await new Promise<void>((done) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          done();
        };
        const timer = setTimeout(wake, 25_000);
        waiters.add(wake);
      });
      return snapshot();
    },
    stop() {
      for (const wake of [...waiters]) wake();
    },
  };
}
