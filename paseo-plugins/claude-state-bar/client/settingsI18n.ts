import type { ExtImportField } from "../shared/extSettings";
import type { SoundKind } from "../shared/sound";
import { uiLanguage } from "./appLanguage";
import type { FeatureId, HealthReason, HealthState } from "./health";

// Claude State Bar 설정 화면 글자 사전(리규형님 10-08 결정: 한글·영어 두 벌, 언어는 Paseo 언어 설정을 따라간다 — client/appLanguage).
// settingsScreen · versionStatus · webLoginSection 에 보이는 글자(제목·설명·버튼·알림·오류·읽어 주기 이름)를 모두 여기 둔다.
// 한국어는 옮기기 전 문구 그대로다. 영어 사전은 한국어 사전과 같은 모양이어야 해서(typeof ko) 빠진 칸이 있으면 타입 검사가 잡는다.
// 서버가 보낸 문구(로그인 서버의 message·스키마 검사 오류 글)는 그대로 보인다.

const ko = {
  // ── 설정 화면 공통
  loading: "동기화·소리 설정을 읽는 중입니다",
  readFailed: (error: string) => `설정을 읽지 못했습니다: ${error}`,
  invalidStored: (error: string) => `저장된 설정이 올바르지 않습니다: ${error}`,
  checkValue: (path: string, message: string) => `값을 확인해 주세요 (${path}): ${message}`,
  warningBelowDanger: "경고 기준은 위험 기준보다 낮아야 합니다",
  saved: "저장했습니다",
  saveFailed: (error: string) => `저장하지 못했습니다: ${error}`,
  resetDone: "기본값으로 되돌렸습니다",
  resetFailed: (error: string) => `되돌리지 못했습니다: ${error}`,
  save: "저장",
  saving: "저장 중",
  resetDefaults: "기본값으로",

  // ── 동기화
  syncSection: "동기화",
  syncIntro:
    '다른 브라우저·폰·PC 앱은 화면을 열 때마다 대표 디바이스(정하지 않았으면 PC 앱)에서 아래 켜 둔 항목을 가져옵니다. 머리줄 톱니의 "대표 배치 가져오기"로 바로 다시 맞출 수도 있습니다. Paseo 설정은 이와 따로 늘 자동으로 맞춰집니다.',
  syncWorkspaceOrder: "작업 공간 순서",
  syncWorkspaceOrderHint: "왼쪽 목록의 프로젝트·작업 공간 순서와 고정한 작업 공간",
  syncLayout: "화면 배치",
  syncLayoutHint: "작업 공간마다 칸 나누기·칸 크기·탭 배치·탐색기 폭·고정한 대화",
  syncSwitchLabel: (title: string) => `대표 디바이스에서 ${title} 가져오기`,

  // ── 작업 현황
  activitySection: "작업 현황",
  activitySplitTitle: "작업 현황 칸 폭 (%, 10~90)",
  activitySplitHint:
    "머리줄 작업 현황 단추를 누르면 화면을 둘로 나눠 왼쪽에 작업 현황, 오른쪽에 지금 대화를 둡니다. 탐색기를 뺀 남은 폭에서 작업 현황이 차지할 몫입니다. 이미 칸이 둘 이상이면 나누지 않습니다. 나눌 때 화면이 한 번 새로 읽힙니다.",
  activitySplitLabel: "작업 현황 칸 폭 퍼센트",

  // ── 프로젝트 목록
  projectsSection: "프로젝트 목록",
  resetOrderTitle: "순서·고정 초기화",
  resetOrderHint:
    "왼쪽 프로젝트 목록에서 끌어 옮긴 순서(카테고리·프로젝트·활성)와 고정을 모두 지웁니다. 목록 파일에 적힌 순서로 돌아가고 고정은 모두 풀립니다. 목록 파일 자체는 바뀌지 않습니다.",
  resetOrderConfirm: "정말 초기화할까요? 되돌릴 수 없습니다.",
  resetOrderDo: "초기화",
  resetOrderDoLabel: "순서와 고정 초기화 확정",
  cancel: "취소",
  resetOrderCancelLabel: "초기화 취소",
  resetOrderButton: "순서·고정 초기화…",
  resetOrderButtonLabel: "프로젝트 목록 순서와 고정 초기화",
  resetOrderDone: "목록 순서와 고정을 초기화했습니다 — 목록 파일 순서로 돌아갑니다",
  resetOrderFailed: (error: string) => `초기화하지 못했습니다: ${error}`,

  // ── 번역·읽기(10-08)
  speechSection: "번역·읽기·받아쓰기 설정",
  speechIntro:
    "생각 상자의 번역·읽기·번역읽기 버튼과 대화의 턴·말 읽기 단추를 켜고 끕니다. 끄면 그 버튼이 모두 숨습니다. Paseo 언어가 한국어면 한국어로 번역하고 한국어 목소리로 읽으며, 그 밖의 언어면 영어로 합니다.",
  speechKeysIntro:
    "키는 이 PC 의 키 파일(google.env)에만 저장되고 이 화면에 다시 보이지 않습니다. 서버에서 도는 대화는 그 서버의 키 파일을 씁니다.",
  translateTitle: "번역 켜기",
  translateHint: "생각 상자의 번역·번역읽기 버튼 — 구글 Gemini 키가 필요합니다",
  ttsTitle: "읽기 켜기",
  ttsHint: "생각 상자의 읽기·번역읽기 버튼과 대화의 턴·말 읽기 단추 — 구글 음성 합성 키가 필요합니다",
  geminiKeyName: "Gemini 키",
  autoOpenTitle: "자동으로 펼치기",
  autoOpenHint: "번역·원문 보기·읽기·번역읽기를 누르면 생각 상자를 펼치고 높이 제한을 풀어 스크롤 없이 전부 보이게 합니다. 끝나도 원래 크기로 돌리지 않습니다.",
  speedStepTitle: "속도 단계",
  speedStepHint: "1배에 더하는 단계입니다. 0.1배는 2배까지, 0.25배는 5배까지 선택할 수 있습니다.",
  speedShortcuts: "Ctrl + < 느리게 · Ctrl + > 빠르게",
  speedShortcutsHint: "읽는 중에만 동작합니다. Ctrl+Shift+쉼표 / Ctrl+Shift+마침표로 한 단계씩, 최저 0.5배까지 조절합니다. 단축키는 바꿀 수 없습니다.",
  ttsKeyName: "음성 합성 키",
  keyInputLabel: (name: string) => `${name} 넣기`,
  keyPlaceholderSaved: "저장된 키가 있습니다 — 바꾸려면 새 키를 넣으세요",
  keyPlaceholderMissing: "키를 넣으세요",
  keyLine: (name: string, saved: boolean, check: string) => `${name}: ${saved ? "저장됨" : "없음"} · 마지막 확인 ${check}`,
  keyCheckOk: (time: string) => `성공 (${time})`,
  keyCheckFailed: (time: string) => `실패 (${time})`,
  keyCheckNever: "아직 안 함",
  keysReading: "키 상태를 읽는 중입니다",
  keysStateFailed: (error: string) => `키 상태를 읽지 못했습니다: ${error}`,
  keysSave: "키 저장",
  keysSaving: "저장 중",
  keysCheck: "키 확인",
  keysChecking: "확인 중",
  keysCheckHint: "저장된 키로 짧게 한 번 번역하고 한 번 소리를 만들어 봅니다",
  keysUnsaved: "넣은 키는 [키 저장]을 눌러야 저장됩니다. [키 확인]은 저장된 키로 합니다.",
  keysSaved: "키를 저장했습니다",
  keysNothing: "저장할 키를 넣어 주세요",
  keysInvalid: (name: string) => `${name}에 빈칸이나 따옴표처럼 키 파일에 쓸 수 없는 글자가 있습니다`,
  keysWriteFailed: "키 파일을 쓰지 못했습니다",
  keysSaveFailed: (error: string) => `키를 저장하지 못했습니다: ${error}`,
  keysChecked: "확인했습니다",
  keysCheckNone: "저장된 키가 없어 확인할 것이 없습니다",
  keysCheckFailed: (error: string) => `확인하지 못했습니다: ${error}`,

  // ── 받아쓰기 이름 힌트(10-10)
  sttHintsTitle: "받아쓰기 이름 힌트",
  sttHintsHint:
    "Paseo 마이크 단추로 말한 것을 Gemini 가 받아쓰고 군말을 뺀 뒤 입력창에 넣습니다. 여기 적은 이름은 이 철자대로 적습니다(쉼표로 구분, 비우면 힌트 없이). 저장하면 서버에도 같은 목록을 보냅니다.",
  sttHintsPlaceholder: "예: Paseo, Claude, Codex",
  sttHintsReading: "이름 힌트를 읽는 중입니다",
  sttHintsReadFailed: (error: string) => `이름 힌트를 읽지 못했습니다: ${error}`,
  sttHintsUnsaved: "고친 이름은 [이름 저장]을 눌러야 저장됩니다.",
  sttHintsSave: "이름 저장",
  sttHintsSaving: "저장 중",
  sttHintsSaved: (sent: number, total: number, failed: string) =>
    total === 0 ? "저장했습니다" : failed ? `저장했습니다 · 서버 ${total}대 중 ${sent}대에 보냄(못 보낸 서버: ${failed})` : `저장했습니다 · 서버 ${total}대에 모두 보냄`,
  sttHintsWriteFailed: "이름 힌트 파일을 쓰지 못했습니다",
  sttHintsSaveFailed: (error: string) => `저장하지 못했습니다: ${error}`,

  // ── 소리
  soundSection: "소리",
  soundFoldOpenLabel: "소리 설정 펼치기",
  // 설정 칸 접기(10-09 — sectionTitle FoldTitle 의 읽기 도우미 이름 뒤에 붙는다)
  fold: { open: "펼치기", close: "접기" },
  soundFoldCloseLabel: "소리 설정 접기",
  soundIntro:
    "이 PC 와 연결된 서버의 대화 소리가 모두 여기 설정을 따릅니다. 파일 칸을 비우면 기본 소리, 크기는 50~300% 이며 WAV 파일만 키울 수 있습니다.",
  sounds: {
    completion: { title: "끝남", hint: "대화가 끝났을 때" },
    question: { title: "질문", hint: "질문 창이나 계획 승인 창이 떴을 때" },
    warning: { title: "경고", hint: "컨텍스트가 경고 기준을 처음 넘을 때" },
    danger: { title: "위험", hint: "컨텍스트가 위험 기준을 처음 넘을 때" },
    workflow: { title: "따르릉", hint: "워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행이 끝났을 때" },
  } as Record<SoundKind, { title: string; hint: string }>,
  filePlaceholder: "비우면 기본 소리",
  fileLabel: (title: string) => `${title} 소리 파일 경로`,
  gainLabel: (title: string) => `${title} 소리 크기 퍼센트`,
  previewLabel: (title: string) => `${title} 소리 미리 듣기`,
  preview: "미리 듣기",
  playFailed: (title: string, error: string) => `${title} 소리를 틀지 못했습니다: ${error}`,
  settleTitle: "끝남·질문 대기 (밀리초, 100~5000)",
  settleHint: "이 시간 안에 대화가 다시 움직이거나 질문에 답하면 울리지 않습니다",
  settleLabel: "끝남과 질문 소리 대기 시간",
  thresholdsTitle: "경고 기준 · 위험 기준 (컨텍스트 %)",
  warningLabel: "경고 기준 퍼센트",
  dangerLabel: "위험 기준 퍼센트",
  workflowBeepTitle: "따르릉 울리기",
  workflowBeepHint: "끄면 워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행이 끝나도 울리지 않습니다",

  // ── VS Code 확장 설정 가져오기(10-08)
  importTitle: "VS Code 확장 설정 가져오기",
  importHint:
    "이 PC 의 VS Code 사용자 설정에서 Claude State Bar 확장의 소리 파일·크기·대기·경고 기준·위험 기준·따르릉 켜기를 읽어 아래 칸을 채웁니다. 바로 저장하지는 않습니다.",
  importButton: "VS Code 확장 설정 가져오기",
  importing: "읽는 중",
  importDone: (count: number) => `VS Code 확장 설정에서 ${count}개를 가져왔습니다. [저장]을 눌러야 적용됩니다.`,
  importNothing: "VS Code 확장 설정에서 가져올 값이 없었습니다. 칸은 그대로입니다.",
  importNoFile: (path: string) => `이 PC 에 VS Code 사용자 설정 파일이 없습니다 (${path})`,
  importUnreadable: (path: string, error: string) => `VS Code 설정 파일을 읽지 못했습니다 (${path}): ${error}`,
  importFailed: (error: string) => `가져오지 못했습니다: ${error}`,
  importSkippedHead: "가져오지 못한 것",
  importSkippedType: (label: string, value: string) => `${label}: ${value} — 값의 형식이 다릅니다`,
  importSkippedRange: (label: string, value: string) => `${label}: ${value} — 여기서 받는 범위나 형식(정수 등)에 맞지 않습니다`,
  importNotSet: (labels: string) => `VS Code 설정에 없어 그대로 둔 것(확장 기본값을 쓰는 중): ${labels}`,
  importFields: {
    "completion.file": "끝남 소리 파일",
    "completion.gain": "끝남 소리 크기",
    "question.file": "질문 소리 파일",
    "question.gain": "질문 소리 크기",
    "warning.file": "경고 소리 파일",
    "warning.gain": "경고 소리 크기",
    "danger.file": "위험 소리 파일",
    "danger.gain": "위험 소리 크기",
    "workflow.file": "따르릉 소리 파일",
    "workflow.gain": "따르릉 소리 크기",
    settleMs: "끝남·질문 대기",
    warningPercent: "경고 기준",
    dangerPercent: "위험 기준",
    workflowBeep: "따르릉 울리기",
  } as Record<ExtImportField, string>,
  listJoin: ", ",

  // ── Paseo 버전·기능 상태(versionStatus) — 10-09 리규형님 "이 화면의 Paseo 판이 무슨 뜻이냐" → 쉬운 말로
  versionSection: "Paseo 플러그인 상태",
  versionUnknown: (code: string) => `모르는 버전 (화면 코드 ${code})`,
  versionLine: (version: string, desktop: boolean) => `이 ${desktop ? "PC 앱" : "브라우저"}의 Paseo 버전: ${version}`,
  // 기능별 상태(10-08 — client/health.ts). "아는 판 = 모두 켜짐"은 실제 동작을 안 보고 하는 말이라 없앴다
  versionTableReady: "플러그인이 이 버전에 맞춰져 있습니다",
  versionTableMissing:
    "플러그인이 아직 이 버전에 맞춰지지 않았습니다 — 엉뚱한 곳을 건드리지 않게 일부 기능을 껐습니다. 플러그인을 이 버전에 맞추면 돌아옵니다",
  healthHead: "기능 상태",
  featureName: {
    split: "작업 현황 단추로 화면 나누기",
    jsonOpen: "프로젝트 목록 JSON 을 편집기로 열기",
    layoutPull: "대표 디바이스의 화면 배치 바로 반영",
    settingsLive: "다른 기기 설정을 새로고침 없이 반영",
    settingsSync: "다른 기기와 설정 맞추기",
  } as Record<FeatureId, string>,
  healthState: { ok: "정상", limited: "제한", stopped: "중단", checking: "확인 중", na: "해당 없음" } as Record<HealthState, string>,
  healthReason: (reason: HealthReason, detail: string): string => {
    switch (reason) {
      case "unknown-bundle":
        return "플러그인이 아직 이 버전에 맞춰지지 않았습니다";
      case "internals-changed":
        return `Paseo 내부 모양이 달라졌습니다(${detail})`;
      case "loading":
        return "저장된 화면 배치를 읽는 중입니다";
      case "not-web":
        return "이 화면에서는 쓰지 않는 기능입니다";
      case "narrow":
        return "좁은 화면은 원래 나누지 않습니다";
      case "publisher":
        return "이 브라우저가 대표 디바이스라 화면 배치를 저장하는 쪽입니다";
      case "no-slot":
        return "이 버전의 공통 설정이 아직 없습니다 — 대표 디바이스(정하지 않았으면 PC 앱)가 이 버전으로 열리면 생깁니다";
      case "other-version":
        return `이 화면을 연 뒤 Paseo 버전이 다른 곳(${detail})에서 바꾼 설정은 여기에 오지 않습니다 — 설정은 버전이 같은 곳끼리만 맞춥니다`;
      case "rpc-failed":
        return `PC 데몬에 묻지 못했습니다(${detail}) — 30초마다 다시 묻습니다`;
    }
  },
  featureFallback: {
    split: "대신 같은 칸의 탭으로 엽니다",
    layoutPull: "톱니 메뉴 '대표 배치 가져오기'(화면 새로 읽기)로는 됩니다",
    settingsLive: "대신 화면을 새로 읽어 반영합니다",
  } as Partial<Record<FeatureId, string>>,
  healthEvidence: "내부 연결이 갖춰졌는지와 PC 데몬 응답만 본 것입니다 — 눌러서 실제로 되는지는 써 봐야 압니다",
  // 기준 브라우저(10-08 — client/screenRole). 10-09 리규형님 "기준 화면·대표 지정이 무슨 소리냐, 기준 브라우저라고 해야지" → 이름 통일
  roleHead: "대표 디바이스 (브라우저)",
  roleHint: "화면 배치(칸 나누기·열린 탭)를 저장해 두는 대표 브라우저 하나입니다. 다른 브라우저·폰·PC 앱은 열 때 이 브라우저의 배치를 따라갑니다. 평소 쓰는 PC 브라우저를 대표로 정해 두세요.",
  roleUnknown: "PC 에 아직 묻지 못했습니다",
  roleNone: "아직 정하지 않았습니다 — 지금은 PC 앱이 대표입니다",
  roleMine: (label: string, when: string) => `이 브라우저가 대표입니다 (${label}, ${when} 지정)`,
  roleOther: (label: string, when: string) => `다른 브라우저가 대표입니다 (${label}, ${when} 지정)`,
  roleClaim: "이 브라우저를 대표 디바이스로 정하기",
  roleRelease: "대표 해제 (PC 앱이 다시 대표)",
  roleBusy: "바꾸는 중…",
  roleFailed: (error: string) => `바꾸지 못했습니다: ${error}`,
  healthSummary: (stopped: number, limited: number) =>
    `업데이트 확인: ${[stopped ? `중단 ${stopped}` : "", limited ? `제한 ${limited}` : ""].filter(Boolean).join(" · ")} — 눌러서 자세히`,
  versionNewerOthers: (list: string) =>
    `Paseo 버전이 다른 곳(${list})에서 나중에 바꾼 설정은 여기에 맞추지 않았습니다. 설정과 화면 배치는 버전이 같은 곳끼리만 맞춥니다 — 두 곳의 Paseo 버전을 같게 하면 다시 맞춰집니다.`,

  // ── 웹 로그인(webLoginSection)
  loginHeading: "웹 로그인 상태",
  loginNoGate:
    "로그인 서버가 앞에 선 웹 주소에 로그인한 브라우저에서만 보입니다. 거기서 로그아웃과 아이디·비밀번호·유지 시간·PC 링크·서버 링크 바꾸기를 합니다.",
  loginLocked: (mins: number) => `너무 많이 틀려 잠겼습니다. 약 ${mins}분 뒤에 다시 하세요.`,
  loginInvalid: (remaining: string) => `비밀번호나 OTP 가 맞지 않습니다. 남은 시도 ${remaining}번.`,
  loginExpired: "로그인이 끝났습니다. 화면을 새로 고쳐 다시 로그인하세요.",
  loginFailedStatus: (status: number) => `처리하지 못했습니다(${status}).`,
  durationHM: (h: number, m: number) => `${h}시간 ${m}분`,
  durationM: (m: number) => `${m}분`,
  loginFieldNames: { id: "아이디", password: "비밀번호", sessionHours: "유지 시간", link: "PC 링크", servers: "서버 링크" } as Record<string, string>,
  loginFieldJoin: "·",
  loginAccountFailed: (error: string) => `계정 정보를 읽지 못했습니다: ${error}`,
  loginPasswordMismatch: "새 비밀번호 두 칸이 다릅니다.",
  loginNothingToChange: "바꿀 칸을 하나 이상 채우세요.",
  loginChanged: (fields: string) => `바꿨습니다: ${fields}.`,
  loginOthersEnded: (count: number) => `다른 기기 ${count}곳은 로그아웃됐습니다.`,
  loginHoursNext: "유지 시간은 다음 로그인부터 적용됩니다.",
  loginLinkDropped: "잠가 둔 PC 링크를 다시 잠그지 못해 지웠습니다 — 다음 로그인 때 다시 붙이세요.",
  loginLinksReopen: "바뀐 링크는 화면을 다시 열어야 붙고 떨어집니다.",
  loginUnreachable: (error: string) => `서버에 닿지 않습니다: ${error}`,
  loginAs: (id: string, until: string, left: string) => `${id} 로 로그인 · ${until} 에 끝남 (남은 ${left})`,
  loginSessionLine: (hours: number, linkServerId: string | null) =>
    `세션 유지 시간 ${hours}시간 · PC 링크 ${linkServerId ? `저장됨(${linkServerId})` : "없음"}`,
  loginServersLine: (count: number) =>
    `서버 링크 ${count ? `${count}개 — 로그인할 때 함께 붙습니다` : "없음 — 아래 바꾸기에서 넣으면 로그인할 때 서버도 붙습니다"}`,
  loginServerMarked: " — 바꾸기 누르면 지움",
  loginServerRemoveLabel: (name: string) => `${name} 서버 링크 지우기`,
  loginServerRemove: "지우기",
  loginServerRemoveCancel: "지우기 취소",
  loginReading: "읽는 중…",
  loginLogout: "로그아웃",
  loginOpenChange: "아이디·비밀번호·유지 시간·링크 바꾸기",
  loginCloseChange: "바꾸기 닫기",
  loginChangeIntro: "바꿀 칸만 채우세요. 비운 칸은 그대로 둡니다.",
  loginNewId: "새 아이디",
  loginNewPassword: "새 비밀번호(8자 이상)",
  loginNewPassword2: "새 비밀번호 한 번 더",
  loginHours: "세션 유지 시간(시간, 다음 로그인부터)",
  loginPcLink: "새 PC 연결 링크(PC Paseo 앱 → 호스트 설정 → 기기 페어링)",
  loginServerLabel: "추가할 서버 이름(비우면 서버 번호)",
  loginServerLink: "서버 연결 링크(그 서버 호스트 설정 → 기기 페어링, 또는 서버에서 paseo daemon pair)",
  loginConfirmHint:
    "확인 — 지금 비밀번호와 OTP 6자리. 방금 로그인에 쓴 숫자는 다시 못 쓰니 새 숫자가 뜨면 넣으세요. 아이디·비밀번호를 바꾸면 다른 기기 로그인은 모두 끊깁니다.",
  loginCurrentPassword: "지금 비밀번호",
  loginOtp: "OTP 6자리",
  loginChecking: "확인 중",
  loginSubmit: "바꾸기",
  loginReopen: "화면 다시 열기",
};

