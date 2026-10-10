import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { projectsHosts, type ProjectEntry } from "../shared/projects";
import { teamServerSkills, teamSkills } from "../shared/team";
import { scaled, useFontScale } from "./fontScale";
import { pinKey, type HostIndex, type ProjectsData } from "./projectsData";
import { setHoverTitle, setNoTranslate } from "./web";

// 팀원 관리 — 시험판(10-11 리규형님: "먼저 팀원관리 프로토타입을 제시하고, 내가 검토 후 수정").
// 팀원 = 회사 직원(외부인 아님). 팀원을 추가할 때 ① 서버(다중) ② 프로젝트(다중) ③ 그 직원에 맞는 글로벌 스킬·명령어를 고른다
// (명령어는 10-11 리규형님 "command 도 나와야 돼"). 스킬·명령어는 고른 서버마다 그 서버의 ~/.claude 에서 읽는다(리규형님 "서버 특화
// 스킬은 내가 추가하고 서버에서 직접 복사" · "서버 특화 커맨드가 있어") — PC 에 없는 것은 "이 서버에만". Paseo·Claude 가 깐 스킬은 뺀다.
// 고른 것은 "서버|skill:이름"·"서버|command:이름" 키로 — 서버가 달라도, 같은 이름이어도 안 섞이게.
// 10-11 리규형님 결정: 넣는 방법 = 복사 + "스킬 다시 맞추기" 단추(원본으로 다시 복사, 직원 쪽 수정은 덮어씀 — 읽기 전용 연결 안 고름) ·
// Claude 플러그인 칸은 지금 안 만든다(서버 세 플러그인 모두 리규형님 계정·세션에 묶여 있어 주면 울타리가 뚫림).
// 서버 후보 = ~/.ssh/config 의 Host 중 프로젝트 목록에 프로젝트가 있는 서버(GitHub 같은 항목은 프로젝트가 없어 저절로 빠진다).
// 지금은 화면 모양만 — 저장·초대 코드·서버 배치는 하지 않고, 넣은 팀원은 이 화면 메모리에만 있다(새로 고치면 사라짐).

type Member = { id: string; servers: string[]; projects: string[]; skills: string[] };
type Item = { kind: "skill" | "command"; name: string; description: string };
type Props = { theme: PluginTheme; data: ProjectsData | null; index: HostIndex };

