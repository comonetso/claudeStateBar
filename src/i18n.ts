// Lightweight i18n for the settings webview and status-bar plan-usage labels.
// English is the default; Korean is a full translation. The dictionary is sent
// to the webview verbatim (postMessage) so the webview can render with its own t().

export type Lang = 'en' | 'ko';

export type Dict = Record<string, string | string[]>;

const EN: Dict = {
    // Panel chrome
    'panel.title': 'claudeStateBar',
    'lang.label': 'Language',
    'common.save': 'Save',
    'common.refresh': 'Refresh now',
    'common.test': 'Test',

    // Section headers
    'section.claudeState': 'claudeStateBar — Plan Usage',
    'section.claudeContextBar': 'claudeContextBar — Context Monitor',
    'section.telegram': 'Telegram Notifications',

    // claudeState fields
    'state.orgId.label': 'Organization ID',
    'state.orgId.placeholder': 'e.g. da39b20c-1aee-4add-bbc6-7d876b5492fb',
    'state.orgId.hint': 'The UUID visible in claude.ai Network tab under /api/organizations/{UUID}/...',
    'state.cookie.label': 'Session Key (sessionKey cookie)',
    'state.cookie.placeholder': 'sk-ant-sid02-...',
    'state.cookie.hint': 'claude.ai DevTools → Application → Cookies → sessionKey value',
    'state.cookie.saved': '(saved key present — leave blank to keep, enter a new value to overwrite)',
    'state.interval.label': 'Refresh interval (seconds)',
    'state.interval.hint': 'Range: 10 – 3600 seconds / Default: 300 (5 min)',
    'state.note': 'Session Key and Bot Token are encrypted via the editor secret store (SecretStorage).',

    // claudeState validation / status messages
    'state.err.noOrgId': 'Organization ID is required',
    'state.err.noCookie': 'Session Key is required',
    'state.err.badInterval': 'Refresh interval must be between 10 and 3600 seconds',
    'state.msg.saving': 'Saved. Refreshing...',
    'state.msg.saveFailed': 'Save failed: {0}',
    'state.msg.refreshRequested': 'Refresh requested',
    'state.msg.ok': '✓ Success (source: {0})',
    'state.msg.authExpired': '⚠ Session Key expired — enter a new one',
    'state.msg.err': '✗ {0}',
    'state.msg.needSettings': 'Setup needed',

    // Telegram
    'tg.token.label': 'Bot Token',
    'tg.token.placeholder': '1234567890:ABCdef...',
    'tg.token.hint': 'Get this from @BotFather → /newbot',
    'tg.guide': '<b>Setup steps</b><br>① In Telegram, search <b>@BotFather</b> → send <b>/newbot</b> → choose a name/username → copy the token<br>② Paste the token into the field above<br>③ Open <b>your new bot</b> in Telegram and send <b>/start</b> or any message<br>④ Click <b>"Link my Telegram"</b> below — Chat ID is auto-detected<br>⑤ Click <b>"Send test message"</b> to verify<br><br>✅ After linking, you get a Telegram notification every time your Claude 5-hour session resets.',
    'tg.link': 'Link my Telegram',
    'tg.linked': 'Linked: {0}',
    'tg.notLinked': 'Not linked',
    'tg.linking': 'Send any message to your bot first, then click the button...',
    'tg.linkFail': 'Link failed — send a message to your bot first',
    'tg.invalidToken': 'Invalid token',
    'tg.test': 'Send test message',
    'tg.testSent': '✓ Test message sent',
    'tg.testFail': 'Send failed',
    'tg.resetMsg': '✅ <b>Claude session reset</b>\n\nYour 5-hour window is fully available.\nWeekly usage: {0}%',

    // Status-bar plan usage labels
    'sb.sessionLabel': 'Session',
    'sb.session': 'Session',
    'sb.weekly': 'Weekly',
    'sb.reset': 'reset',
    'sb.resetsSoon': 'resetting soon',
    'sb.daysLater': 'in {0}d {1}h',
    'sb.hoursLater': 'in {0}h {1}m',
    'sb.minsLater': 'in {0}m',
    'sb.am': 'AM',
    'sb.pm': 'PM',
    'sb.weekdays': ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    'sb.unconfigured': 'Setup needed',
    'sb.cookieExpired': 'Session Key expired',
    'sb.blocked': 'Plan usage unavailable here',
    'sb.error': 'Error',
    'sb.tooltip.needSettings': 'Click → Open Settings (enter Session Key / Org ID)',
    'sb.tooltip.authExpired': '⚠ Session Key expired / auth failed. Open Settings and re-enter it.',
    'sb.tooltip.blocked': '⚠ This host can\'t reach claude.ai\'s usage API (the Session Key is fine): Cloudflare challenges cloud/datacenter IPs (e.g. AWS) and some hosts can\'t connect at all. Plan usage works on desktop VS Code — view it there.',

    // claudeContextBar fields (label + short hint)
    'cb.autoColor.label': 'Auto color (rainbow per project)',
    'cb.baseColor.label': 'Base color (when auto color is off)',
    'cb.contextLimitDefault.label': 'Context limit — standard models (tokens)',
    'cb.contextLimitOpus.label': 'Context limit — 1M models (tokens)',
    'cb.warningThreshold.label': 'Warning threshold (%)',
    'cb.dangerThreshold.label': 'Danger threshold (%)',
    'cb.refreshInterval.label': 'Refresh interval (seconds)',
    'cb.idleTimeout.label': 'Idle dim timeout (seconds)',
    'cb.hideAfter.label': 'Hide after (seconds)',
    'cb.scope.label': 'Session scope',
    'cb.scope.workspace': 'Current workspace only',
    'cb.scope.all': 'All sessions',
    'cb.showModel.label': 'Show model name',
    'cb.compactMode.label': 'Compact mode (shorten names)',
    'cb.note': 'Custom short names (shortNames) can be edited in the standard VS Code settings (Ctrl+,).',

    // Sound settings
    'sound.title': 'Beep sounds',
    'sound.hint': 'WAV / MP3 file path (empty = OS default). Volume 50–5000% (WAV amplifies in-memory above 100%; MP3 only attenuates). Gains above ~300% typically cause clipping/distortion — louder turns into harsher. Plays on the local PC; identical behaviour for Remote-SSH and any workspace.',
    'sound.warning': '⚠️ Warning (1×)',
    'sound.danger': '🔴 Danger (2×)',
    'sound.completion': '✅ Task complete',
    'sound.question': '❓ Waiting for you',
    'sound.questionHint': 'The question beep fires when Claude requests input via AskUserQuestion or ExitPlanMode — 100% accurate.',
    'sound.settleMs.label': 'Completion / question settle (ms)',
    'sound.settleMs.hint': 'Wait this long after detecting end_turn or a question; if new activity (auto follow-up, immediate user reply) appears, suppress the beep. 0 = fire immediately.',
    'sound.stuckSec.label': 'tool_use stuck threshold (sec)',
    'sound.stuckSec.hint': 'Used only when the heuristic below is enabled.',
    'sound.detectStuck.label': 'Beep on suspected VS Code permission prompt (heuristic — false-positive risk)',
    'sound.detectStuck.hint': 'When the latest assistant entry is a tool_use (Bash, Edit, etc.) and N seconds pass without new activity, fire the question beep. Long-running legitimate tools (npm build) will also trigger this. Off by default.',
    'sound.reset': 'Reset to defaults'
};

