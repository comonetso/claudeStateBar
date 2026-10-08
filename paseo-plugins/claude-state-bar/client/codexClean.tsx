import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { cleanItems, codexCleanCheck, codexCleanStart, codexCleanWait, type CleanItemKey, type CleanRefusal } from "../shared/codexClean";
import { fmtBytes, fmtClock } from "./format";
import type { Notify, PanelStyles } from "./ui";

// Codex 진행 탭 용량 줄의 [정리] 칸(리규형님 10-08 결정: 확장과 같게). 확장 src/codexCleanNow.ts 의 흐름:
//   새로 읽고 거절 검사(고르기 전에 전부) → 항목 고르기(처음엔 아무것도 체크 안 함 — 고른 항목은 기간과 상관없이 전부 지운다) →
//   확인 → 정리 명령. 확장은 VS Code 확인 창 뒤 터미널에서 돌리고, 여기는 확인 앞에 스크립트 미리보기(--yes 없이)를 한 번 돌려
//   무엇을 얼마나 지우는지 보이고 [지우기]를 한 번 더 눌러야 지운다. 출력은 터미널 대신 이 칸에 그대로 보인다.
// 문구는 확장 i18n.ts 의 한국어(cx.usage.* · cx.clean.*)를 옮겼다. 확장에 없는 것(미리보기·진행·끝 안내)만 새로 썼다.

// 확장 cx.usage.* — codexPanel.tsx USAGE_LABEL 과 같아야 한다
const LABEL: Record<CleanItemKey, string> = { scratch: "작업폴더", log: "실행 기록", trash: "휴지통", codex: "Codex 대화 기록" };
// 확장 cx.clean.count.*
const COUNT: Record<CleanItemKey, (n: number) => string> = {
  scratch: (n) => `항목 ${n}개`,
  log: (n) => `파일 ${n}개`,
  trash: (n) => `항목 ${n}개`,
  codex: (n) => `대화 ${n}개`,
};
// 확장 cx.clean.detail.*
const DETAIL: Record<CleanItemKey, string> = {
  scratch: "docs/codex_rescue/.scratch — Codex 가 조사하며 만든 임시 파일",
  log: "docs/codex_rescue/.log — 실행 기록. 이 탭의 카드에서 활동 내역이 빠지고, 요청서·응답 문서는 남습니다.",
  trash: "docs/codex_rescue/.trash · .chat_trash — 진행 탭과 채팅 탭에서 휴지통으로 보낸 것. 휴지통에 남긴 문서도 함께 지웁니다.",
  codex:
    "codex_rescue 가 이 프로젝트에서 끼어들기 경로로 띄운 Codex 자체 대화 기록입니다(채팅 탭 대화와 옛 방식 실행은 빠집니다). Codex 공식 삭제 명령으로 한 건씩 지웁니다(한 건에 몇 초). 지운 실행은 되묻기를 할 수 없습니다.",
};

// 확장 cx.clean.noUsage · notPluginScript · dirMismatch · noScript
function refusalText(reason: CleanRefusal, path = ""): string {
  switch (reason) {
    case "noUsage":
      return "이 프로젝트의 용량 기록이 아직 없어 여기서 정리할 수 없습니다. 다음 Codex 실행 뒤에 생깁니다(codex-rescue 1.17.3 이상).";
    case "notPluginScript":
      return `이 프로젝트에 기록된 정리 프로그램이 ~/.claude 아래의 codex-rescue 플러그인 것이 아니라서(${path}) 실행하지 않았습니다. 이 프로젝트에서 Codex 를 한 번 실행하면 플러그인이 다시 기록합니다.`;
    case "dirMismatch":
      return `용량 기록이 이 프로젝트가 아닌 다른 폴더(${path})를 가리킵니다. 다른 곳에서 복사해 온 것 같습니다. 아무것도 실행하지 않았습니다. 이 프로젝트에서 Codex 를 한 번 실행하면 여기서 다시 잽니다.`;
    case "noScript":
      return `이 프로젝트에 기록된 정리 프로그램이 없습니다(${path}). 그 뒤 플러그인이 업데이트된 것 같습니다. 이 프로젝트에서 Codex 를 한 번 실행한 뒤 다시 눌러 주십시오.`;
  }
}