export type SettingsText = typeof ko;

const en: SettingsText = {
  loading: "Loading sync and sound settings",
  readFailed: (error) => `Couldn't read settings: ${error}`,
  invalidStored: (error) => `Saved settings are invalid: ${error}`,
  checkValue: (path, message) => `Please check this value (${path}): ${message}`,
  warningBelowDanger: "The warning level must be lower than the danger level",
  saved: "Saved",
  saveFailed: (error) => `Couldn't save: ${error}`,
  resetDone: "Restored the defaults",
  resetFailed: (error) => `Couldn't restore the defaults: ${error}`,
  save: "Save",
  saving: "Saving",
  resetDefaults: "Restore defaults",

  syncSection: "Sync",
  syncIntro:
    "Each time another browser, a phone or the PC app opens, it takes the items switched on below from the main device (or the PC app if none is set). You can also sync again right away with 'Get main layout' in the header gear menu. Paseo settings are always synced automatically, separately from this.",
  syncWorkspaceOrder: "Workspace order",
  syncWorkspaceOrderHint: "Order of projects and workspaces in the left list, and pinned workspaces",
  syncLayout: "Layout",
  syncLayoutHint: "Per-workspace splits, pane sizes, tab placement, explorer width and pinned chats",
  syncSwitchLabel: (title) => `Get ${title.toLowerCase()} from the main device`,

  activitySection: "Activity",
  activitySplitTitle: "Activity pane width (%, 10–90)",
  activitySplitHint:
    "The Activity button on the header splits the screen in two: activity on the left, the current chat on the right. This is the activity pane's share of the width left after the explorer. If there are already two or more panes, it doesn't split. The screen reloads once when it splits.",
  activitySplitLabel: "Activity pane width percent",

  projectsSection: "Project list",
  resetOrderTitle: "Reset order and pins",
  resetOrderHint:
    "Clears every order you dragged in the left project list (categories, projects, active) and every pin. The list goes back to the order in the list file and all pins are removed. The list file itself is not changed.",
  resetOrderConfirm: "Reset now? This can't be undone.",
  resetOrderDo: "Reset",
  resetOrderDoLabel: "Confirm resetting order and pins",
  cancel: "Cancel",
  resetOrderCancelLabel: "Cancel reset",
  resetOrderButton: "Reset order and pins…",
  resetOrderButtonLabel: "Reset project list order and pins",
  resetOrderDone: "Order and pins were reset — the list follows the list file again",
  resetOrderFailed: (error) => `Couldn't reset: ${error}`,

  speechSection: "Translate, read-aloud and dictation settings",
  speechIntro:
    "Turns the Translate, Read and Translate and read buttons in thinking boxes, and the turn and message read buttons in conversations, on or off. When off, those buttons are hidden. If Paseo's language is Korean, text is translated into Korean and read in a Korean voice; for any other language, English is used.",
  speechKeysIntro:
    "Keys are saved only in this PC's key file (google.env) and are never shown on this screen again. Chats running on a server use that server's key file.",
  translateTitle: "Translate",
  translateHint: "Translate and Translate and read buttons in thinking boxes — needs a Google Gemini key",
  ttsTitle: "Read aloud",
  ttsHint: "Read and Translate and read buttons in thinking boxes, and the turn and message read buttons in conversations — needs a Google text-to-speech key",
  geminiKeyName: "Gemini key",
  autoOpenTitle: "Expand automatically",
  autoOpenHint: "Translate, Original, Read and Translate and read open the thinking box and lift its height limit so everything shows without scrolling. It stays expanded when finished.",
  speedStepTitle: "Speed step",
  speedStepHint: "An increment added to 1x. Select up to 2x with 0.1x steps, or 5x with 0.25x steps.",
  speedShortcuts: "Ctrl + < slower · Ctrl + > faster",
  speedShortcutsHint: "Only while reading. Ctrl+Shift+comma / Ctrl+Shift+period change one step at a time, down to 0.5x. Shortcuts cannot be changed.",
  ttsKeyName: "Text-to-speech key",
  keyInputLabel: (name) => `Enter ${name}`,
  keyPlaceholderSaved: "A key is saved — enter a new key to replace it",
  keyPlaceholderMissing: "Enter a key",
  keyLine: (name, saved, check) => `${name}: ${saved ? "saved" : "none"} · last check ${check}`,
  keyCheckOk: (time) => `passed (${time})`,
  keyCheckFailed: (time) => `failed (${time})`,
  keyCheckNever: "not yet",
  keysReading: "Reading key status",
  keysStateFailed: (error) => `Couldn't read key status: ${error}`,
  keysSave: "Save keys",
  keysSaving: "Saving",
  keysCheck: "Check keys",
  keysChecking: "Checking",
  keysCheckHint: "Translates once and makes one short sound with the saved keys",
  keysUnsaved: "Entered keys are saved only when you press Save keys. Check keys uses the saved keys.",
  keysSaved: "Saved the keys",
  keysNothing: "Enter a key to save",
  keysInvalid: (name) => `${name} has characters that can't go in the key file, such as spaces or quotes`,
  keysWriteFailed: "Couldn't write the key file",
  keysSaveFailed: (error) => `Couldn't save the keys: ${error}`,
  keysChecked: "Checked",
  keysCheckNone: "No saved keys to check",
  keysCheckFailed: (error) => `Couldn't check: ${error}`,

  sttHintsTitle: "Dictation name hints",
  sttHintsHint:
    "What you say with Paseo's microphone button is transcribed by Gemini, cleaned of filler words, and put in the input box. Names listed here are written with this spelling (comma-separated; leave empty for no hints). Saving also sends the same list to the servers.",
  sttHintsPlaceholder: "e.g. Paseo, Claude, Codex",
  sttHintsReading: "Reading name hints",
  sttHintsReadFailed: (error) => `Couldn't read name hints: ${error}`,
  sttHintsUnsaved: "Edited names are saved only when you press [Save names].",
  sttHintsSave: "Save names",
  sttHintsSaving: "Saving",
  sttHintsSaved: (sent, total, failed) =>
    total === 0 ? "Saved" : failed ? `Saved · sent to ${sent} of ${total} servers (not sent: ${failed})` : `Saved · sent to all ${total} servers`,
  sttHintsWriteFailed: "Couldn't write the name hints file",
  sttHintsSaveFailed: (error) => `Couldn't save: ${error}`,

  soundSection: "Sounds",
  soundFoldOpenLabel: "Expand sound settings",
  fold: { open: "expand", close: "collapse" },
  soundFoldCloseLabel: "Collapse sound settings",
  soundIntro:
    "Chat sounds from this PC and its connected servers all follow these settings. Leave a file empty for the default sound. Volume is 50–300%, and only WAV files can be made louder.",
  sounds: {
    completion: { title: "Done", hint: "When a chat finishes" },
    question: { title: "Question", hint: "When a question or plan approval prompt appears" },
    warning: { title: "Warning", hint: "When context first passes the warning level" },
    danger: { title: "Danger", hint: "When context first passes the danger level" },
    workflow: { title: "Chime", hint: "When a workflow, a group of subagents, a background task or a codex_rescue run finishes" },
  },
  filePlaceholder: "Empty for the default sound",
  fileLabel: (title) => `${title} sound file path`,
  gainLabel: (title) => `${title} sound volume percent`,
  previewLabel: (title) => `Preview ${title.toLowerCase()} sound`,
  preview: "Preview",
  playFailed: (title, error) => `Couldn't play the ${title.toLowerCase()} sound: ${error}`,
  settleTitle: "Done and question delay (ms, 100–5000)",
  settleHint: "No sound if the chat moves again or the question is answered within this time",
  settleLabel: "Done and question sound delay",
  thresholdsTitle: "Warning level · Danger level (context %)",
  warningLabel: "Warning level percent",
  dangerLabel: "Danger level percent",
  workflowBeepTitle: "Play the chime",
  workflowBeepHint: "When off, no chime when a workflow, a group of subagents, a background task or a codex_rescue run finishes",

  importTitle: "Import VS Code extension settings",
  importHint:
    "Reads the Claude State Bar extension's sound files, volumes, delay, warning and danger levels and chime switch from this PC's VS Code user settings and fills in the fields below. Nothing is saved yet.",
  importButton: "Import VS Code extension settings",
  importing: "Reading",
  importDone: (count) => `Imported ${count} from the VS Code extension settings. Press Save to apply them.`,
  importNothing: "There was nothing to import from the VS Code extension settings. The fields are unchanged.",
  importNoFile: (path) => `This PC has no VS Code user settings file (${path})`,
  importUnreadable: (path, error) => `Couldn't read the VS Code settings file (${path}): ${error}`,
  importFailed: (error) => `Couldn't import: ${error}`,
  importSkippedHead: "Not imported",
  importSkippedType: (label, value) => `${label}: ${value} — wrong kind of value`,
  importSkippedRange: (label, value) => `${label}: ${value} — outside the range or format accepted here (such as whole numbers)`,
  importNotSet: (labels) => `Not in the VS Code settings, left as is (the extension uses its default): ${labels}`,
  importFields: {
    "completion.file": "Done sound file",
    "completion.gain": "Done sound volume",
    "question.file": "Question sound file",
    "question.gain": "Question sound volume",
    "warning.file": "Warning sound file",
    "warning.gain": "Warning sound volume",
    "danger.file": "Danger sound file",
    "danger.gain": "Danger sound volume",
    "workflow.file": "Chime sound file",
    "workflow.gain": "Chime sound volume",
    settleMs: "Done and question delay",
    warningPercent: "Warning level",
    dangerPercent: "Danger level",
    workflowBeep: "Play the chime",
  },
  listJoin: ", ",

  versionSection: "Paseo plugin status",
  versionUnknown: (code) => `Unknown version (screen code ${code})`,
  versionLine: (version, desktop) => `Paseo version in this ${desktop ? "PC app" : "browser"}: ${version}`,
  versionTableReady: "The plugin is set up for this version",
  versionTableMissing:
    "The plugin is not set up for this version yet — some features are off so nothing wrong gets touched. They come back once the plugin is updated for this version",
  healthHead: "Feature status",
  featureName: {
    split: "Splitting the screen with the Activity button",
    jsonOpen: "Opening the project list JSON in the editor",
    layoutPull: "Applying the main device's layout right away",
    settingsLive: "Applying other devices' settings without reloading",
    settingsSync: "Syncing settings with other devices",
  },
  healthState: { ok: "OK", limited: "Limited", stopped: "Stopped", checking: "Checking", na: "Not used here" },
  healthReason: (reason, detail) => {
    switch (reason) {
      case "unknown-bundle":
        return "The plugin is not set up for this version yet";
      case "internals-changed":
        return `Paseo internals look different (${detail})`;
      case "loading":
        return "Still reading the saved layout";
      case "not-web":
        return "This screen doesn't use this feature";
      case "narrow":
        return "Narrow screens never split";
      case "publisher":
        return "This is the main device, so it is the side that saves the layout";
      case "no-slot":
        return "No shared settings for this version yet — they appear once the main device (or the PC app if none is set) opens on this version";
      case "other-version":
        return `Settings changed after this screen opened on a screen with a different version (${detail}) don't come here — settings only sync between screens on the same version`;
      case "rpc-failed":
        return `Couldn't reach the PC daemon (${detail}) — retrying every 30 seconds`;
    }
  },
  featureFallback: {
    split: "Opens as a tab in the same pane instead",
    layoutPull: "The gear menu's 'Get main layout' (reloads the screen) still works",
    settingsLive: "Reloads the screen to apply them instead",
  },
  healthEvidence: "This only checks that the internal hooks are in place and the PC daemon answers — whether pressing it actually works shows when you use it",
  roleHead: "Main device (browser)",
  roleHint: "The one browser whose layout (split panes, open tabs) is kept. Other browsers, phones and the PC app follow it when they open. Make the PC browser you use every day the main device.",
  roleUnknown: "Haven’t asked the PC yet",
  roleNone: "Not set yet — the PC app is the main device for now",
  roleMine: (label, when) => `This browser is the main device (${label}, set ${when})`,
  roleOther: (label, when) => `Another browser is the main device (${label}, set ${when})`,
  roleClaim: "Make this browser the main device",
  roleRelease: "Clear the main device (the PC app takes over again)",
  roleBusy: "Changing…",
  roleFailed: (error) => `Couldn’t change it: ${error}`,
  healthSummary: (stopped, limited) =>
    `Update check: ${[stopped ? `${stopped} stopped` : "", limited ? `${limited} limited` : ""].filter(Boolean).join(" · ")} — tap for details`,
  versionNewerOthers: (list) =>
    `Settings changed later on screens with a different version (${list}) weren't applied here. Settings and layout only sync between screens on the same version — make both screens the same version to sync again.`,

  loginHeading: "Web login status",
  loginNoGate:
    "Only shown in a browser signed in to a web address behind the login server. There you can log out and change the ID, password, session length, PC link and server links.",
  loginLocked: (mins) => `Locked after too many wrong tries. Try again in about ${mins} min.`,
  loginInvalid: (remaining) => `Wrong password or OTP. ${remaining} tries left.`,
  loginExpired: "Your login has ended. Reload the page and log in again.",
  loginFailedStatus: (status) => `Couldn't process the request (${status}).`,
  durationHM: (h, m) => `${h} h ${m} min`,
  durationM: (m) => `${m} min`,
  loginFieldNames: { id: "ID", password: "password", sessionHours: "session length", link: "PC link", servers: "server links" },
  loginFieldJoin: ", ",
  loginAccountFailed: (error) => `Couldn't read account info: ${error}`,
  loginPasswordMismatch: "The two new passwords don't match.",
  loginNothingToChange: "Fill in at least one field to change.",
  loginChanged: (fields) => `Changed: ${fields}.`,
  loginOthersEnded: (count) => `Logged out on ${count} other device${count === 1 ? "" : "s"}.`,
  loginHoursNext: "The session length applies from the next login.",
  loginLinkDropped: "The locked PC link couldn't be locked again, so it was removed — add it again at the next login.",
  loginLinksReopen: "Changed links connect or disconnect after you reopen the screen.",
  loginUnreachable: (error) => `Can't reach the server: ${error}`,
  loginAs: (id, until, left) => `Logged in as ${id} · ends ${until} (${left} left)`,
  loginSessionLine: (hours, linkServerId) =>
    `Session length ${hours} h · PC link ${linkServerId ? `saved (${linkServerId})` : "none"}`,
  loginServersLine: (count) =>
    `Server links: ${count ? `${count} — connected together at login` : "none — add one under Change below and servers connect at login too"}`,
  loginServerMarked: " — removed when you press Change",
  loginServerRemoveLabel: (name) => `Remove server link ${name}`,
  loginServerRemove: "Remove",
  loginServerRemoveCancel: "Keep",
  loginReading: "Reading…",
  loginLogout: "Log out",
  loginOpenChange: "Change ID, password, session length or links",
  loginCloseChange: "Close",
  loginChangeIntro: "Fill in only what you want to change. Empty fields stay as they are.",
  loginNewId: "New ID",
  loginNewPassword: "New password (8+ characters)",
  loginNewPassword2: "New password again",
  loginHours: "Session length (hours, from the next login)",
  loginPcLink: "New PC pairing link (PC Paseo app → Host settings → Pair device)",
  loginServerLabel: "Name of the server to add (empty for its server ID)",
  loginServerLink: "Server pairing link (that server's Host settings → Pair device, or paseo daemon pair on the server)",
  loginConfirmHint:
    "Confirm with your current password and a 6-digit OTP. The code you just used to log in can't be reused, so wait for a new one. Changing the ID or password logs out every other device.",
  loginCurrentPassword: "Current password",
  loginOtp: "6-digit OTP",
  loginChecking: "Checking",
  loginSubmit: "Change",
  loginReopen: "Reopen screen",
};

/** 지금 Paseo 언어의 사전. 설정 화면은 열릴 때 한 번 읽으면 충분하다(리규형님 10-08 — Paseo 언어를 바꾸면 다시 열 때 반영) */
export function settingsText(lang: "ko" | "en" = uiLanguage()): SettingsText {
  return lang === "ko" ? ko : en;
}