const KO: Dict = {
    'panel.title': 'claudeStateBar',
    'lang.label': '언어',
    'common.save': '저장',
    'common.refresh': '지금 새로고침',
    'common.test': '테스트',

    'section.claudeState': 'claudeStateBar — 플랜 사용량',
    'section.claudeContextBar': 'claudeContextBar — 컨텍스트 모니터',
    'section.telegram': '텔레그램 알림',

    'state.orgId.label': 'Organization ID',
    'state.orgId.placeholder': '예: da39b20c-1aee-4add-bbc6-7d876b5492fb',
    'state.orgId.hint': 'claude.ai 네트워크 탭에서 /api/organizations/{UUID}/... 에 보이는 UUID',
    'state.cookie.label': 'Session Key (sessionKey 쿠키)',
    'state.cookie.placeholder': 'sk-ant-sid02-...',
    'state.cookie.hint': 'claude.ai 개발자도구 → Application → Cookies → sessionKey 값',
    'state.cookie.saved': '(저장된 키 있음 — 비우면 유지, 새 값 입력 시 덮어씀)',
    'state.interval.label': '새로고침 간격 (초)',
    'state.interval.hint': '범위: 10 ~ 3600초 / 기본: 300초 (5분)',
    'state.note': 'Session Key와 Bot Token은 에디터 보안 저장소(SecretStorage)로 암호화되어 저장됩니다.',

    'state.err.noOrgId': 'Organization ID가 필요합니다',
    'state.err.noCookie': 'Session Key가 필요합니다',
    'state.err.badInterval': '새로고침 간격은 10~3600초 사이여야 합니다',
    'state.msg.saving': '저장 완료. 새로고침 중...',
    'state.msg.saveFailed': '저장 실패: {0}',
    'state.msg.refreshRequested': '새로고침 요청됨',
    'state.msg.ok': '✓ 성공 (출처: {0})',
    'state.msg.authExpired': '⚠ Session Key 만료 — 새 값을 입력하세요',
    'state.msg.err': '✗ {0}',
    'state.msg.needSettings': '설정 필요',

    'tg.token.label': 'Bot Token',
    'tg.token.placeholder': '1234567890:ABCdef...',
    'tg.token.hint': '텔레그램 @BotFather → /newbot 으로 발급',
    'tg.guide': '<b>설정 순서</b><br>① 텔레그램에서 <b>@BotFather</b> 검색 → <b>/newbot</b> 입력 → 봇 이름/ID 지정 → 토큰 발급<br>② 발급받은 토큰을 위 입력란에 붙여넣기<br>③ 텔레그램에서 <b>방금 만든 내 봇</b>을 찾아 <b>/start</b> 또는 아무 메시지나 전송<br>④ 아래 <b>"내 텔레그램과 연결"</b> 버튼 클릭 → Chat ID 자동 연결<br>⑤ <b>"테스트 메시지 전송"</b>으로 확인<br><br>✅ 연결 후 Claude 5시간 세션이 리셋될 때마다 텔레그램으로 알림이 옵니다.',
    'tg.link': '내 텔레그램과 연결',
    'tg.linked': '연결됨: {0}',
    'tg.notLinked': '연결 안 됨',
    'tg.linking': '봇에게 아무 메시지나 보낸 뒤 버튼을 누르세요...',
    'tg.linkFail': '연결 실패 — 봇에게 메시지를 먼저 보내주세요',
    'tg.invalidToken': '토큰이 유효하지 않습니다',
    'tg.test': '테스트 메시지 전송',
    'tg.testSent': '✓ 테스트 메시지 전송됨',
    'tg.testFail': '전송 실패',
    'tg.resetMsg': '✅ <b>Claude 세션 리셋</b>\n\n지금 시작하면 5시간 풀로 사용 가능합니다.\n주간 사용률: {0}%',

    'sb.sessionLabel': '세션한도',
    'sb.session': '세션',
    'sb.weekly': '주간',
    'sb.reset': '재설정',
    'sb.resetsSoon': '곧 재설정',
    'sb.daysLater': '{0}일 {1}시간 후',
    'sb.hoursLater': '{0}시간 {1}분 후',
    'sb.minsLater': '{0}분 후',
    'sb.am': '오전',
    'sb.pm': '오후',
    'sb.weekdays': ['일', '월', '화', '수', '목', '금', '토'],
    'sb.unconfigured': '설정 필요',
    'sb.cookieExpired': 'Session Key 만료',
    'sb.blocked': '이 환경에선 플랜 사용량 불가',
    'sb.error': '오류',
    'sb.tooltip.needSettings': '클릭 → 설정 열기 (Session Key / Org ID 입력)',
    'sb.tooltip.authExpired': '⚠ Session Key 만료/인증 실패. 설정을 열어 다시 입력하세요.',
    'sb.tooltip.blocked': '⚠ 이 호스트에선 claude.ai 사용량 API에 접근할 수 없습니다 (Session Key는 정상). Cloudflare가 클라우드·데이터센터 IP(예: AWS)를 차단하거나, 일부 호스트는 아예 연결이 안 됩니다. 플랜 사용량은 데스크톱 VS Code에서 확인하세요.',

    'cb.autoColor.label': '자동 색상 (프로젝트별 무지개)',
    'cb.baseColor.label': '기본 색상 (자동 색상 끌 때)',
    'cb.contextLimitDefault.label': '컨텍스트 한도 — 표준 모델 (토큰)',
    'cb.contextLimitOpus.label': '컨텍스트 한도 — 1M 모델 (토큰)',
    'cb.warningThreshold.label': '경고 임계값 (%)',
    'cb.dangerThreshold.label': '위험 임계값 (%)',
    'cb.refreshInterval.label': '새로고침 간격 (초)',
    'cb.idleTimeout.label': 'idle 디밍 타임아웃 (초)',
    'cb.hideAfter.label': '숨김 시간 (초)',
    'cb.scope.label': '세션 범위',
    'cb.scope.workspace': '현재 워크스페이스만',
    'cb.scope.all': '모든 세션',
    'cb.showModel.label': '모델 이름 표시',
    'cb.compactMode.label': '컴팩트 모드 (이름 축약)',
    'cb.note': '커스텀 단축 이름(shortNames)은 표준 VS Code 설정(Ctrl+,)에서 편집할 수 있습니다.',

    // Sound settings
    'sound.title': '비프음 설정',
    'sound.hint': 'WAV / MP3 파일 경로 (비워두면 OS 기본음). 볼륨 50~5000% (WAV만 증폭, MP3는 감쇠만). 300% 이상은 클리핑(파형 왜곡) 발생 — 더 큰 소리가 아니라 거친 소리가 됩니다. 로컬 PC에서 재생되며 Remote-SSH·워크스페이스 무관하게 동일하게 적용됩니다.',
    'sound.warning': '⚠️ 경고 (1×)',
    'sound.danger': '🔴 위험 (2×)',
    'sound.completion': '✅ 작업 완료',
    'sound.question': '❓ 질문 대기',
    'sound.questionHint': '질문 대기 비프는 Claude가 AskUserQuestion 또는 ExitPlanMode 도구로 입력을 요구할 때 발사됩니다 — 100% 정확.',
    'sound.settleMs.label': '완료/질문 비프 settle (ms)',
    'sound.settleMs.hint': 'end_turn 또는 질문 검출 후 이 시간만큼 대기. 그 사이 새 활동(자동 follow-up, 사용자 즉답)이 발생하면 비프 취소. 0이면 즉시 발사.',
    'sound.stuckSec.label': 'tool_use 멈춤 임계값 (초)',
    'sound.stuckSec.hint': '아래 휴리스틱이 켜져 있을 때만 적용.',
    'sound.detectStuck.label': 'VS Code 권한 팝업 추정 비프 (휴리스틱 — 오탐 위험)',
    'sound.detectStuck.hint': '마지막 assistant 항목이 tool_use(Bash·Edit 등)이고 N초 이상 새 활동 없을 때 질문 비프 발사. npm build 등 정상 장기 작업도 오탐 발사함. 기본 꺼짐.',
    'sound.reset': '기본값으로 초기화'
};

const DICTS: Record<Lang, Dict> = { en: EN, ko: KO };

export function getDict(lang: Lang): Dict {
    return DICTS[lang] || EN;
}

// Resolve a key for the given language and substitute {0}, {1}, ... placeholders.
export function t(lang: Lang, key: string, ...args: (string | number)[]): string {
    const dict = getDict(lang);
    let v = dict[key];
    if (v == null) v = EN[key];
    if (v == null) return key;
    if (Array.isArray(v)) return key; // arrays are looked up directly, not via t()
    if (args.length) {
        v = v.replace(/\{(\d+)\}/g, (_, i) => {
            const val = args[Number(i)];
            return val == null ? '' : String(val);
        });
    }
    return v;
}
