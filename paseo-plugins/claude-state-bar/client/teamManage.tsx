import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { projectsHosts } from "../shared/projects";
import {
  teamCategoryOrder,
  teamJobStart,
  teamJobWait,
  teamMemberClaude,
  teamMemberRemove,
  teamMemberSave,
  teamProjectAccess,
  teamProjectEdit,
  teamServerSkills,
  teamSkills,
  teamState,
  type TeamJobAction,
  type TeamMember,
  type TeamProject,
} from "../shared/team";
import { CALL_NAME_MAX, callNameProblem, isTeamStandard } from "../shared/teamStandard";
import { scaled, useFontScale } from "./fontScale";
import { type HostIndex, type ProjectsData } from "./projectsData";
import { ProjectsEditor, type EditScope } from "./projectsManage";
import { accessNote, TeamAccessPanel } from "./teamAccessPanel";
import { FIELD_WIDTH, lineColor, UiButton, UiInput } from "./ui";
import { copyText, setNoTranslate } from "./web";

// 팀원 관리(10-11 리규형님: "먼저 팀원관리 프로토타입을 제시하고, 내가 검토 후 수정") → 10-20 리규형님 "싹 갈아엎고 새로":
// 팀원 = 회사 팀원(외부인 아님). 팀원을 추가할 때는 아이디와 그 팀원에 맞는 글로벌 스킬·명령어만 고른다(서버 고르기·서버별 권한·
// 생성 뒤 실행 명령 칸은 없앴다). 스킬·명령어는 업무 서버마다 그 서버의 ~/.claude 에서 읽는다(리규형님 "서버 특화 커맨드가 있어") —
// PC 에 없는 것은 "이 서버에만". Paseo·Claude 가 깐 스킬은 뺀다. 고른 것은 "서버|skill:이름"·"서버|command:이름" 키로.
// 10-11 리규형님 결정: 넣는 방법 = 복사 + "스킬 다시 맞추기" 단추(원본으로 다시 복사, 팀원 쪽 수정은 덮어씀) ·
// 10-21 리규형님: 다시 맞추기도 팀원판 목록(서버 /etc/paseo-team/<아이디>/member-copies.json)에 적힌 것은 건너뛴다 ·
// Claude 플러그인 칸은 만들지 않는다(서버 세 플러그인 모두 리규형님 계정·세션에 묶여 있어 주면 울타리가 뚫림).
// 업무 서버 = ~/.ssh/config 의 Host 중 리규형님 프로젝트 목록에 프로젝트가 있는 서버(GitHub 같은 항목은 저절로 빠진다).
// 팀원 프로젝트는 리규형님 목록과 따로(팀원 → 그 팀원의 카테고리 → 프로젝트) — 리규형님만 넣고 고친다. 권한은 그 줄의 "권한" 단추로
// 프로젝트마다 준다(읽기만·읽기쓰기·내가 쓴 파일만 · 밖 경로 두 칸 · DB 접속 · 서버 기록 · 비밀 가리기 — shared/teamAccess.ts).
// 서버는 따로 고르지 않는다 — 팀원 프로젝트가 있는 서버에만 그 팀원 Paseo 를 만들고(server/teamApply), 마지막 프로젝트를 빼면 지운다(홈 유지).
// 10-11 저녁 리규형님: "서버에 반영" 단추는 없앤다 — 저장·프로젝트 고치기가 곧 반영(실패했을 때만 "다시 시도") ·
// 비밀번호·OTP 는 초대 키(일회용·24시간)로 팀원이 로그인 페이지에서 직접 · 삭제는 "완전 삭제"·"홈 디렉터리 유지" 중 고른다.

type Item = { kind: "skill" | "command"; name: string; description: string };
type Props = { theme: PluginTheme; data: ProjectsData | null; index: HostIndex };
/** 서버 작업 진행 — 팀원마다 하나. run = 시작 순번(새 작업이면 진행 상자를 다시 펼친다) */
type JobView = { run: number; lines: string[]; done: boolean; ok: boolean };
type RunJob = (member: string, action: TeamJobAction, onDone?: (ok: boolean, lines: string[]) => void) => void;
/** 화면에 한 번 보여 주는 초대 키 — 저장하지 않는다(화면을 떠나거나 닫으면 사라진다) */
type InviteView = { member: string; key: string; expiresAt: number; link: string };
/** 서버 한 대에서 읽은 스킬·명령어와 기록 목록(두 탭이 같이 쓴다) */
type ServerList = { skills: Item[]; logs?: string[]; error: string | null } | "loading";

