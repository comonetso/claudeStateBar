import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { projectsHosts } from "../shared/projects";
import {
  AFTER_MAX,
  defaultAccess,
  TEAM_LOGS,
  teamCategoryOrder,
  teamJobStart,
  teamJobWait,
  teamMemberRemove,
  teamMemberSave,
  teamProjectEdit,
  teamServerSkills,
  teamSkills,
  teamState,
  type TeamAccess,
  type TeamJobAction,
  type TeamMember,
} from "../shared/team";

/** 화면에서 고치는 권한 — 풀권한·계정파일만 폴더·열 포트는 글로 받고 저장할 때 나눈다 */
type AccessDraft = { writable: string; addOnly: string; ports: string; logs: string[]; hideSecrets: boolean };
const toDraft = (a: TeamAccess): AccessDraft => ({ writable: a.writable.join("\n"), addOnly: (a.addOnly ?? []).join("\n"), ports: a.ports.join(", "), logs: [...a.logs], hideSecrets: a.hideSecrets });
import { scaled, useFontScale } from "./fontScale";
import { type HostIndex, type ProjectsData } from "./projectsData";
import { ProjectsEditor, type EditScope } from "./projectsManage";
import { FIELD_WIDTH, lineColor, UiButton, UiInput } from "./ui";
import { setHoverTitle, setNoTranslate } from "./web";

// 팀원 관리(10-11 리규형님: "먼저 팀원관리 프로토타입을 제시하고, 내가 검토 후 수정").
// 팀원 = 회사 팀원(외부인 아님). 팀원을 추가할 때 ① 서버(다중) ② 그 팀원에 맞는 글로벌 스킬·명령어를 고른다
// (명령어는 10-11 리규형님 "command 도 나와야 돼"). 스킬·명령어는 고른 서버마다 그 서버의 ~/.claude 에서 읽는다(리규형님 "서버 특화
// 스킬은 내가 추가하고 서버에서 직접 복사" · "서버 특화 커맨드가 있어") — PC 에 없는 것은 "이 서버에만". Paseo·Claude 가 깐 스킬은 뺀다.
// 고른 것은 "서버|skill:이름"·"서버|command:이름" 키로 — 서버가 달라도, 같은 이름이어도 안 섞이게.
// 10-11 리규형님 결정: 넣는 방법 = 복사 + "스킬 다시 맞추기" 단추(원본으로 다시 복사, 팀원 쪽 수정은 덮어씀 — 읽기 전용 연결 안 고름) ·
// Claude 플러그인 칸은 지금 안 만든다(서버 세 플러그인 모두 리규형님 계정·세션에 묶여 있어 주면 울타리가 뚫림).
// 서버 후보 = ~/.ssh/config 의 Host 중 프로젝트 목록에 프로젝트가 있는 서버(GitHub 같은 항목은 프로젝트가 없어 저절로 빠진다).
// 10-11 오후 리규형님: 팀원 전용 프로젝트를 따로 만든다 — 팀원 관리 안에 "팀원 추가"·"팀원 프로젝트 관리" 두 탭, 팀원 프로젝트는
// 팀원(1단계) → 그 팀원의 카테고리(2단계) → 프로젝트. 그래서 팀원 추가에서 리규형님 목록의 프로젝트를 고르던 단계는 뺐다.
// 팀원·팀원 프로젝트는 PC 데몬의 team.json 에 저장한다(server/team).
// 10-11 밤 리규형님 "계획대로 서버 작업까지": 저장하면 고른 서버에 팀원 Paseo 를 만들고(/home/<아이디> + 고른 스킬·명령어 복사,
// 나눠 준 프로젝트만 열기·보기용 목록), 로그인 서버에 연결·계정을 등록한다(server/teamApply).
// 10-11 저녁 리규형님: "서버에 반영" 단추는 없앤다 — 저장·프로젝트 고치기가 곧 반영(실패했을 때만 "다시 시도") ·
// 비밀번호·OTP 는 터미널이 아니라 초대 키(10-10 결정: 일회용·24시간)로 팀원이 로그인 페이지에서 직접 · 안내·진행 상자는 끝나면 접는다 ·
// 삭제는 "완전 삭제"·"홈 디렉터리 유지" 중 고른다.

type Item = { kind: "skill" | "command"; name: string; description: string };
type Props = { theme: PluginTheme; data: ProjectsData | null; index: HostIndex };
/** 서버 작업 진행 — 팀원마다 하나. run = 시작 순번(새 작업이면 진행 상자를 다시 펼친다) */
type JobView = { run: number; lines: string[]; done: boolean; ok: boolean };
type RunJob = (member: string, action: TeamJobAction, onDone?: (ok: boolean, lines: string[]) => void) => void;
/** 화면에 한 번 보여 주는 초대 키 — 저장하지 않는다(화면을 떠나거나 닫으면 사라진다) */
type InviteView = { member: string; key: string; expiresAt: number; link: string };

/** 서버 반영 상태 한 줄 */
function serverState(m: TeamMember): { text: string; warn: boolean } {
  if (!m.applied.length) return { text: "서버에 아직 없음", warn: true };
  if (m.dirty) return { text: `반영이 끝나지 않음 · ${m.applied.join(", ")}`, warn: true };
  return { text: `서버 반영됨 · ${m.applied.join(", ")}`, warn: false };
}