export function TeamManage({ theme, data, index }: Props) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);
  const entries = data?.entries ?? [];
  const readHosts = useRpc(projectsHosts);
  const readSkills = useRpc(teamSkills);
  const readServerSkills = useRpc(teamServerSkills);

  const [hosts, setHosts] = useState<string[]>([]);
  // PC 목록 — "이 서버에만" 표시용 비교. 고르는 목록은 서버마다 SSH 로 읽는다(serverLists)
  const [skills, setSkills] = useState<Item[]>([]);
  const [serverLists, setServerLists] = useState<Record<string, { skills: Item[]; error: string | null } | "loading">>({});
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

  const [members, setMembers] = useState<Member[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

  const [id, setId] = useState("");
  const [pickServers, setPickServers] = useState<Set<string>>(new Set());
  const [pickProjects, setPickProjects] = useState<Set<string>>(new Set());
  const [pickSkills, setPickSkills] = useState<Set<string>>(new Set());
  const [skillFilter, setSkillFilter] = useState("");

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const byKey = useMemo(() => new Map(entries.map((e) => [pinKey(e), e] as const)), [entries]);
  const toggleServer = (h: string) => {
    const next = toggle(pickServers, h);
    setPickServers(next);
    // 서버를 빼면 그 서버 프로젝트·스킬·명령어 고른 것도 뺀다
    if (!next.has(h)) {
      setPickProjects(new Set([...pickProjects].filter((k) => byKey.get(k)?.host !== h)));
      setPickSkills(new Set([...pickSkills].filter((k) => !k.startsWith(`${h}|`))));
    }
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
    setPickProjects(new Set());
    setPickSkills(new Set());
    setEditing(null);
  };
  const submit = () => {
    const name = id.trim();
    if (!name) return setMessage({ text: "아이디를 넣어 주세요", bad: true });
    if (pickServers.size === 0) return setMessage({ text: "서버를 하나 이상 골라 주세요", bad: true });
    if (pickProjects.size === 0) return setMessage({ text: "프로젝트를 하나 이상 골라 주세요", bad: true });
    if (members.some((m) => m.id === name && m.id !== editing)) return setMessage({ text: "같은 아이디가 이미 있습니다", bad: true });
    const member: Member = { id: name, servers: [...pickServers], projects: [...pickProjects], skills: [...pickSkills] };
    setMembers(editing ? members.map((m) => (m.id === editing ? member : m)) : [...members, member]);
    setMessage({ text: editing ? "고쳤습니다(시험판 — 저장되지 않습니다)" : "시험판 목록에 넣었습니다(저장되지 않습니다)", bad: false });
    resetForm();
  };
  const startEdit = (m: Member) => {
    setEditing(m.id);
    setId(m.id);
    setPickServers(new Set(m.servers));
    setPickProjects(new Set(m.projects));
    setPickSkills(new Set(m.skills));
    setConfirmDelete(null);
    setMessage(null);
  };

  const input = { color: c.foreground, fontSize: fs(12), paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 } as const;
  const box = { gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 } as const;
  const title = (text: string) => <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foreground }}>{text}</Text>;
  const muted = (text: string) => <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{text}</Text>;
  const button = (label: string, onPress: () => void, opts: { tone?: "danger" | "accent"; hint?: string } = {}) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={opts.hint ?? label}
      ref={(node: unknown) => {
        if (opts.hint) setHoverTitle(node, opts.hint);
      }}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: opts.tone === "accent" ? c.accent : c.border,
        backgroundColor: hovered ? c.surface2 : "transparent",
      })}
    >
      <Text style={{ fontSize: fs(11), color: opts.tone === "danger" ? c.statusDanger : opts.tone === "accent" ? c.accent : c.foreground }}>{label}</Text>
    </Pressable>
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
          borderColor: on ? c.accent : c.foregroundMuted,
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
  const projectName = (k: string) => byKey.get(k)?.name ?? k;
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

  return (
    <View ref={setNoTranslate} style={{ gap: 14 }}>
      <View style={{ ...box, borderColor: c.accent }}>
        <Text style={{ fontSize: fs(12), color: c.accent, fontWeight: "600" }}>시험판입니다</Text>
        {muted("화면 모양을 보시고 고칠 점을 알려 주세요. 여기서 넣은 팀원은 저장되지 않고(새로 고치면 사라짐), 서버에는 아무것도 하지 않습니다.")}
      </View>
      {message ? <Text style={{ fontSize: fs(12), color: message.bad ? c.statusDanger : c.statusSuccess }}>{message.text}</Text> : null}

      {/* 팀원 목록 */}
      <View style={{ gap: 6 }}>
        {title(`팀원 ${members.length}`)}
        {members.length === 0 ? muted("아직 팀원이 없습니다. 아래에서 추가해 보세요.") : null}
        {members.map((m) => (
          <View key={m.id} style={{ gap: 6, paddingVertical: 8, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foreground }}>{m.id}</Text>
              {muted("초대 대기")}
              <View style={{ flex: 1 }} />
              {button("고치기", () => startEdit(m))}
              {m.skills.length > 0
                ? button(
                    "스킬 다시 맞추기",
                    () => setMessage({ text: `${m.id}: 시험판이라 하지 않았습니다 — 실제로는 서버 원본에서 스킬·명령어 ${m.skills.length}개를 다시 복사합니다`, bad: false }),
                    { hint: "서버 원본에서 고른 스킬·명령어를 다시 복사합니다(직원 쪽에서 고친 것은 덮어씁니다)" },
                  )
                : null}
              {confirmDelete === m.id
                ? [
                    button("정말 삭제", () => {
                      setMembers(members.filter((x) => x.id !== m.id));
                      setConfirmDelete(null);
                      if (editing === m.id) resetForm();
                    }, { tone: "danger" }),
                    button("취소", () => setConfirmDelete(null)),
                  ]
                : button("삭제", () => setConfirmDelete(m.id), { tone: "danger", hint: "실제라면 그 직원 로그인이 바로 끊기고, 팀 데몬 열쇠를 바꿉니다" })}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {muted("서버")}
              {m.servers.map((s) => chip(s, `s-${s}`))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {muted(`프로젝트 ${m.projects.length}`)}
              {m.projects.map((k) => chip(projectName(k), `p-${k}`))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {muted(`스킬·명령어 ${m.skills.length}`)}
              {m.skills.map((s) => chip(itemLabel(s), `k-${s}`))}
            </View>
          </View>
        ))}
      </View>

      {/* 팀원 추가 */}
      <View style={box}>
        {title(editing ? `팀원 고치기 — ${editing}` : "팀원 추가")}
        <TextInput value={id} onChangeText={setId} placeholder="아이디 (팀원이 로그인할 때 씀)" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={input} />

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>1. 서버</Text>
          {muted("이 직원이 들어갈 서버 — 여러 개 고를 수 있습니다")}
          {servers.length === 0 ? muted("서버 목록을 읽는 중이거나, 프로젝트가 있는 서버가 없습니다") : null}
          {servers.map((h) => check(`srv-${h}`, pickServers.has(h), h, () => toggleServer(h), index.byAlias.has(h) ? `프로젝트 ${projectsOf(h).length}개 · Paseo 연결됨` : `프로젝트 ${projectsOf(h).length}개 · Paseo 연결 안 됨`))}
        </View>

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>2. 프로젝트</Text>
          {muted("고른 서버의 프로젝트 — 여러 개 고를 수 있습니다")}
          {pickServers.size === 0 ? muted("서버를 먼저 고르면 그 서버의 프로젝트가 나옵니다") : null}
          {[...pickServers].map((h) => {
            const list = projectsOf(h);
            const allOn = list.length > 0 && list.every((e) => pickProjects.has(pinKey(e)));
            return (
              <View key={`pg-${h}`} style={{ gap: 2, paddingLeft: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{h}</Text>
                  {button(allOn ? "모두 빼기" : "모두 고르기", () => {
                    const next = new Set(pickProjects);
                    for (const e of list) {
                      if (allOn) next.delete(pinKey(e));
                      else next.add(pinKey(e));
                    }
                    setPickProjects(next);
                  })}
                </View>
                {list.map((e: ProjectEntry) =>
                  check(`prj-${pinKey(e)}`, pickProjects.has(pinKey(e)), e.enabled ? e.name : `${e.name} (꺼짐)`, () => setPickProjects(toggle(pickProjects, pinKey(e))), `${e.category || "카테고리 없음"} · ${e.path}`),
                )}
              </View>
            );
          })}
        </View>

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>3. 스킬·명령어</Text>
          {muted("고른 서버에 있는 글로벌 스킬·명령어 중 이 직원에게 줄 것 — 그 서버에서 고른 프로젝트의 프로젝트 스킬·명령어로 복사합니다. 팀 쪽 Claude 에는 여기서 고른 것만 보입니다. Paseo·Claude 가 깐 스킬은 뺐습니다")}
          {pickServers.size === 0 ? muted("서버를 먼저 고르면 그 서버의 스킬·명령어가 나옵니다") : (
            <TextInput value={skillFilter} onChangeText={setSkillFilter} placeholder="스킬·명령어 이름·설명으로 찾기" placeholderTextColor={c.foregroundMuted} style={input} />
          )}
          {[...pickServers].map(serverSkills)}
        </View>

        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>4. 로그인</Text>
          {muted("실제로는 추가하면 일회용 초대 코드(24시간)가 나오고, 직원이 그 코드로 들어와 자기 비밀번호와 OTP 를 등록합니다. 시험판에서는 만들지 않습니다.")}
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          {button(editing ? "고친 내용 넣기 (시험)" : "팀원 추가 (시험)", submit, { tone: "accent" })}
          {editing ? button("고치기 그만", resetForm) : null}
        </View>
      </View>

      {/* 실제로 일어날 일 */}
      <View style={box}>
        {title("실제로 추가하면 일어나는 일")}
        {muted("· 고른 서버마다 고른 프로젝트를 팀용 사본으로 복사합니다. 운영 폴더는 그대로 두고 열어 주지 않습니다(운영 앱이 root 로 그 폴더에서 돕니다).")}
        {muted("· 그 사본에 고른 스킬·명령어를 그 서버에서 바로 복사해 넣습니다(git 제외 목록에도 넣어 직원 커밋에 딸려 가지 않게).")}
        {muted("· 리규형님이 원본을 고쳐도 직원 쪽 복사본은 그대로입니다 — 팀원 줄의 \"스킬 다시 맞추기\"를 누르면 원본으로 다시 복사합니다(직원 쪽에서 고친 것은 덮어씀).")}
        {muted("· 고르지 않은 글로벌 스킬·명령어, Claude 플러그인(Codex 상담·세션끼리 주고받기·브라우저 확인), 리규형님 지시·메모리는 팀 쪽에 가지 않습니다.")}
        {muted("· 그 서버의 팀 데몬(울타리 안에서 도는 팀용 Paseo)에 프로젝트를 등록합니다.")}
        {muted("· 로그인 서버에 직원 계정과 \"이 서버들만\"을 저장하고, 초대 코드를 직원에게 전합니다. 직원이 로그인하면 고른 서버만 보입니다.")}
        {muted("· 같은 서버를 받은 직원끼리 고른 프로젝트·스킬·명령어가 다르면, 그 서버에 팀용 Paseo 를 하나 더 띄워 서로 안 보이게 합니다(하나당 메모리 110~140MB).")}
      </View>
    </View>
  );
}