// 기다림 요청이 실패하면(연결이 잠깐 끊김 등) 이만큼 쉬고 다시 묻는다 — client/settingsSync.ts RETRY_MS 와 같다
const RETRY_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Job = {
  jobId: string;
  items: CleanItemKey[];
  output: string;
  state: "running" | "done" | "lost";
  exitCode?: number | null;
  error?: string;
  /** 기다림 요청이 실패해 다시 묻는 중 */
  retrying?: boolean;
};

type Stage =
  | { kind: "checking" }
  | { kind: "refused"; text: string }
  | { kind: "pick" }
  | { kind: "preview"; job: Job }
  | { kind: "run"; job: Job };

type Info = { project: string; computedAt: number; items: { key: CleanItemKey; bytes: number; count: number }[] };

const failedOf = (j: Job) => j.state === "lost" || !!j.error || (j.state === "done" && j.exitCode !== 0);

export function CleanDrawer({
  cwd,
  styles,
  theme,
  notify,
  onDone,
  onClose,
}: {
  cwd: string;
  styles: PanelStyles;
  theme: PluginTheme;
  notify: Notify;
  /** 지우는 정리가 끝나면 한 번(용량 줄·카드 목록·휴지통을 다시 읽는다) */
  onDone: () => void;
  onClose: () => void;
}) {
  const c = theme.colors;
  const check = useRpc(codexCleanCheck);
  const start = useRpc(codexCleanStart);
  const wait = useRpc(codexCleanWait);
  const [stage, setStage] = useState<Stage>({ kind: "checking" });
  const [info, setInfo] = useState<Info | null>(null);
  // 확장과 같이 처음엔 아무것도 체크하지 않는다(사용자 결정 — 여기 항목은 전부 영구 삭제다)
  const [picked, setPicked] = useState<CleanItemKey[]>([]);
  const [busy, setBusy] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 열 때마다 새로 읽는다 — 화면의 용량 줄은 한 차례 늦을 수 있고, 플러그인이 그사이 업데이트됐을 수 있다(확장 주석)
  useEffect(() => {
    let gone = false;
    check({ cwd })
      .then((r) => {
        if (gone) return;
        if (!r.ok) {
          setStage({ kind: "refused", text: refusalText(r.reason, r.path) });
          return;
        }
        setInfo({ project: r.project, computedAt: r.computedAt, items: r.items });
        // 지우는 정리가 이미 돌고 있으면(다른 화면이 시작했거나 칸을 닫았다 다시 연 경우) 그 진행을 보여 준다
        if (r.running) setStage({ kind: "run", job: { jobId: r.running.jobId, items: r.running.items, output: "", state: "running" } });
        else setStage({ kind: "pick" });
      })
      .catch((e) => {
        if (!gone) setStage({ kind: "refused", text: `용량 기록을 읽지 못했습니다: ${String(e)}` });
      });
    return () => {
      gone = true;
    };
  }, [cwd, check]);

  // 도는 작업의 출력을 받아 온다. 데몬은 출력이 늘거나 끝날 때까지(최대 25초) 기다렸다 답한다
  const active = stage.kind === "preview" || stage.kind === "run" ? stage.job : null;
  const activeId = active && active.state === "running" ? active.jobId : null;
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const id = activeId;
    const patch = (next: Partial<Job>) =>
      setStage((prev) => ((prev.kind === "preview" || prev.kind === "run") && prev.job.jobId === id ? { ...prev, job: { ...prev.job, ...next } } : prev));
    void (async () => {
      let seen = 0;
      while (!stopped) {
        let r: Awaited<ReturnType<typeof wait>>;
        try {
          r = await wait({ jobId: id, seen });
        } catch {
          if (stopped) return;
          patch({ retrying: true });
          await sleep(RETRY_MS);
          continue;
        }
        if (stopped) return;
        if (r.state === "lost") {
          // 받아 둔 출력은 지우지 않는다
          patch({ state: "lost", retrying: false });
          return;
        }
        seen = r.output.length;
        patch({ output: r.output, state: r.state, exitCode: r.exitCode, error: r.error, retrying: false });
        if (r.state !== "running") return;
      }
    })();
    return () => {
      stopped = true;
    };
  }, [activeId, wait]);

  // 지우는 정리가 끝나면(잃은 것 포함) 한 번 — 스크립트가 _usage.json 을 새로 썼다
  const runEnded = stage.kind === "run" && stage.job.state !== "running" ? stage.job.jobId : null;
  useEffect(() => {
    if (runEnded) onDoneRef.current();
  }, [runEnded]);

  const begin = async (yes: boolean, items: CleanItemKey[]) => {
    setBusy(true);
    try {
      const r = await start({ cwd, items, yes });
      if (r.ok) setStage({ kind: yes ? "run" : "preview", job: { jobId: r.jobId, items, output: "", state: "running" } });
      else if (r.reason === "busy" && r.jobId) {
        notify("이 프로젝트에서 정리가 이미 돌고 있습니다. 그 진행 상황을 보여 드립니다.", "warn");
        setStage({ kind: "run", job: { jobId: r.jobId, items: r.items ?? items, output: "", state: "running" } });
      } else if (r.reason !== "busy") setStage({ kind: "refused", text: refusalText(r.reason, r.path) });
    } catch (e) {
      notify(`정리 프로그램을 띄우지 못했습니다: ${String(e)}`, "warn");
    }
    setBusy(false);
  };

  // 휴지통 서랍과 같은 작은 단추(codexTrash.tsx btn)
  const btn = (text: string, onPress: () => void, tone?: "danger", disabled = false) => (
    <Pressable
      key={text}
      disabled={busy || disabled}
      style={[
        styles.button,
        { paddingHorizontal: styles.fs(9), paddingVertical: styles.fs(1) },
        tone === "danger" ? { backgroundColor: c.statusDanger } : {},
        busy || disabled ? { opacity: 0.5 } : {},
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={text}
    >
      <Text style={[styles.buttonText, { fontSize: styles.fs(12), lineHeight: styles.fs(18) }, tone ? { color: c.accentForeground } : {}]}>{text}</Text>
    </Pressable>
  );
  const closeBtn = btn("닫기", onClose);
  const lines = { lineHeight: styles.fs(18) };

  const outputPane = (job: Job) => (
    <View style={styles.pane}>
      <Text style={[styles.mono, lines]} selectable>
        {job.output.trim() || (job.state === "running" ? "아직 출력이 없습니다" : "출력이 없습니다")}
      </Text>
    </View>
  );

  /** 끝난 작업의 사정 한 줄(실패만) */
  const failLine = (job: Job) => {
    if (job.state === "lost") return "Paseo 쪽 플러그인이 다시 읽혀 진행 상황을 잃었습니다. 정리가 끝까지 됐는지는 알 수 없습니다. 용량 줄은 다시 읽었습니다.";
    if (job.error) return `정리 프로그램을 띄우지 못했습니다(${job.error}).`;
    if (job.state === "done" && job.exitCode !== 0) return `정리 프로그램이 오류로 끝났습니다(종료 코드 ${job.exitCode ?? "없음"}). 위 출력을 확인해 주십시오.`;
    return "";
  };

  let body: ReactNode = null;
  if (stage.kind === "checking") body = <Text style={styles.muted}>용량 기록을 읽는 중입니다</Text>;
  else if (stage.kind === "refused")
    body = (
      <>
        <Text style={[styles.small, lines, { color: c.statusWarning }]}>{stage.text}</Text>
        <View style={styles.actions}>{closeBtn}</View>
      </>
    );
  else if (stage.kind === "pick" && info) {
    const toggle = (k: CleanItemKey) => setPicked(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
    body = (
      <>
        <Text style={[styles.small, lines]}>
          지울 항목에 체크하십시오. 체크한 항목은 보관 기간과 상관없이 전부 지웁니다 — 진행 중이거나 Claude 가 아직 결과를 받지 않은 실행의 것만
          남깁니다. 크기는 {fmtClock(info.computedAt)} 계산 기준입니다.
        </Text>
        {cleanItems.map((k) => {
          const it = info.items.find((x) => x.key === k);
          const on = picked.includes(k);
          return (
            <Pressable
              key={k}
              onPress={() => toggle(k)}
              style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", paddingTop: 6, borderTopWidth: 1, borderTopColor: c.border }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={LABEL[k]}
            >
              <View
                style={{
                  width: styles.fs(14),
                  height: styles.fs(14),
                  marginTop: styles.fs(2),
                  borderRadius: 3,
                  borderWidth: 1.5,
                  borderColor: on ? c.accent : c.foregroundMuted,
                  backgroundColor: on ? c.accent : "transparent",
                }}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.small}>
                  <Text style={{ fontWeight: "600" }}>{LABEL[k]}</Text>
                  {it ? <Text style={styles.muted}>{`  ${fmtBytes(it.bytes)} · ${COUNT[k](it.count)}`}</Text> : null}
                </Text>
                <Text style={[styles.muted, lines]}>{DETAIL[k]}</Text>
              </View>
            </Pressable>
          );
        })}
        <View style={styles.actions}>
          {btn("미리보기", () => void begin(false, cleanItems.filter((k) => picked.includes(k))), undefined, picked.length === 0)}
          {closeBtn}
        </View>
      </>
    );
  } else if (stage.kind === "preview" && info) {
    const job = stage.job;
    const fail = failLine(job);
    // 확인 문구는 확장 cx.clean.confirm · irreversible · noFollowup · keepLive. 크기 줄(confirmItems)은 미리보기 출력이 지금 값을 보여 대신한다
    body = (
      <>
        <Text style={[styles.small, lines, { fontWeight: "600" }]}>{`"${info.project}" 의 Codex 기록을 지금 지울까요?`}</Text>
        <Text style={styles.muted}>{job.state === "running" ? "미리보기를 만드는 중입니다. 아직 아무것도 지우지 않았습니다." : "미리보기 — 아직 아무것도 지우지 않았습니다."}</Text>
        {outputPane(job)}
        {job.retrying ? <Text style={styles.muted}>결과를 받지 못해 잠시 뒤 다시 묻습니다</Text> : null}
        {fail ? <Text style={[styles.error, lines]}>{fail}</Text> : null}
        {job.state === "done" && !fail ? (
          <View style={{ gap: 4 }}>
            <Text style={[styles.small, lines]}>되돌릴 수 없습니다. 휴지통을 거치지 않고 바로 지웁니다.</Text>
            {job.items.includes("codex") ? <Text style={[styles.small, lines]}>Codex 대화 기록을 지운 실행은 되묻기를 할 수 없게 됩니다.</Text> : null}
            <Text style={[styles.small, lines]}>진행 중인 실행과, Claude 가 아직 결과를 받지 않은 실행은 남깁니다.</Text>
            <Text style={[styles.muted, lines]}>작업 공간이 있는 기기에서 codex-rescue 정리 명령을 실행합니다. 진행 상황은 여기에 나옵니다.</Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          {job.state === "done" && !fail ? btn("지우기", () => void begin(true, job.items), "danger") : null}
          {btn("항목 다시 고르기", () => setStage({ kind: "pick" }), undefined, job.state === "running")}
          {closeBtn}
        </View>
      </>
    );
  } else if (stage.kind === "run") {
    const job = stage.job;
    const fail = failLine(job);
    body = (
      <>
        <Text style={[styles.small, lines]}>
          {job.state === "running"
            ? `${job.items.map((k) => LABEL[k]).join(" · ")} 정리하는 중입니다. 이 칸을 닫아도 정리는 계속됩니다.${job.items.includes("codex") ? " Codex 대화 기록은 한 건에 몇 초씩 걸립니다." : ""}`
            : fail
              ? "정리가 끝나지 못했습니다."
              : "정리가 끝났습니다. 용량 줄을 다시 읽었습니다."}
        </Text>
        {outputPane(job)}
        {job.retrying ? <Text style={styles.muted}>결과를 받지 못해 잠시 뒤 다시 묻습니다</Text> : null}
        {fail ? <Text style={[styles.error, lines]}>{fail}</Text> : null}
        <View style={styles.actions}>{closeBtn}</View>
      </>
    );
  }

  return (
    <View style={[styles.card, { gap: 8 }]}>
      <View style={styles.head}>
        <Text style={styles.title}>{info ? `Codex 기록 지금 정리 — ${info.project}` : "Codex 기록 지금 정리"}</Text>
      </View>
      {body}
    </View>
  );
}