/** 브라우저 클립보드에 넣는다 — 못 쓰는 곳(폰 앱 등)이면 false(글자를 눌러 직접 고르게 둔다) */
async function copyText(text: string): Promise<boolean> {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator;
  if (!nav?.clipboard?.writeText) return false;
  try {
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 서버 작업 진행 줄 — 진행 중·실패면 펼치고, 성공으로 끝나면 한 줄로 접는다(눌러 펼치기) */
function JobLog({ theme, job, fontSize }: { theme: PluginTheme; job: JobView | undefined; fontSize: number }) {
  const [open, setOpen] = useState(false);
  const run = job?.run;
  useEffect(() => setOpen(false), [run]);
  if (!job) return null;
  const c = theme.colors;
  const color = !job.done ? c.foregroundMuted : job.ok ? c.statusSuccess : c.statusDanger;
  const folded = job.done && job.ok && !open;
  if (folded) {
    return (
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <Text style={{ fontSize, color: c.statusSuccess }}>서버 작업 완료 · 기록 보기 ▸</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 2, padding: 8, borderRadius: 6, borderWidth: 1, borderColor: lineColor(theme), backgroundColor: c.surface0 }}>
      {job.lines.slice(-14).map((line, i) => (
        <Text key={i} style={{ fontSize, color: c.foreground }}>
          {line}
        </Text>
      ))}
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Text style={{ fontSize, color }}>{!job.done ? "서버 작업 진행 중… (서버마다 30초~1분)" : job.ok ? "완료" : "실패"}</Text>
        {job.done && job.ok ? (
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
            <Text style={{ fontSize, color: c.foregroundMuted }}>접기 ▴</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** 초대 키 상자 — 키·초대 링크 복사. 닫기 전까지 남고 저장하지 않는다 */
function InviteBox({ theme, invite, fontSize, onClose }: { theme: PluginTheme; invite: InviteView; fontSize: number; onClose: () => void }) {
  const c = theme.colors;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) =>
    void copyText(text).then((ok) => setCopied(ok ? `${label} 복사했습니다` : "복사하지 못했습니다 — 글자를 눌러 직접 골라 복사하세요"));
  const until = new Date(invite.expiresAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const untilText = `${until.getMonth() + 1}월 ${until.getDate()}일 ${pad(until.getHours())}:${pad(until.getMinutes())}`;
  return (
    <View style={{ gap: 6, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface1 }}>
      <Text style={{ fontSize, fontWeight: "600", color: c.accent }}>{`${invite.member} 의 초대 키 — ${untilText} 까지 한 번만 쓸 수 있습니다`}</Text>
      <Text selectable style={{ fontSize: fontSize + 4, fontWeight: "700", color: c.foreground, letterSpacing: 1 }}>
        {invite.key}
      </Text>
      <Text selectable style={{ fontSize: fontSize - 1, color: c.foregroundMuted }}>
        {invite.link}
      </Text>
      <Text style={{ fontSize: fontSize - 1, color: c.foregroundMuted }}>
        팀원에게 초대 링크를 보내면 누르기만 하면 됩니다(키만 보내면 로그인 페이지의 "초대 키로 처음 등록"에 넣습니다). 팀원이 비밀번호와 자기 폰 OTP 를 직접
        정합니다. 이 키는 다시 보여 드리지 않습니다 — 잃어버리면 팀원 줄의 "초대 키 다시 발급"을 누르세요.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <UiButton theme={theme} label="초대 링크 복사" tone="accent" fontSize={fontSize} onPress={() => copy("초대 링크를", invite.link)} />
        <UiButton theme={theme} label="키만 복사" fontSize={fontSize} onPress={() => copy("키를", invite.key)} />
        <UiButton theme={theme} label="닫기" fontSize={fontSize} onPress={onClose} />
        {copied ? <Text style={{ fontSize: fontSize - 1, color: c.foregroundMuted }}>{copied}</Text> : null}
      </View>
    </View>
  );
}
type Sub = "members" | "projects";
const SUBS: { id: Sub; label: string }[] = [
  { id: "members", label: "팀원 추가" },
  { id: "projects", label: "팀원 프로젝트 관리" },
];

export function TeamManage({ theme, data, index }: Props) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);
  const readTeam = useRpc(teamState);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readTeam({})
      .then((r) => alive && setMembers(r.members))
      .catch((err) => alive && setLoadError(`팀원 목록을 읽지 못했습니다 — ${String(err instanceof Error ? err.message : err)}`));
    return () => {
      alive = false;
    };
  }, [readTeam]);
  const [sub, setSub] = useState<Sub>("members");

  // 서버 작업 — 시작하고, 끝날 때까지 25초씩 기다리기를 되풀이한다(Paseo 요청 한도 30초). 끝나면 팀원 목록을 다시 읽는다
  const startJob = useRpc(teamJobStart);
  const waitJob = useRpc(teamJobWait);
  const [jobs, setJobs] = useState<Record<string, JobView>>({});
  const [invites, setInvites] = useState<InviteView[]>([]);
  const alive = useRef(true);
  const runCount = useRef(0);
  // 반영 중인 팀원과, 반영 중에 또 고쳐 끝난 뒤 한 번 더 반영할 팀원
  const running = useRef(new Set<string>());
  // 값 = 그 반영이 실패하면 부를 것들(방금 추가한 프로젝트 되돌리기 — 10-11 리규형님 "실패시 만들어졌던 것 삭제")
  const again = useRef(new Map<string, ((lines: string[]) => void)[]>());
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const runJob: RunJob = useCallback(
    (member, action, onDone) => {
      const run = ++runCount.current;
      const put = (view: Omit<JobView, "run">) => alive.current && setJobs((cur) => ({ ...cur, [member]: { run, ...view } }));
      running.current.add(member);
      void (async () => {
        let lines: string[] = [];
        put({ lines, done: false, ok: false });
        const started = await startJob({ member, action }).catch((err: unknown) => ({ ok: false, error: String(err instanceof Error ? err.message : err), jobId: undefined }));
        if (!started.ok || !started.jobId) {
          running.current.delete(member);
          const failed = [started.error ?? "서버 작업을 시작하지 못했습니다"];
          put({ lines: failed, done: true, ok: false });
          onDone?.(false, failed);
          return;
        }
        let ok = false;
        for (;;) {
          let w: Awaited<ReturnType<typeof waitJob>>;
          try {
            w = await waitJob({ jobId: started.jobId, seen: lines.length });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }
          if (w.lost) {
            lines = [...lines, "데몬 쪽 플러그인이 다시 읽혀 진행을 놓쳤습니다 — 팀원 목록의 서버 반영 상태로 결과를 확인하세요"];
            break;
          }
          const got = w.invite;
          if (got && alive.current) setInvites((cur) => [...cur.filter((x) => x.member !== got.member), got]);
          lines = [...lines, ...w.lines];
          ok = w.ok;
          put({ lines, done: w.done, ok });
          if (w.done) break;
        }
        put({ lines, done: true, ok });
        running.current.delete(member);
        const r = await readTeam({}).catch(() => null);
        if (r && alive.current) setMembers(r.members);
        if (alive.current) onDone?.(ok, lines);
        // 반영 중에 또 고친 것 — 지운 팀원이 아니면 한 번 더(그 반영이 실패하면 기다리던 되돌리기를 부른다)
        const queued = again.current.get(member);
        again.current.delete(member);
        if (queued && alive.current && r?.members.some((m) => m.id === member)) {
          runJob(member, "apply", (done, got) => {
            if (!done) for (const fail of queued) fail(got);
          });
        }
      })();
    },
    [startJob, waitJob, readTeam],
  );
  /** 고친 것을 바로 서버에 — 반영 중이면 끝난 뒤 한 번 더(10-11 리규형님: "서버에 반영" 단추 없이). onFail = 반영이 실패하면 */
  const requestApply = useCallback(
    (member: string, onFail?: (lines: string[]) => void) => {
      if (running.current.has(member)) {
        const list = again.current.get(member) ?? [];
        if (onFail) list.push(onFail);
        again.current.set(member, list);
      } else {
        runJob(member, "apply", (done, got) => {
          if (!done) onFail?.(got);
        });
      }
    },
    [runJob],
  );

  // 안내는 팀원이 없을 때만 펼쳐 두고, 있으면 한 줄로 접는다(10-11 리규형님 "다 하고 나면 접혀야")
  const [guideOpen, setGuideOpen] = useState<boolean | null>(null);
  const guideShown = guideOpen ?? (members !== null && members.length === 0);

  const muted = (text: string) => <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{text}</Text>;
  return (
    <View ref={setNoTranslate} style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {SUBS.map((t) => {
          const on = sub === t.id;
          return (
            <Pressable
              key={t.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setSub(t.id)}
              style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: on ? c.accent : lineColor(theme),
                backgroundColor: on || hovered ? c.surface2 : "transparent",
              })}
            >
              <Text style={{ fontSize: fs(12), fontWeight: on ? "600" : "400", color: on ? c.accent : c.foregroundMuted }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {guideShown ? (
        <View style={{ gap: 4, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: fs(12), color: c.accent, fontWeight: "600" }}>팀원을 저장하면 고른 서버에 그대로 만들어집니다</Text>
            <Pressable accessibilityRole="button" onPress={() => setGuideOpen(false)}>
              <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>접기 ▴</Text>
            </Pressable>
          </View>
          {muted("· 팀원과 팀원 프로젝트는 이 PC 에 저장되고, 저장하거나 팀원 프로젝트를 고치는 순간 고른 서버에 반영됩니다. 반영하는 동안 그 팀원의 Paseo 가 잠깐 다시 시작됩니다. 따로 누를 단추는 없고, 실패했을 때만 \"다시 시도\"가 나옵니다.")}
          {muted("· 서버마다 그 팀원 전용 Paseo(울타리 안에서 도는 팀원용 Paseo)를 하나씩 만듭니다(하나당 메모리 110~140MB).")}
          {muted("· 팀원 홈은 /home/<아이디> 한 곳입니다. 고른 스킬·명령어를 그 안 .claude 로 복사합니다. 리규형님이 원본을 고쳐도 팀원 쪽은 그대로이고, \"스킬 다시 맞추기\"를 누르면 원본으로 다시 복사합니다(팀원 쪽에서 고친 것은 서버 백업으로).")}
          {muted("· 팀원 화면의 프로젝트 목록에는 \"팀원 프로젝트 관리\"에서 나눠 준 프로젝트만 보이고, 팀원은 보기만 합니다. 고르지 않은 스킬·명령어, Claude 플러그인, 리규형님 지시·메모리는 가지 않습니다.")}
          {muted("· 처음 추가하면 초대 키가 나옵니다. 팀원에게 전하면 팀원이 로그인 페이지의 \"초대 키로 처음 등록\"에서 비밀번호와 자기 폰 OTP 를 직접 정합니다(24시간 안에 한 번만). 팀원이 로그인하면 고른 서버만 보입니다.")}
          {muted("· 삭제할 때는 \"완전 삭제\"(홈까지 모두)와 \"홈 디렉터리 유지\" 중 고릅니다. 어느 쪽이든 같은 아이디로 다시 만들 수 있습니다.")}
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setGuideOpen(true)}>
          <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>팀원을 저장하면 어떻게 되나요 ▸</Text>
        </Pressable>
      )}
      {invites.map((inv) => (
        <InviteBox key={inv.member} theme={theme} invite={inv} fontSize={fs(11)} onClose={() => setInvites((cur) => cur.filter((x) => x.member !== inv.member))} />
      ))}
      {loadError ? <Text style={{ fontSize: fs(12), color: c.statusDanger }}>{loadError}</Text> : null}
      {members === null ? (
        loadError ? null : muted("팀원 목록을 읽는 중…")
      ) : sub === "members" ? (
        <MemberAdd theme={theme} data={data} index={index} members={members} onMembers={setMembers} jobs={jobs} runJob={runJob} />
      ) : (
        <TeamProjects theme={theme} members={members} onMembers={setMembers} onAddMember={() => setSub("members")} jobs={jobs} runJob={runJob} requestApply={requestApply} />
      )}
    </View>
  );
}

// 팀원 프로젝트 관리 — 프로젝트 관리 탭과 같은 편집기를 팀원마다(1단계 = 팀원, 2단계 = 그 팀원의 카테고리)
function TeamProjects({
  theme,
  members,
  onMembers,
  onAddMember,
  jobs,
  runJob,
  requestApply,
}: {
  theme: PluginTheme;
  members: TeamMember[];
  onMembers: (m: TeamMember[]) => void;
  onAddMember: () => void;
  jobs: Record<string, JobView>;
  runJob: RunJob;
  requestApply: (member: string, onFail?: (lines: string[]) => void) => void;
}) {
  const c = theme.colors;
  const scale = useFontScale();
  const editProject = useRpc(teamProjectEdit);
  const writeOrder = useRpc(teamCategoryOrder);
  const [notice, setNotice] = useState<string | null>(null);
  // 팀원 머리마다 서버 반영 상태 — 고치면 바로 반영하고(반영할 때마다 그 팀원 Paseo 가 잠깐 다시 시작), 실패했을 때만 "다시 시도"
  const scopes = useMemo<EditScope[]>(
    () =>
      members.map((m) => {
        const state = serverState(m);
        const running = !!jobs[m.id] && !jobs[m.id].done;
        return {
          id: m.id,
          title: m.id,
          entries: m.projects,
          categoryOrder: m.categoryOrder,
          hosts: m.servers,
          extra: (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: scaled(13, scale), color: running ? c.foregroundMuted : state.warn ? c.statusWarning : c.statusSuccess }}>
                {running ? "서버에 반영하는 중…" : state.text}
              </Text>
              {!running && state.warn ? (
                <UiButton theme={theme} label="다시 시도" tone="accent" fontSize={scaled(14, scale)} hint="이 팀원의 프로젝트·스킬을 고른 서버에 다시 반영합니다(그 팀원 Paseo 가 잠깐 다시 시작)" onPress={() => runJob(m.id, "apply")} />
              ) : null}
            </View>
          ),
          below: <JobLog theme={theme} job={jobs[m.id]} fontSize={scaled(13, scale)} />,
          // 기본 프로젝트 = 서버마다 팀원 홈(서버 팀원 도구가 팀원 목록 맨 위에 넣는다 — 10-11 리규형님 "삭제 불가, 항상 최상위") ·
          // 카테고리 "홈" 아래 이름은 계정 아이디(리규형님 "홈 > {계정ID}")
          pinned: m.servers.map((host) => ({ name: m.id, host, path: `/home/${m.id}`, category: "홈" })),
        };
      }),
    [members, jobs, theme, scale],
  );
  if (members.length === 0) {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: scaled(14, scale), color: c.foregroundMuted }}>아직 팀원이 없습니다. 팀원 프로젝트는 팀원 아래에 만들므로 팀원을 먼저 추가해 주세요.</Text>
        <View style={{ flexDirection: "row" }}>
          <UiButton theme={theme} label="팀원 추가 탭으로" tone="accent" fontSize={scaled(14, scale)} onPress={onAddMember} />
        </View>
      </View>
    );
  }
  return (
    <ProjectsEditor
      theme={theme}
      scopes={scopes}
      scopeLabel="팀원"
      notice={notice}
      edit={async (member, op) => {
        setNotice(null);
        const r = await editProject({ member, op });
        onMembers(r.members);
        if (!r.ok) return r;
        // 추가한 프로젝트가 서버에 반영되지 못하면 목록에서 빼고 원래대로 다시 반영한다(10-11 리규형님 "실패시 만들어졌던 것 삭제").
        // 새로 만든 카테고리는 그 프로젝트 하나뿐이라 함께 사라진다
        if (op.op === "add") {
          requestApply(member, (lines) => {
            const why = [...lines].reverse().find((l) => / 실패|못했습니다|거절|위험/.test(l)) ?? "서버 반영 실패";
            void editProject({ member, op: { op: "remove", key: `${op.host}|${op.path}` } }).then((back) => {
              onMembers(back.members);
              setNotice(`서버에 반영하지 못해 방금 추가한 ${op.name || op.path} 를 목록에서 뺐습니다 — ${why}`);
              if (back.ok) requestApply(member);
            });
          });
        } else requestApply(member);
        return r;
      }}
      setCategoryOrder={(member, names) => {
        // 바로 옮기고 데몬 답으로 맞춘다(실패하면 데몬에 있는 그대로)
        onMembers(members.map((m) => (m.id === member ? { ...m, categoryOrder: names } : m)));
        void writeOrder({ member, names })
          .then((r) => {
            onMembers(r.members);
            if (r.ok) requestApply(member);
          })
          .catch(() => onMembers(members));
      }}
      intro="팀원마다 따로 두는 프로젝트입니다. 리규형님 프로젝트 목록과 섞이지 않고, 팀원 → 그 팀원의 카테고리 → 프로젝트로 묶입니다. 고치면 그 팀원의 서버에 바로 반영됩니다(그 팀원 Paseo 가 잠깐 다시 시작). 서버 폴더 자체는 건드리지 않습니다."
      emptyText="아직 팀원 프로젝트가 없습니다"
      pathHint={() => "예: /home/ceo — 그 서버의 폴더 경로, / 로 시작합니다"}
    />
  );
}