/** 서버 반영 상태 한 줄 — 팀원 프로젝트가 없으면 서버에 만들 것이 없다(경고 아님) */
function serverState(m: TeamMember): { text: string; warn: boolean } {
  if (!m.servers.length && !m.applied.length) return { text: "팀원 프로젝트 없음 — 넣으면 그 서버에 만들어집니다", warn: false };
  if (!m.applied.length) return { text: "서버에 아직 없음", warn: true };
  if (m.dirty) return { text: `반영이 끝나지 않음 · ${m.applied.join(", ")}`, warn: true };
  return { text: `서버 반영됨 · ${m.applied.join(", ")}`, warn: false };
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

  // 업무 서버 — ~/.ssh/config 의 Host 중 리규형님 프로젝트가 있는 서버(팀원 추가의 스킬 묶음·팀원 프로젝트의 디바이스)
  const readHosts = useRpc(projectsHosts);
  const [hosts, setHosts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void readHosts({})
      .then((r) => alive && setHosts(r.hosts))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [readHosts]);
  const entries = data?.entries ?? [];
  const servers = useMemo(() => hosts.filter((h) => h !== "PC" && entries.some((e) => e.host === h)), [hosts, entries]);

  // 서버마다 스킬·명령어·기록 목록 — 처음 필요할 때 한 번 SSH 로 읽는다(오류면 "다시 읽기")
  const readServerSkills = useRpc(teamServerSkills);
  const [serverLists, setServerLists] = useState<Record<string, ServerList>>({});
  const asked = useRef(new Set<string>());
  const loadServer = useCallback(
    (h: string, again = false) => {
      if (asked.current.has(h) && !again) return;
      asked.current.add(h);
      setServerLists((cur) => ({ ...cur, [h]: "loading" }));
      readServerSkills({ host: h })
        .then((r) => setServerLists((cur) => ({ ...cur, [h]: r })))
        .catch((err) => setServerLists((cur) => ({ ...cur, [h]: { skills: [], error: `읽지 못했습니다 — ${String(err instanceof Error ? err.message : err)}` } })));
    },
    [readServerSkills],
  );

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
            <Text style={{ flex: 1, fontSize: fs(12), color: c.accent, fontWeight: "600" }}>팀원은 아이디·스킬만, 권한은 팀원 프로젝트마다</Text>
            <Pressable accessibilityRole="button" onPress={() => setGuideOpen(false)}>
              <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>접기 ▴</Text>
            </Pressable>
          </View>
          {muted("· \"팀원 추가\"에서는 아이디와 그 팀원에게 줄 스킬·명령어만 고릅니다. 서버는 고르지 않습니다.")}
          {muted("· \"팀원 프로젝트 관리\"에서 리규형님이 그 팀원의 프로젝트를 넣으면, 그 프로젝트가 있는 서버에 팀원 전용 Paseo(울타리 안에서 도는 팀원용 Paseo, 하나당 메모리 110~140MB)가 만들어집니다. 처음이면 초대 키가 나옵니다. 그 서버의 마지막 프로젝트를 빼면 그 서버의 팀원 Paseo 를 지웁니다(홈은 남김).")}
          {muted("· 권한은 프로젝트 줄의 \"권한\" 단추로 프로젝트마다 줍니다 — 읽기만 · 읽기쓰기(모든 권한) · 내가 쓴 파일만 쓰기, 프로젝트 밖 경로 두 칸, DB 접속, 서버 기록, 비밀 파일 가리기. 새로 넣은 프로젝트는 읽기만입니다.")}
          {muted("· 저장하거나 고치는 순간 그 팀원의 서버에 반영됩니다. 반영하는 동안 그 팀원의 Paseo 가 잠깐 다시 시작됩니다. 실패했을 때만 \"다시 시도\"가 나옵니다.")}
          {muted("· 팀원 홈은 /home/<아이디> 한 곳입니다. 고른 스킬·명령어를 그 안 .claude 로 넣습니다. 나중에 고른 목록을 바꿔도 팀원 홈에 이미 있는 것은 덮어쓰지 않고, 새로 고른 것만 넣고 뺀 것은 치웁니다(서버 백업으로). 원본으로 다시 덮어쓰려면 \"스킬 다시 맞추기\"를 누릅니다. 그때도 그 팀원에 맞춰 고쳐 둔 팀원판(서버의 팀원판 목록에 적힌 것 — 팀원을 부르는 이름·기록 폴더를 바꾼 규칙·시작·마무리 같은 것)은 건너뛰고, 건너뛴 이름을 결과에 보여 줍니다. 팀원은 프로젝트를 고칠 수 없고 보기만 합니다.")}
          {muted("· 대화 규칙·시작·마무리·압축 준비는 고르지 않습니다 — 팀원 표준판(리규형님 개인 사정을 걷어낸 판, 팀원을 \"부를 이름\"으로 부름)을 서버에 반영할 때 팀원 홈에 없으면 넣고, 있으면 그대로 둡니다. 시작·마무리는 팀원 자기 기록(홈의 작업기록)만 읽고 씁니다.")}
          {muted("· 팀원 Claude 는 자기 홈의 스킬·명령어·지침만 읽습니다. 넘겨받은 프로젝트 폴더 안에 있는 스킬·명령어·지침(CLAUDE.md)·설정은 읽지 않습니다.")}
          {muted("· 삭제할 때는 \"완전 삭제\"(홈까지 모두)와 \"홈 디렉터리 유지\" 중 고릅니다. 어느 쪽이든 같은 아이디로 다시 만들 수 있습니다.")}
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setGuideOpen(true)}>
          <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>팀원 관리는 어떻게 되나요 ▸</Text>
        </Pressable>
      )}
      {invites.map((inv) => (
        <InviteBox key={inv.member} theme={theme} invite={inv} fontSize={fs(11)} onClose={() => setInvites((cur) => cur.filter((x) => x.member !== inv.member))} />
      ))}
      {loadError ? <Text style={{ fontSize: fs(12), color: c.statusDanger }}>{loadError}</Text> : null}
      {members === null ? (
        loadError ? null : muted("팀원 목록을 읽는 중…")
      ) : sub === "members" ? (
        <MemberAdd theme={theme} members={members} onMembers={setMembers} jobs={jobs} runJob={runJob} servers={servers} serverLists={serverLists} loadServer={loadServer} index={index} entries={entries} />
      ) : (
        <TeamProjects
          theme={theme}
          members={members}
          onMembers={setMembers}
          onAddMember={() => setSub("members")}
          jobs={jobs}
          runJob={runJob}
          requestApply={requestApply}
          servers={servers}
          serverLists={serverLists}
          loadServer={loadServer}
        />
      )}
    </View>
  );
}

// 팀원 프로젝트 관리 — 프로젝트 관리 탭과 같은 편집기를 팀원마다(1단계 = 팀원, 2단계 = 그 팀원의 카테고리) + 줄마다 "권한"(10-20)
function TeamProjects({
  theme,
  members,
  onMembers,
  onAddMember,
  jobs,
  runJob,
  requestApply,
  servers,
  serverLists,
  loadServer,
}: {
  theme: PluginTheme;
  members: TeamMember[];
  onMembers: (m: TeamMember[]) => void;
  onAddMember: () => void;
  jobs: Record<string, JobView>;
  runJob: RunJob;
  requestApply: (member: string, onFail?: (lines: string[]) => void) => void;
  servers: string[];
  serverLists: Record<string, ServerList>;
  loadServer: (h: string) => void;
}) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);
  const editProject = useRpc(teamProjectEdit);
  const writeOrder = useRpc(teamCategoryOrder);
  const writeAccess = useRpc(teamProjectAccess);
  const [notice, setNotice] = useState<string | null>(null);
  // 팀원 머리마다 서버 반영 상태 — 고치면 바로 반영하고(반영할 때마다 그 팀원 Paseo 가 잠깐 다시 시작), 실패했을 때만 "다시 시도"
  const scopes = useMemo<EditScope[]>(
    () =>
      members.map((m) => {
        const state = serverState(m);
        const running = !!jobs[m.id] && !jobs[m.id].done;
        const logsOf = (h: string) => {
          const got = serverLists[h];
          return got && got !== "loading" ? (got.error ? [] : (got.logs ?? [])) : null;
        };
        return {
          id: m.id,
          title: m.id,
          entries: m.projects,
          categoryOrder: m.categoryOrder,
          // 새 프로젝트를 둘 서버 — 팀원 추가 때 고르지 않으므로 업무 서버 전부(10-20). 머리에는 팀원 프로젝트가 있는 서버만
          hosts: servers,
          shownHosts: m.servers,
          extra: (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: scaled(13, scale), color: running ? c.foregroundMuted : state.warn ? c.statusWarning : c.statusSuccess }}>
                {running ? "서버에 반영하는 중…" : state.text}
              </Text>
              {!running && state.warn ? (
                <UiButton theme={theme} label="다시 시도" tone="accent" fontSize={scaled(14, scale)} hint="이 팀원의 프로젝트·권한·스킬을 그 서버에 다시 반영합니다(그 팀원 Paseo 가 잠깐 다시 시작)" onPress={() => runJob(m.id, "apply")} />
              ) : null}
            </View>
          ),
          below: <JobLog theme={theme} job={jobs[m.id]} fontSize={scaled(13, scale)} />,
          // 기본 프로젝트 = 팀원 프로젝트가 있는 서버마다 팀원 홈(서버 팀원 도구가 팀원 목록 맨 위에 넣는다 — 10-11 리규형님 "삭제 불가, 항상 최상위") ·
          // 카테고리 "홈" 아래 이름은 계정 아이디(리규형님 "홈 > {계정ID}")
          pinned: m.servers.map((host) => ({ name: m.id, host, path: `/home/${m.id}`, category: "홈" })),
          rowNote: (e) => accessNote(e as TeamProject),
          rowPanel: (e, close) => (
            <TeamAccessPanel
              theme={theme}
              project={e as TeamProject}
              serverLogs={logsOf(e.host)}
              fontSize={fs}
              onOpen={() => loadServer(e.host)}
              onSave={async (access) => {
                setNotice(null);
                const r = await writeAccess({ member: m.id, key: `${e.host}|${e.path}`, access });
                onMembers(r.members);
                if (r.ok) requestApply(m.id);
                return r;
              }}
              onClose={close}
            />
          ),
        };
      }),
    [members, jobs, theme, scale, servers, serverLists],
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
            const why = [...lines].reverse().find((l) => / 실패|못했습니다|거절|위험|겹쳐/.test(l)) ?? "서버 반영 실패";
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
      intro={"팀원마다 따로 두는 프로젝트입니다. 리규형님만 넣고 고칠 수 있고, 팀원은 보기만 합니다. 리규형님 프로젝트 목록과 섞이지 않고 팀원 → 그 팀원의 카테고리 → 프로젝트로 묶입니다. 줄의 \"권한\"으로 프로젝트마다 할 수 있는 것을 정합니다(새로 넣으면 읽기만). 고치면 그 팀원의 서버에 바로 반영됩니다(그 팀원 Paseo 가 잠깐 다시 시작). 서버 폴더 자체는 건드리지 않습니다."}
      emptyText="아직 팀원 프로젝트가 없습니다"
      pathHint={() => "예: /home/yeogi_callcrew — 그 서버의 폴더 경로, / 로 시작합니다"}
    />
  );
}