function MemberAdd({ theme, data, index, members, onMembers, jobs, runJob }: Props & { members: TeamMember[]; onMembers: (m: TeamMember[]) => void; jobs: Record<string, JobView>; runJob: RunJob }) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);
  const entries = data?.entries ?? [];
  const readHosts = useRpc(projectsHosts);
  const readSkills = useRpc(teamSkills);
  const readServerSkills = useRpc(teamServerSkills);
  const saveMember = useRpc(teamMemberSave);
  const removeMember = useRpc(teamMemberRemove);

  const [hosts, setHosts] = useState<string[]>([]);
  // PC 목록 — "이 서버에만" 표시용 비교. 고르는 목록은 서버마다 SSH 로 읽는다(serverLists)
  const [skills, setSkills] = useState<Item[]>([]);
  const [serverLists, setServerLists] = useState<Record<string, { skills: Item[]; logs?: string[]; error: string | null } | "loading">>({});
  useEffect(() => {
    let alive = true;
    void readHosts({})
      .then((r) => alive && setHosts(r.hosts))
      .catch(() => {});
    void readSkills({})
      .then((r) => alive && setSkills(r.skills))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [readHosts, readSkills]);

  const servers = useMemo(() => hosts.filter((h) => h !== "PC" && entries.some((e) => e.host === h)), [hosts, entries]);

  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // 팀원 추가 칸 — 팀원이 없을 때만 펼쳐 두고, 저장하면 접는다(10-11 리규형님 "추가할 때도 마찬가지")
  const [formOpen, setFormOpen] = useState(members.length === 0);

  const [id, setId] = useState("");
  const [pickServers, setPickServers] = useState<Set<string>>(new Set());
  const [pickSkills, setPickSkills] = useState<Set<string>>(new Set());
  const [skillFilter, setSkillFilter] = useState("");
  // 서버마다 권한(10-11 저녁 리규형님 "계정 만들 때 설정 먼저") — 고른 적 없는 서버는 기본값
  const [pickAccess, setPickAccess] = useState<Record<string, AccessDraft>>({});
  const accessOf = (h: string) => pickAccess[h] ?? toDraft(defaultAccess());
  const setAccess = (h: string, patch: Partial<AccessDraft>) => setPickAccess((cur) => ({ ...cur, [h]: { ...(cur[h] ?? toDraft(defaultAccess())), ...patch } }));
  // 서버마다 계정을 만든 뒤 실행할 명령(10-12 리규형님) — 처음엔 한 칸, "명령 추가"로 AFTER_MAX 칸까지
  const [pickAfter, setPickAfter] = useState<Record<string, string[]>>({});
  const afterOf = (h: string) => pickAfter[h] ?? [""];
  const setAfterAt = (h: string, i: number, v: string) => setPickAfter((cur) => ({ ...cur, [h]: (cur[h] ?? [""]).map((x, n) => (n === i ? v : x)) }));
  const addAfter = (h: string) => setPickAfter((cur) => ({ ...cur, [h]: [...(cur[h] ?? [""]), ""].slice(0, AFTER_MAX) }));

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const toggleServer = (h: string) => {
    const next = toggle(pickServers, h);
    setPickServers(next);
    // 서버를 빼면 그 서버 스킬·명령어 고른 것도 뺀다
    if (!next.has(h)) setPickSkills(new Set([...pickSkills].filter((k) => !k.startsWith(`${h}|`))));
  };
  const projectsOf = (h: string) => entries.filter((e) => e.host === h);

  // 고른 서버의 스킬·명령어를 처음 고를 때 한 번 읽는다(오류면 "다시 읽기")
  const loadServer = (h: string) => {
    setServerLists((cur) => ({ ...cur, [h]: "loading" }));
    readServerSkills({ host: h })
      .then((r) => setServerLists((cur) => ({ ...cur, [h]: r })))
      .catch((err) => setServerLists((cur) => ({ ...cur, [h]: { skills: [], error: `읽지 못했습니다 — ${String(err instanceof Error ? err.message : err)}` } })));
  };
  useEffect(() => {
    for (const h of pickServers) if (!serverLists[h]) loadServer(h);
  }, [pickServers]);
  const pcKeys = useMemo(() => new Set(skills.map((s) => `${s.kind}:${s.name}`)), [skills]);
  const matches = (s: Item) => {
    const q = skillFilter.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  };

  const resetForm = () => {
    setId("");
    setPickServers(new Set());
    setPickSkills(new Set());
    setPickAccess({});
    setPickAfter({});
    setEditing(null);
  };
  const submit = async () => {
    const name = id.trim();
    if (!name) return setMessage({ text: "아이디를 넣어 주세요", bad: true });
    if (pickServers.size === 0) return setMessage({ text: "서버를 하나 이상 골라 주세요", bad: true });
    // 쓸 폴더는 줄마다(쉼표도 됨), 열 포트는 쉼표·띄어쓰기로 나눈다 — 자세한 검사는 저장하는 쪽(server/team.ts)
    const access: Record<string, TeamAccess> = {};
    for (const h of pickServers) {
      const d = accessOf(h);
      const portWords = d.ports.split(/[\s,]+/).filter(Boolean);
      const bad = portWords.find((w) => !/^\d+$/.test(w));
      if (bad) return setMessage({ text: `${h} 열 포트 "${bad}" — 숫자만 넣어 주세요(여러 개는 쉼표로)`, bad: true });
      access[h] = {
        writable: d.writable.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean),
        addOnly: d.addOnly.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean),
        ports: portWords.map(Number),
        logs: d.logs,
        hideSecrets: d.hideSecrets,
      };
    }
    // 빈 칸은 버린다 — 자세한 검사(한 줄·길이·개수)는 저장하는 쪽(server/team.ts cleanAfter)
    const after = Object.fromEntries([...pickServers].map((h) => [h, afterOf(h).map((x) => x.trim()).filter(Boolean)]));
    setBusy(true);
    setMessage(null);
    try {
      const r = await saveMember({ previousId: editing, id: name, servers: [...pickServers], skills: [...pickSkills], access, after });
      onMembers(r.members);
      if (!r.ok) return setMessage({ text: r.error ?? "저장하지 못했습니다", bad: true });
      resetForm();
      setFormOpen(false);
      // 저장하면 고른 서버에 바로 반영(10-11 계획 "저장 → 고른 서버마다 apply")
      runJob(name, "apply");
    } catch (err) {
      setMessage({ text: `저장하지 못했습니다: ${String(err instanceof Error ? err.message : err)}`, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (memberId: string, home: "keep" | "purge" = "keep") => {
    // 서버에 만든 팀원은 서버·로그인 서버에서 먼저 지운다(서버 작업이 끝나면 목록에서도 지운다)
    const target = members.find((x) => x.id === memberId);
    if (target && (target.applied.length > 0 || target.loginAdded)) {
      setConfirmDelete(null);
      if (editing === memberId) resetForm();
      runJob(memberId, home === "purge" ? "remove-purge" : "remove-keep");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await removeMember({ id: memberId });
      onMembers(r.members);
      setConfirmDelete(null);
      if (editing === memberId) resetForm();
      setMessage(r.ok ? { text: `${memberId} 를 지웠습니다`, bad: false } : { text: r.error ?? "지우지 못했습니다", bad: true });
    } catch (err) {
      setMessage({ text: `지우지 못했습니다: ${String(err instanceof Error ? err.message : err)}`, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const startEdit = (m: TeamMember) => {
    setEditing(m.id);
    setId(m.id);
    setPickServers(new Set(m.servers));
    setPickSkills(new Set(m.skills));
    setPickAccess(Object.fromEntries(m.servers.map((h) => [h, toDraft(m.access?.[h] ?? defaultAccess())])));
    setPickAfter(Object.fromEntries(m.servers.map((h) => [h, m.after?.[h]?.length ? [...m.after[h]] : [""]])));
    setConfirmDelete(null);
    setMessage(null);
    setFormOpen(true);
  };

  const box = { gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 } as const;
  const title = (text: string) => <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foreground }}>{text}</Text>;
  const muted = (text: string) => <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{text}</Text>;
  const button = (label: string, onPress: () => void, opts: { tone?: "danger" | "accent"; hint?: string; disabled?: boolean } = {}) => (
    <UiButton key={label} theme={theme} label={label} fontSize={fs(11)} onPress={onPress} disabled={busy || opts.disabled} tone={opts.tone} hint={opts.hint} />
  );
  const check = (key: string, on: boolean, label: string, onPress: () => void, sub?: string) => (
    <Pressable
      key={key}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 4,
        paddingHorizontal: 6,
        borderRadius: 6,
        backgroundColor: hovered ? c.surface2 : "transparent",
      })}
    >
      <View
        style={{
          width: 16,
          height: 16,
          marginTop: 2,
          borderRadius: 3,
          borderWidth: 1.5,
          borderColor: on ? c.accent : lineColor(theme),
          backgroundColor: on ? c.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {on ? <Text style={{ color: c.surface0, fontSize: 11, fontWeight: "700", lineHeight: 13 }}>✓</Text> : null}
      </View>
      <View style={{ flexShrink: 1 }}>
        <Text style={{ fontSize: fs(12), color: c.foreground }}>{label}</Text>
        {sub ? <Text style={{ fontSize: fs(10), color: c.foregroundMuted }} numberOfLines={2}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
  const chip = (text: string, key: string) => (
    <View key={key} style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: c.surface2 }}>
      <Text style={{ fontSize: fs(10), color: c.foreground }}>{text}</Text>
    </View>
  );
  // 이름표 + 입력(10-11 리규형님: 흐린 안내 글로 이름을 대신하지 않는다 — 프로젝트 관리 탭과 같은 모양)
  const field = (label: string, content: ReactNode, hint?: string) => (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <Text style={{ width: fs(11) * 5.5, paddingTop: 5, fontSize: fs(11), color: c.foregroundMuted }}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        {content}
        {hint ? <Text style={{ fontSize: fs(10), color: c.foregroundMuted }}>{hint}</Text> : null}
      </View>
    </View>
  );
  // 고른 스킬·명령어 키 = "서버|skill:이름"·"서버|command:이름" — 서버가 달라도, 같은 이름의 스킬·명령어여도 안 섞이게
  const itemKey = (h: string, s: Item) => `${h}|${s.kind}:${s.name}`;
  const nameLabel = (kind: string, name: string) => (kind === "command" ? `/${name}` : name);
  const itemLabel = (k: string) => {
    const [h, rest] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const kind = rest.slice(0, rest.indexOf(":"));
    return `${h} · ${nameLabel(kind, rest.slice(kind.length + 1))}`;
  };
  const skillGroup = (h: string, list: Item[], kind: "skill" | "command", label: string) => {
    const all = list.filter((s) => s.kind === kind);
    const shown = all.filter(matches);
    return (
      <View key={`kg-${h}-${kind}`} style={{ gap: 2, paddingLeft: 8 }}>
        <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{`${label} ${all.length}`}</Text>
        {all.length === 0 ? muted(`${label} 없음`) : shown.length === 0 ? muted("찾는 말에 맞는 것이 없습니다") : null}
        {shown.map((s) => {
          const only = skills.length > 0 && !pcKeys.has(`${s.kind}:${s.name}`);
          const sub = [only ? "이 서버에만" : "", s.description].filter(Boolean).join(" · ");
          return check(`skl-${itemKey(h, s)}`, pickSkills.has(itemKey(h, s)), nameLabel(s.kind, s.name), () => setPickSkills(toggle(pickSkills, itemKey(h, s))), sub || undefined);
        })}
      </View>
    );
  };
  const serverSkills = (h: string) => {
    const got = serverLists[h];
    return (
      <View key={`sk-${h}`} style={{ gap: 2, paddingLeft: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{h}</Text>
          {got === "loading" || !got ? muted("서버에서 읽는 중…") : got.error ? button("다시 읽기", () => loadServer(h)) : null}
        </View>
        {got && got !== "loading" && got.error ? <Text style={{ fontSize: fs(11), color: c.statusDanger }}>{got.error}</Text> : null}
        {got && got !== "loading" && !got.error ? [skillGroup(h, got.skills, "skill", "스킬"), skillGroup(h, got.skills, "command", "명령어")] : null}
      </View>
    );
  };

  // 서버 한 대의 권한 칸 — 기록은 그 서버에 있는 것만(서버 스킬을 읽을 때 같이 본다)
  const serverAccess = (h: string) => {
    const a = accessOf(h);
    const got = serverLists[h];
    const present = got && got !== "loading" && !got.error ? (got.logs ?? []) : null;
    const logs = TEAM_LOGS.filter((l) => present?.includes(l.path) || a.logs.includes(l.path));
    const input = (value: string, onChange: (v: string) => void, placeholder: string, multiline = false) => (
      <UiInput
        theme={theme}
        fontSize={fs(12)}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={{ width: FIELD_WIDTH, ...(multiline ? { minHeight: fs(12) * 4 } : {}) }}
      />
    );
    return (
      <View key={`ac-${h}`} style={{ gap: 6, paddingLeft: 8 }}>
        <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{h}</Text>
        {field(
          "풀권한 폴더",
          input(a.writable, (v) => setAccess(h, { writable: v }), "/home/프로젝트/docs/보고서", true),
          "한 줄에 하나 — 팀원 프로젝트 안 폴더만 고칠 수 있게 엽니다. 프로젝트 경로를 그대로 적으면 그 프로젝트 전체를 고칠 수 있습니다. 비우면 팀원 프로젝트는 모두 읽기만 — 안의 파일 내용은 설정 파일까지 리규형님처럼 다 읽힙니다(팀원 홈은 늘 고칠 수 있음)",
        )}
        {field(
          "계정파일만\n폴더",
          input(a.addOnly, (v) => setAccess(h, { addOnly: v }), "/home/프로젝트/docs/보고서함", true),
          "한 줄에 하나 — 팀원이 새 파일을 만들고, 자기가 만든 파일만 고치거나 지울 수 있습니다. 원래 있던 파일과 남이 만든 파일은 읽기만 됩니다(보고서 보관함처럼 같이 쓰는 폴더). 풀권한 폴더와 겹치게 적을 수는 없습니다",
        )}
        {field(
          "열 포트",
          input(a.ports, (v) => setAccess(h, { ports: v }), "예: 3306"),
          "이 서버 안에서 팀원이 붙을 수 있는 포트(쉼표로 여러 개). 비우면 서버 안은 모두 막힙니다. DB(3306)를 열어도 접속 정보가 있어야 쓸 수 있고, 프로젝트 설정의 접속 정보를 쓰면 그 계정 권한(고치기·지우기 포함) 그대로입니다",
        )}
        {field(
          "읽을 기록",
          <View style={{ gap: 2 }}>
            {present === null && logs.length === 0 ? muted("서버에서 읽는 중…") : logs.length === 0 ? muted("이 서버에는 붙일 수 있는 기록이 없습니다") : null}
            {logs.map((l) =>
              check(
                `log-${h}-${l.path}`,
                a.logs.includes(l.path),
                l.label,
                () => setAccess(h, { logs: a.logs.includes(l.path) ? a.logs.filter((x) => x !== l.path) : [...a.logs, l.path] }),
                `${l.path} · ${l.note}`,
              ),
            )}
          </View>,
          "읽기만 됩니다",
        )}
        {field(
          "비밀 파일",
          check(
            `hide-${h}`,
            a.hideSecrets,
            "가리기",
            () => setAccess(h, { hideSecrets: !a.hideSecrets }),
            "켜면 팀원 프로젝트 안 .env·.env.*(DB 비밀번호·API 키)를 팀원 Claude 가 빈 파일로 봅니다. 반영할 때 이름으로 찾아 막으므로 그 뒤 새로 생긴 파일은 다음 반영 때 가려지고, 다른 이름의 비밀까지 막지는 못합니다. 켜면 열어 준 DB 포트도 그 접속 정보로는 못 씁니다. 끄면(기본) 리규형님처럼 그대로 읽힙니다",
          ),
        )}
        {field(
          "생성뒤\n실행명령어",
          <View style={{ gap: 4 }}>
            {afterOf(h).map((cmd, i) => {
              // 이미 실행한 명령이면 마지막 결과를 칸 아래에 — 성공한 명령은 다시 실행하지 않는다
              const ran = members.find((x) => x.id === editing)?.afterRan?.[h]?.find((r) => r.command === cmd.trim());
              return (
                <View key={`af-${h}-${i}`} style={{ gap: 2 }}>
                  {input(cmd, (v) => setAfterAt(h, i, v), i === 0 ? `예: \\cp -f /root/.claude-${id.trim() || "아이디"}/commands/* /home/${id.trim() || "아이디"}/.claude/commands/` : "명령 한 줄")}
                  {ran ? (
                    <Text style={{ fontSize: fs(10), color: ran.ok ? c.statusSuccess : c.statusDanger }}>
                      {ran.ok ? `실행함 (${new Date(ran.at).toLocaleString()})` : `실패(종료 코드 ${ran.code ?? "시간 초과"}) — 다음 저장 때 다시 실행${ran.out ? ` · ${ran.out.replace(/\n/g, " / ")}` : ""}`}
                    </Text>
                  ) : null}
                </View>
              );
            })}
            {afterOf(h).length < AFTER_MAX ? <View style={{ flexDirection: "row" }}>{button("명령 추가", () => addAfter(h))}</View> : null}
          </View>,
          `계정을 만든 뒤(서버 반영·로그인 계정까지 끝난 뒤) 이 서버에서 관리자 권한으로 적은 차례대로 한 번 실행합니다(${AFTER_MAX}개까지). 성공한 명령은 다시 실행하지 않고, 실패하면 거기서 멈췄다가 다음 저장 때 그 명령부터 다시 합니다. 끝나면 팀원 홈 안 파일은 팀원 소유로 돌립니다. 비밀번호 같은 값은 넣지 마세요(PC 의 팀원 기록에 그대로 남습니다)`,
        )}
      </View>
    );
  };

  return (
    <View style={{ gap: 14 }}>
      {message ? <Text style={{ fontSize: fs(12), color: message.bad ? c.statusDanger : c.statusSuccess }}>{message.text}</Text> : null}

      {/* 팀원 목록 */}
      <View style={{ gap: 6 }}>
        {title(`팀원 ${members.length}`)}
        {members.length === 0 ? muted("아직 팀원이 없습니다. 아래에서 추가해 보세요.") : null}
        {members.map((m) => {
          const state = serverState(m);
          const running = !!jobs[m.id] && !jobs[m.id].done;
          const onServer = m.applied.length > 0 || m.loginAdded;
          return (
          <View key={m.id} style={{ gap: 6, paddingVertical: 8, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foreground }}>{m.id}</Text>
              <Text style={{ fontSize: fs(11), color: state.warn ? c.statusWarning : c.statusSuccess }}>{state.text}</Text>
              <View style={{ flex: 1 }} />
              {!running && state.warn
                ? button("다시 시도", () => runJob(m.id, "apply"), { tone: "accent", hint: "고른 서버에 이 팀원 Paseo 를 다시 만들거나 고칩니다(그 팀원 Paseo 가 잠깐 다시 시작)" })
                : null}
              {button("고치기", () => startEdit(m), { disabled: running })}
              {m.loginAdded
                ? button("초대 키 다시 발급", () => runJob(m.id, "invite"), {
                    disabled: running,
                    hint: "등록을 아직 안 마친 팀원에게 새 초대 키를 냅니다(전 키는 못 쓰게 됩니다). 이미 등록을 마친 팀원이면 서버가 거절합니다",
                  })
                : null}
              {m.applied.length > 0 && m.skills.length > 0
                ? button("스킬 다시 맞추기", () => runJob(m.id, "skills"), {
                    disabled: running,
                    hint: "서버 원본에서 고른 스킬·명령어를 다시 복사합니다(팀원 쪽에서 고친 것은 서버 백업으로 옮기고 덮어씁니다)",
                  })
                : null}
              {confirmDelete === m.id
                ? onServer
                  ? [
                      button("완전 삭제", () => void remove(m.id, "purge"), {
                        tone: "danger",
                        hint: `팀원 Paseo·설정·대화 기록·/home/${m.id} 까지 모두 지우고 로그인 계정·연결도 지웁니다. 되돌릴 수 없습니다. 같은 아이디로 다시 만들 수 있습니다`,
                      }),
                      button("홈 디렉터리 유지", () => void remove(m.id, "keep"), {
                        tone: "danger",
                        hint: `/home/${m.id} 만 남기고 나머지를 지웁니다(설정·대화 기록은 서버 백업으로). 같은 아이디로 다시 만들면 그 홈을 이어 씁니다`,
                      }),
                      button("취소", () => setConfirmDelete(null)),
                    ]
                  : [button("정말 삭제", () => void remove(m.id), { tone: "danger" }), button("취소", () => setConfirmDelete(null))]
                : button("삭제", () => setConfirmDelete(m.id), {
                    tone: "danger",
                    disabled: running,
                    hint: onServer
                      ? "서버의 팀원 Paseo·로그인 계정·연결을 지우고 목록에서도 지웁니다 — 누르면 홈 디렉터리까지 지울지 고릅니다"
                      : "이 팀원과 그 팀원 프로젝트 목록을 지웁니다(서버에는 아직 만들지 않았습니다)",
                  })}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {muted("서버")}
              {m.servers.map((s) => chip(s, `s-${s}`))}
            </View>
            {muted(`팀원 프로젝트 ${m.projects.length}`)}
            {m.servers.map((s) => {
              const a = m.access?.[s] ?? defaultAccess();
              const after = m.after?.[s] ?? [];
              const ran = (m.afterRan?.[s] ?? []).filter((r) => after.includes(r.command));
              const okCount = ran.filter((r) => r.ok).length;
              const failCount = ran.length - okCount;
              return (
                <View key={`acc-${s}`}>
                  {muted(
                    `권한 ${s} — 풀권한 폴더 ${a.writable.length ? a.writable.join(", ") : "없음(프로젝트 읽기만)"}${a.addOnly?.length ? ` · 계정파일만 폴더 ${a.addOnly.join(", ")}` : ""} · 열 포트 ${a.ports.length ? a.ports.join(", ") : "없음"} · 기록 ${a.logs.length ? a.logs.map((p) => TEAM_LOGS.find((l) => l.path === p)?.label ?? p).join(", ") : "없음"} · 비밀 파일 ${a.hideSecrets ? "가림" : "그대로"}` +
                      (after.length ? ` · 생성 뒤 실행 명령어 ${after.length}개(실행함 ${okCount}${failCount ? ` · 실패 ${failCount}` : ""})` : ""),
                  )}
                </View>
              );
            })}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {muted(`스킬·명령어 ${m.skills.length}`)}
              {m.skills.map((s) => chip(itemLabel(s), `k-${s}`))}
            </View>
            <JobLog theme={theme} job={jobs[m.id]} fontSize={fs(10)} />
          </View>
          );
        })}
      </View>

      {/* 팀원 추가 */}
      {!formOpen ? (
        <View style={{ flexDirection: "row" }}>{button("팀원 추가", () => setFormOpen(true), { tone: "accent" })}</View>
      ) : (
      <View style={box}>
        {title(editing ? `팀원 고치기 — ${editing}` : "팀원 추가")}
        {field(
          "아이디",
          <UiInput
            theme={theme}
            fontSize={fs(12)}
            value={id}
            onChangeText={setId}
            autoCapitalize="none"
            autoCorrect={false}
            // 서버에 만든 팀원은 아이디가 서버 계정·로그인 계정에 박혀 있어 바꾸지 않는다
            editable={!members.find((x) => x.id === editing && (x.applied.length > 0 || x.loginAdded))}
            style={{ width: FIELD_WIDTH }}
          />,
          "팀원이 로그인할 때 씁니다 — 영문 소문자로 시작, 영문 소문자·숫자·- 만. 서버에 만든 뒤에는 바꿀 수 없습니다",
        )}

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>1. 서버</Text>
          {muted("이 팀원이 들어갈 서버 — 여러 개 고를 수 있습니다. 팀원 프로젝트는 여기서 고른 서버에만 만들 수 있습니다")}
          {servers.length === 0 ? muted("서버 목록을 읽는 중이거나, 프로젝트가 있는 서버가 없습니다") : null}
          {servers.map((h) => check(`srv-${h}`, pickServers.has(h), h, () => toggleServer(h), index.byAlias.has(h) ? `리규형님 프로젝트 ${projectsOf(h).length}개 · Paseo 연결됨` : `리규형님 프로젝트 ${projectsOf(h).length}개 · Paseo 연결 안 됨`))}
        </View>

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>2. 스킬·명령어</Text>
          {muted("고른 서버에 있는 글로벌 스킬·명령어 중 이 팀원에게 줄 것 — 그 서버에서 팀원 홈(/home/<아이디>/.claude)으로 복사합니다. 팀원 Claude 에는 여기서 고른 것만 보입니다. Paseo·Claude 가 깐 스킬은 뺐습니다")}
          {pickServers.size === 0 ? muted("서버를 먼저 고르면 그 서버의 스킬·명령어가 나옵니다") : (
            <UiInput theme={theme} fontSize={fs(12)} value={skillFilter} onChangeText={setSkillFilter} placeholder="스킬·명령어 이름·설명으로 찾기" style={{ width: FIELD_WIDTH }} />
          )}
          {[...pickServers].map(serverSkills)}
        </View>

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>3. 권한</Text>
          {muted("서버마다 이 팀원이 무엇을 고치고 무엇에 닿을 수 있는지 — 팀원 프로젝트(\"팀원 프로젝트 관리\" 탭에서 넣음)는 안의 내용까지 리규형님처럼 읽히고(읽기만), \"풀권한 폴더\"에 적은 곳은 다 고칠 수 있고, \"계정파일만 폴더\"에는 새 파일을 만들고 자기가 만든 파일만 고칠 수 있습니다. 포트는 적은 것만 열립니다")}
          {pickServers.size === 0 ? muted("서버를 먼저 고르면 서버마다 정합니다") : null}
          {[...pickServers].map(serverAccess)}
        </View>

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>4. 로그인</Text>
          {muted("저장하면 로그인 서버에 팀원 계정을 만들고 초대 키를 냅니다(위에 상자로 나옵니다). 키를 팀원에게 전하면 팀원이 로그인 페이지의 \"초대 키로 처음 등록\"에서 비밀번호와 자기 폰 OTP 를 직접 정합니다(24시간 안에 한 번만).")}
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          {button(editing ? "고친 내용 저장" : "저장", () => void submit(), { tone: "accent" })}
          {button(editing ? "고치기 그만" : "닫기", () => {
            resetForm();
            setMessage(null);
            setFormOpen(false);
          })}
        </View>
      </View>
      )}
    </View>
  );
}