function MemberAdd({
  theme,
  members,
  onMembers,
  jobs,
  runJob,
  servers,
  serverLists,
  loadServer,
  index,
  entries,
}: {
  theme: PluginTheme;
  members: TeamMember[];
  onMembers: (m: TeamMember[]) => void;
  jobs: Record<string, JobView>;
  runJob: RunJob;
  servers: string[];
  serverLists: Record<string, ServerList>;
  loadServer: (h: string, again?: boolean) => void;
  index: HostIndex;
  entries: ProjectsData["entries"];
}) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);
  const readSkills = useRpc(teamSkills);
  const saveMember = useRpc(teamMemberSave);
  const removeMember = useRpc(teamMemberRemove);
  const writeClaude = useRpc(teamMemberClaude);

  // PC 목록 — "이 서버에만" 표시용 비교. 고르는 목록은 서버마다 SSH 로 읽는다(serverLists)
  const [skills, setSkills] = useState<Item[]>([]);
  useEffect(() => {
    let alive = true;
    void readSkills({})
      .then((r) => alive && setSkills(r.skills))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [readSkills]);

  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // 팀원 추가 칸 — 팀원이 없을 때만 펼쳐 두고, 저장하면 접는다(10-11 리규형님 "추가할 때도 마찬가지")
  const [formOpen, setFormOpen] = useState(members.length === 0);
  // 팀원 줄은 평소 접어 두고 이름을 누르면 서버·권한·스킬 줄을 펼친다(10-12 리규형님: 팀원이 10명이면 다 펼쳐진 게 어지럽다).
  // 단추 줄과 서버 작업 진행은 접혀 있어도 보인다
  const [openMembers, setOpenMembers] = useState<ReadonlySet<string>>(() => new Set());
  const toggleMember = (mid: string) =>
    setOpenMembers((prev) => {
      const next = new Set(prev);
      if (!next.delete(mid)) next.add(mid);
      return next;
    });

  const [id, setId] = useState("");
  // 부를 이름(10-21 팀원 표준판) — 비우면 아이디 + "님"
  const [callName, setCallName] = useState("");
  const [pickSkills, setPickSkills] = useState<Set<string>>(new Set());
  const [skillFilter, setSkillFilter] = useState("");
  // 칸을 열면 업무 서버마다 스킬·명령어를 한 번 읽는다(서버는 고르지 않는다 — 10-20)
  useEffect(() => {
    if (formOpen) for (const h of servers) loadServer(h);
  }, [formOpen, servers, loadServer]);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const pcKeys = useMemo(() => new Set(skills.map((s) => `${s.kind}:${s.name}`)), [skills]);
  const matches = (s: Item) => {
    const q = skillFilter.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  };

  const resetForm = () => {
    setId("");
    setCallName("");
    setPickSkills(new Set());
    setEditing(null);
  };
  const submit = async () => {
    const name = id.trim();
    if (!name) return setMessage({ text: "아이디를 넣어 주세요", bad: true });
    const call = callName.trim();
    const callError = callNameProblem(call);
    if (callError) return setMessage({ text: callError, bad: true });
    setBusy(true);
    setMessage(null);
    try {
      const r = await saveMember({ previousId: editing, id: name, skills: [...pickSkills], callName: call });
      onMembers(r.members);
      if (!r.ok) return setMessage({ text: r.error ?? "저장하지 못했습니다", bad: true });
      resetForm();
      setFormOpen(false);
      // 서버에 이미 있는 팀원이면 스킬을 바로 반영 · 새 팀원은 팀원 프로젝트를 넣을 때 그 서버에 만들어진다
      const saved = r.members.find((m) => m.id === name);
      if (saved && (saved.servers.length || saved.applied.length)) runJob(name, "apply");
      else setMessage({ text: `${name} 를 저장했습니다 — "팀원 프로젝트 관리" 탭에서 프로젝트를 넣으면 그 서버에 만들어지고 초대 키가 나옵니다`, bad: false });
    } catch (err) {
      setMessage({ text: `저장하지 못했습니다: ${String(err instanceof Error ? err.message : err)}`, bad: true });
    } finally {
      setBusy(false);
    }
  };
  // 팀원 Claude 계정(10-21) — 저장만 한다. 반영은 그 팀원 Paseo 를 다시 켜므로(쓰는 중이면 답이 끊김) 권한 칸처럼 따로 누른다
  const setClaude = async (memberId: string, own: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await writeClaude({ member: memberId, own });
      onMembers(r.members);
      if (!r.ok) setMessage({ text: r.error ?? "저장하지 못했습니다", bad: true });
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
    setCallName(m.callName);
    setPickSkills(new Set(m.skills));
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
    // 표준판 이름(규칙·시작·마무리·압축 준비)은 고르지 않는다 — 서버 팀원 도구가 표준판을 넣는다(10-21)
    const all = list.filter((s) => s.kind === kind && !isTeamStandard(s.kind, s.name));
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
    const projectCount = entries.filter((e) => e.host === h).length;
    return (
      <View key={`sk-${h}`} style={{ gap: 2, paddingLeft: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>{h}</Text>
          {muted(`리규형님 프로젝트 ${projectCount}개 · Paseo ${index.byAlias.has(h) ? "연결됨" : "연결 안 됨"}`)}
          {got === "loading" || !got ? muted("서버에서 읽는 중…") : got.error ? button("다시 읽기", () => loadServer(h, true)) : null}
        </View>
        {got && got !== "loading" && got.error ? <Text style={{ fontSize: fs(11), color: c.statusDanger }}>{got.error}</Text> : null}
        {got && got !== "loading" && !got.error ? [skillGroup(h, got.skills, "skill", "스킬"), skillGroup(h, got.skills, "command", "명령어")] : null}
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
          const open = openMembers.has(m.id);
          return (
            <View key={m.id} style={{ gap: 6, paddingVertical: 8, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${m.id} 자세히 ${open ? "접기" : "보기"}`}
                  onPress={() => toggleMember(m.id)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Icon name={open ? "ChevronDown" : "ChevronRight"} size={fs(14)} color={c.foregroundMuted} />
                  <Text style={{ fontSize: fs(16), fontWeight: "700", color: c.foreground }}>{m.id}</Text>
                  <Text style={{ fontSize: fs(11), color: state.warn ? c.statusWarning : c.statusSuccess }}>{state.text}</Text>
                </Pressable>
                <View style={{ flex: 1 }} />
                {!running && state.warn
                  ? button("다시 시도", () => runJob(m.id, "apply"), { tone: "accent", hint: "이 팀원의 프로젝트·권한·스킬을 그 서버에 다시 반영합니다(그 팀원 Paseo 가 잠깐 다시 시작)" })
                  : null}
                {button("고치기", () => startEdit(m), { disabled: running, hint: "아이디·스킬·명령어를 고칩니다(권한은 \"팀원 프로젝트 관리\" 탭의 프로젝트 줄에서)" })}
                {m.loginAdded
                  ? button("초대 키 다시 발급", () => runJob(m.id, "invite"), {
                      disabled: running,
                      hint: "등록을 아직 안 마친 팀원에게 새 초대 키를 냅니다(전 키는 못 쓰게 됩니다). 이미 등록을 마친 팀원이면 서버가 거절합니다",
                    })
                  : null}
                {/* 등록 초기화(10-12 리규형님 — 인계·폰 바꿈): 삭제처럼 한 번 더 눌러 확인 */}
                {m.loginAdded
                  ? confirmReset === m.id
                    ? [
                        button("정말 초기화", () => {
                          setConfirmReset(null);
                          runJob(m.id, "reset");
                        }, { tone: "danger", hint: "비밀번호·인증 앱 등록을 지우고 새 초대 키를 냅니다. 지금 로그인은 끊깁니다" }),
                        button("취소", () => setConfirmReset(null)),
                      ]
                    : button("등록 초기화", () => setConfirmReset(m.id), {
                        disabled: running,
                        hint: "이 팀원의 비밀번호·인증 앱 등록을 지우고 새 초대 키를 냅니다 — 팀원이 처음 등록처럼 다시 정합니다(서버 계정·프로젝트·기록은 그대로)",
                      })
                  : null}
                {m.applied.length > 0 && m.skills.length > 0
                  ? button("스킬 다시 맞추기", () => runJob(m.id, "skills"), {
                      disabled: running,
                      hint: "서버 원본에서 고른 스킬·명령어를 다시 복사합니다. 팀원판으로 적어 둔 것은 건너뛰고, 나머지 중 팀원 쪽에서 고친 것은 서버 백업으로 옮기고 덮어씁니다",
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
              {open ? (
                <>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    {muted("서버(팀원 프로젝트에서 정해짐)")}
                    {m.servers.length ? m.servers.map((s) => chip(s, `s-${s}`)) : muted("없음")}
                  </View>
                  {muted(`팀원 프로젝트 ${m.projects.length}`)}
                  {m.projects.map((p) => (
                    <View key={`p-${p.host}|${p.path}`} style={{ paddingLeft: 8 }}>
                      {muted(`${p.name}${p.enabled ? "" : "(숨김)"} — ${p.host}:${p.path} · ${accessNote(p)}`)}
                    </View>
                  ))}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    {muted(`스킬·명령어 ${m.skills.length}`)}
                    {m.skills.map((s) => chip(itemLabel(s), `k-${s}`))}
                  </View>
                  {/* 팀원 Claude 계정(10-21 리규형님) — 고른 쪽만 강조 */}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    {muted("Claude 계정")}
                    {button("회사 공용", () => void setClaude(m.id, false), {
                      ...(m.ownClaude ? {} : { tone: "accent" as const }),
                      disabled: running || busy,
                      hint: "서버 리규형님 Paseo 의 회사 팀 Claude 를 같이 씁니다(한도도 같이 깎입니다)",
                    })}
                    {button("본인 로그인", () => void setClaude(m.id, true), {
                      ...(m.ownClaude ? { tone: "accent" as const } : {}),
                      disabled: running || busy,
                      hint: "팀원이 자기 Claude 계정으로 씁니다 — 팀원 화면 설정의 Claude 로그인 칸에서 서버마다 한 번씩 로그인합니다",
                    })}
                  </View>
                  {muted(
                    m.ownClaude
                      ? "본인 로그인 — 팀원이 자기 화면 설정의 Claude 로그인 칸에서 서버마다 로그인합니다. 로그인 전이나 로그인이 풀렸을 때 회사 공용으로 대신 돌리지 않고, 다시 로그인할 때까지 멈춥니다"
                      : "회사 공용 — 서버 리규형님 Paseo 의 회사 팀 Claude 를 같이 씁니다(한도도 같이 깎입니다)",
                  )}
                  {muted("바꾸면 이름 옆 \"다시 시도\"로 서버에 반영해야 먹습니다 — 그 팀원 Paseo 가 다시 켜져, 쓰는 중이면 답이 끊깁니다")}
                </>
              ) : null}
              <JobLog theme={theme} job={jobs[m.id]} fontSize={fs(10)} />
            </View>
          );
        })}
      </View>

      {/* 팀원 추가 */}
      {!formOpen ? (
        <View style={{ flexDirection: "row" }}>
          <UiButton theme={theme} label="팀원 추가" fontSize={fs(11)} tone="accent" disabled={busy} onPress={() => setFormOpen(true)}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="UserPlus" size={fs(12)} color={c.accent} />
              <Text style={{ fontSize: fs(11), color: c.accent }}>팀원 추가</Text>
            </View>
          </UiButton>
        </View>
      ) : (
        <View style={box}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={editing ? "UserCog" : "UserPlus"} size={fs(14)} color={c.accent} />
            {title(editing ? `팀원 고치기 — ${editing}` : "팀원 추가")}
          </View>
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
          {field(
            "부를 이름",
            <UiInput
              theme={theme}
              fontSize={fs(12)}
              value={callName}
              onChangeText={setCallName}
              placeholder={`${id.trim() || "아이디"}님`}
              maxLength={CALL_NAME_MAX}
              autoCorrect={false}
              style={{ width: FIELD_WIDTH }}
            />,
            `팀원 Claude 가 대화에서 팀원을 이렇게 부릅니다(예: 대표님, 홍길동님). 비우면 아이디 뒤에 "님"을 붙입니다. 표준판을 팀원 홈에 처음 넣을 때 들어가고, 이미 넣은 뒤에 바꾸면 그 서버 팀원 홈에는 반영되지 않습니다`,
          )}

          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>1. 스킬·명령어</Text>
            {muted("업무 서버마다 그 서버의 글로벌 스킬·명령어 중 이 팀원에게 줄 것 — 그 서버에 팀원 프로젝트가 생기면 그 서버에서 팀원 홈(/home/<아이디>/.claude)으로 복사합니다. 팀원 Claude 에는 여기서 고른 것만 보입니다(넘겨받은 프로젝트 안의 스킬·명령어는 안 보임). 나중에 목록을 바꿔도 팀원 홈에 이미 있는 것은 그대로 둡니다. Paseo·Claude 가 깐 스킬은 뺐습니다")}
            {muted("표준판으로 자동: 대화 규칙(korean-rule)·시작(/start)·마무리(/finish)·압축 준비(start_compact)와 글로 묻고 끝내기 막기·진행 알림 감시 — 서버에 반영할 때 팀원 홈에 없으면 넣고, 있으면 그대로 둡니다. 리규형님판 같은 이름은 고르기 목록에서 뺐습니다")}
            {servers.length === 0 ? muted("서버 목록을 읽는 중이거나, 리규형님 프로젝트가 있는 서버가 없습니다") : (
              <UiInput theme={theme} fontSize={fs(12)} value={skillFilter} onChangeText={setSkillFilter} placeholder="스킬·명령어 이름·설명으로 찾기" style={{ width: FIELD_WIDTH }} />
            )}
            {servers.map(serverSkills)}
          </View>

          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>2. 프로젝트·권한·로그인</Text>
            {muted("저장한 뒤 \"팀원 프로젝트 관리\" 탭에서 이 팀원의 프로젝트를 넣고, 줄의 \"권한\"으로 프로젝트마다 할 수 있는 것을 정합니다. 처음 프로젝트를 넣으면 그 서버에 팀원 Paseo 와 로그인 계정이 만들어지고 초대 키가 나옵니다(위에 상자로). 키를 팀원에게 전하면 팀원이 로그인 페이지의 \"초대 키로 처음 등록\"에서 비밀번호와 자기 폰 OTP 를 직접 정합니다(24시간 안에 한 번만).")}
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
