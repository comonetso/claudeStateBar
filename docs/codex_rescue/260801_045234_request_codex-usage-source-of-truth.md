---
type: codex_request
mode: edit
stamp: 260801_045234
slug: codex-usage-source-of-truth
response_path: docs/codex_rescue/260801_045234_response_codex-usage-source-of-truth.md
---

# Codex 작업 지시 — Codex 세션·사용량 표시가 창마다 어긋난다: 진단하고 직접 고쳐라

## 이 지시의 성격 — 먼저 읽어라

너는 **이 레포의 코드를 직접 수정한다.** (평소 codex_rescue의 readonly 모드와 다르다. 사용자가 명시적으로 edit을 지정했다.)

다만 **무작정 고치지 마라.** 아래 P1~P7 중 **P2는 나(Claude)도 원인을 못 찾았고, 내 가설로는 설명조차 안 되는 모순이 있다.** 그러니 순서는 반드시:

> **① 조사해서 사실을 확정한다 → ② 확신이 서는 것만 고친다 → ③ 확신 없는 건 고치지 말고 보고서에 적는다.**

**확신이 안 서면 고치지 말고 물어라.** 틀린 수정은 안 고친 것보다 나쁘다. 여긴 마켓에 배포되는 확장이다.

---

## 보고를 남길 곳  ← 반드시 지켜라

작업이 끝나면 아래 경로에 **그 이름 그대로** 파일을 만들어 저장해라.

    docs/codex_rescue/260801_045234_response_codex-usage-source-of-truth.md

파일 첫머리에 아래 frontmatter를 그대로 넣어라:

```
---
type: codex_response
mode: edit
stamp: 260801_045234
slug: codex-usage-source-of-truth
author: codex
---
```

- 경로·파일명을 바꾸지 마라. 스탬프와 슬러그는 이 지시서와 짝을 이룬다.
- **쓰기가 막히거나 승인 프롬프트가 뜨면 거기서 멈추지 말고, 같은 내용을 채팅에 그대로 출력해라.** 사람이 옮겨 저장한다.
- 코드 수정본 외에 새로 만드는 파일은 이 보고서 하나뿐이다.

---

## 환경

- **제품**: VS Code 확장 `claudeStateBar` (TypeScript). `npm run compile` → `out/`. 테스트 자동화는 없다.
- **하는 일**: Claude Code / Codex 세션을 디스크에서 읽어 **상태바에 컨텍스트% · 모델 · 계정 사용량**을 표시. 네트워크는 Claude 플랜 조회에만 쓴다.
- **OS**: Windows 11 Pro 26200. 로컬 VS Code 창 여러 개 동시 사용 (+ Remote-SSH 창).
- **Codex 버전**: `cli_version = 0.146.0-alpha.9.2`, `originator = codex_vscode`, `source = vscode`
- **Codex 데이터 위치**: `~/.codex/`
  - `sessions/YYYY/MM/DD/rollout-*.jsonl` (레거시 JSONL)
  - `state_5.sqlite` — `threads` 77행, `thread_spawn_edges`(0행), `thread_dynamic_tools`(0행), `backfill_state`
  - `logs_2.sqlite`(logs 64230행), `memories_1.sqlite`, `goals_1.sqlite`
  - `.codex-global-state.json` — Electron 데스크톱 앱 상태
- **현재 버전**: `package.json` 1.8.0 / 마켓 최신 태그 v1.7.48 (미배포)
- **git 상태**: 작업 트리 clean (추적 파일 변경 0건). HEAD = `02a6bd9`

---

## 대상 파일 (여기만 건드려라)

```
src/providers/codex/discovery.ts       — rollout 스캔 + cwd 매칭
src/providers/codex/sessionProvider.ts — 세션 목록 구성
src/providers/codex/usageProvider.ts   — app-server 스폰해 rate limit 조회
src/providers/codex/rolloutParser.ts   — JSONL 파서
src/providers/codex/display.ts         — 모델명 표시 매핑
src/extension.ts                       — 폴링·표시·계정 사용량 통합
```

새 파일이 필요하면 `src/providers/codex/` 아래에 만들어도 된다(예: `threadsDb.ts`).

**참고용 — 읽되 고치지 마라:**
```
src/planUsage.ts     — Claude 쪽 웹 세션 인증 (P6의 비교 기준)
src/credentials.ts   — context.secrets 저장
```

---

## 문제 — 7건

사용자가 VS Code 창 3개(`claudeContextBar` / `sported_new` / `sportedAppBuild`)에서 Codex를 동시에 쓰는 중이었다. 같은 시각 상태바가 서로 다른 값을 보였다.

### P1. 같은 계정인데 창마다 주간 사용량이 다르다
- 창 A: `⬢ CCB-2: G5.6s - Medium (9%) · 53% (4d 11h)`
- 창 B: `⬢ SN: G5.5 - Medium (7%) · 52% (4d 11h) · idle 1h16m`
- **정답 실측**: ChatGPT 웹 설정 → 사용량 = "주간 사용량 한도 **47% 남음**" = **53% 사용**.
  rollout JSONL의 마지막 `rate_limits.primary.used_percent` 도 **53.0**. → 창 A가 맞고 창 B가 틀림.
- 주의: 웹 UI는 "남음", 우리 값은 "사용"이라 보수 관계다. 과거에 이걸 불일치로 오인한 이력이 있으니 헷갈리지 마라.

### P2. ★ 지금 실행 중인 Codex 세션이 상태바에 아예 안 나온다 — 최난도, 미해결
- 창 C(`sportedAppBuild`, Kotlin, **로컬**)에서 Codex가 "생각 중" = 실제 응답 생성 중이었다.
- 그런데 상태바엔 Claude 항목만 있고 Codex 항목(⬢)이 **없었다.**
- **실측 1**: 그 시각 `~/.codex/sessions/2026/08/01/` 의 rollout 파일은 **1개뿐**이고 cwd는 `claudeContextBar`.
- **실측 2**: `state_5.sqlite` 의 `threads` 를 `recency_at_ms desc` 로 뽑아도 **오늘 스레드는 그 1개뿐**.
- 즉 **JSONL에도 SQLite에도 그 세션이 없다.** 확장의 버그 이전에 "어디에 기록되는가"를 모른다.
- **실측 3**: 같은 15분 창에서 갱신된 파일 — `logs_2.sqlite-wal`(04:46:55), `models_cache.json`(04:46:48), `state_5.sqlite-wal`(04:43:53), rollout JSONL(04:43:53).
  → **가장 최근에 쓰인 건 `logs_2.sqlite-wal` 이고 rollout·threads 는 04:43:53에서 멈춰 있었다.**

### P3. 오래된 세션을 "활성"으로 잘못 표시한다
- 창 B가 보인 `G5.5` + `idle 1h16m` 은 **모델이 gpt-5.5이던 옛 스레드**를 붙잡은 결과로 보인다.
- 그 시각 사용자는 그 창에서 방금 대화를 마친 상태였다("하이" → 응답 완료). 실제 활성 세션은 `gpt-5.6-sol / medium`.
- 즉 **최신 세션을 못 찾고 과거 세션으로 대체 표시**하고 있다.

### P4. Codex가 SQLite로 이전 중인데 우리는 JSONL만 읽는다
`state_5.sqlite` 의 `threads` 실제 DDL:

```sql
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT, git_branch TEXT, git_origin_url TEXT
, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT ''
, agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled'
, model TEXT, reasoning_effort TEXT, agent_path TEXT
, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT
, preview TEXT NOT NULL DEFAULT '', recency_at INTEGER NOT NULL DEFAULT 0
, recency_at_ms INTEGER NOT NULL DEFAULT 0
, history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0);
```

- 표시에 필요한 게 전부 여기 있다: `cwd`, `model`, `reasoning_effort`, `tokens_used`, `updated_at_ms`, `archived`, `rollout_path`.
- 다만 **`history_mode` 가 전 행 `legacy`** 다. JSONL 병행 기록 중이라는 뜻으로 읽힌다 — 이게 "JSONL이 아직 정본"이라는 반대 증거일 수도 있다.
- **함정 실측**: DB의 `cwd` 는 `\\?\F:\workspace\Etc Project\...` 처럼 **Windows 확장길이 UNC 접두사(`\\?\`)가 붙는다.** 같은 세션의 JSONL `session_meta.cwd` 는 `f:\workspace\Etc Project\...` (접두사 **없음**).
  → 지금 매칭 함수는 JSONL 기준이라 **DB 값에 대해 무조건 실패**한다(아래 코드 참조). SQLite로 갈아타는 순간 전 창에서 세션 0건이 된다.

### P5. app-server를 창마다 스폰한다
- `usageProvider.ts` 가 `codex app-server` 를 띄워 `account/rateLimits/read` 를 부른다(관측 ~591–850ms).
- 이게 **VS Code 창마다 독립 타이머로 60초 주기**로 돈다. 창 5개면 스폰도 5배.

### P6. ★ 사용자 제안 — Claude처럼 웹 세션으로 직접 가져오면 안 되나
사용자 원문: *"클로드처럼 https://chatgpt.com/#settings/Usage 여기서 세션으로 가져오면 안될까?"*

우리는 Claude 쪽에서 **이미 그 방식으로 돌리고 있다**(아래 코드 인용). 같은 패턴을 ChatGPT/Codex에 적용 가능한지 판단해라.

### P7. 창 간 공유 저장소가 아예 없다
- `codexLiveUsage` 는 확장 호스트 프로세스의 모듈 변수다. 창끼리 값을 공유할 통로가 없다.

---

## 현재 코드 (실제 인용)

### (1) cwd 매칭 — `src/providers/codex/discovery.ts:164-190`

```ts
export function cwdMatchesFolder(cwd: string, folderFsPath: string): boolean {
    const a = normalisePath(cwd);
    const b = normalisePath(folderFsPath);
    if (!a || !b) return false;
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function normalisePath(p: string): string {
    if (!p) return '';
    let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    // A drive letter means a Windows path regardless of which host we are running on
    const looksWindows = /^[a-zA-Z]:/.test(s);
    if (looksWindows || process.platform === 'darwin') s = s.toLowerCase();
    return s;
}
```

`\\?\F:\workspace\proj` 를 넣으면 `//?/F:/workspace/proj` 가 되고, `/^[a-zA-Z]:/` 가 안 맞아 **소문자화까지 건너뛴다.** 워크스페이스 쪽 `f:/workspace/proj` 와 영영 안 만난다.

### (2) 계정 사용량 통합 — `src/extension.ts:2499-2507`

```ts
function accountCodexUsage(): CodexUsageSnapshot | null {
    const live = codexLiveUsage;              // app-server 실시간
    const snap = codexSnapshotFallback;       // rollout 최신 스냅샷
    if (!live) return snap;
    if (!snap || !snap.observedAt || !live.observedAt) return live;
    return live.observedAt.getTime() >= snap.observedAt.getTime() ? live : snap;
}
```

### (3) 폴링 — `src/extension.ts:630-645`

```ts
const intervalSeconds = config.get<number>('refreshInterval', 30);
refreshInterval = setInterval(refreshAllSessions, intervalSeconds * 1000);
...
{
    const codexUsageSec = Math.max(60, creds.getRefreshIntervalSec());
    refreshCodexUsage();
    codexUsageInterval = setInterval(refreshCodexUsage, codexUsageSec * 1000);
}
```

세션 스캔 30초, Codex 사용량 60초. **창마다 이 타이머가 각자 돈다. 위상 동기화 없음.**

### (4) app-server 스폰 — `src/providers/codex/usageProvider.ts:45-61`

```ts
export function fetchCodexRateLimits(execPath = 'codex'): Promise<CodexUsageSnapshot | null> {
    ...
    child = cp.spawn(execPath, ['app-server'], { ... });
    ...
}
```
(JSON-RPC `initialize` → `initialized` → `account/rateLimits/read` 순서)

### (5) ★ Claude 쪽 웹 세션 방식 — `src/planUsage.ts` (P6의 비교 기준)

```ts
const BASE = 'https://claude.ai';

const HEADERS = (sessionCookie: string): Record<string, string> => ({
    Cookie: `sessionKey=${sessionCookie}`,
    'User-Agent': USER_AGENT,          // Chrome 131 UA 문자열
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
    Referer: `${BASE}/`
});

// claude.ai sits behind Cloudflare, which fingerprints the TLS handshake and blocks
// plain Node `https` requests (403 "Just a moment..."). The VS Code extension host runs
// on Electron, whose `net` module uses Chromium's network stack and passes the challenge.
let electronNet: any | undefined;
function getElectronNet(): any | null { /* require('electron').net */ }

export async function fetchUsage(sessionCookie: string, orgId: string): Promise<UsageResult> {
    const candidates = [
        `${BASE}/api/organizations/${orgId}/usage`,
        `${BASE}/api/organizations/${orgId}/usage_limits`,
        `${BASE}/api/bootstrap/${orgId}/statsig`,
        `${BASE}/api/organizations/${orgId}`
    ];
    for (const url of candidates) {
        const res = await request(url, sessionCookie);   // Electron net 우선, https 폴백
        if (res.json) return { source: url, normalized: normalizeUsage(res.json), raw: res.json };
    }
    throw new Error(...);
}
```

세션 키는 `context.secrets`(OS 키체인)에 저장한다 — `src/credentials.ts:72-85`.
`AuthExpiredError`(401/403)와 `CloudflareBlockedError`(봇 챌린지)를 구분해 안내한다.

---

## 내(Claude)가 세운 가설 — **먼저 이걸 반박하고 시작해라**

**H1 — "source of truth를 잘못 골랐다."**
Codex 0.146-alpha는 `state_5.sqlite`가 1차 저장소이고 rollout JSONL은 하위 호환용이다. 그래서 JSONL 기반인 우리 코드가 최신 세션을 놓치고(P2) 과거 세션으로 대체 표시한다(P3).
근거: `logs_2.sqlite-wal` 이 04:46:55에 쓰이는 동안 rollout JSONL은 04:43:53에 멈춰 있었다.

**H2 — "SQLite로 갈아타면 P1~P5가 한꺼번에 풀린다."**
`threads` 한 테이블에 cwd·model·effort·tokens·updated_at이 다 있고, 모든 창이 같은 DB를 읽으면 값이 저절로 일치한다.

**H3 — "`\\?\` 접두사가 전환 시 첫 지뢰다."**
`normalisePath` 가 UNC 접두사를 모른다. 안 벗기면 전환 즉시 전 창에서 세션 0건.

### ⚠️ 내 가설의 알려진 구멍 — 반드시 여기서 출발해라

- **P2에서 그 세션은 DB에도 없었다.** H1이 맞다면 DB엔 있어야 한다. **H1으로 P2가 설명되지 않는다.**
  → 실제 저장 위치가 제3의 장소(`logs_2.sqlite`? Electron 앱 전용 저장소? `%APPDATA%`? 메모리에만?)일 가능성.
- `history_mode='legacy'` 가 전 행에 붙어 있는 건 H1의 반대 증거일 수 있다.
- **P2를 못 밝힌 채 H2대로 SQLite로 갈아엎으면, P1·P3만 고쳐지고 P2는 그대로 남거나 더 나빠진다.**

**너는 이 레포와 `~/.codex` 를 직접 읽을 수 있다. 추측하지 말고 실제로 조사해서 P2의 답을 찾아라.** 그게 이 작업의 가장 큰 가치다.

---

## 시도했고 실패한 것 (반복하지 마라)

1) **rollout JSONL의 `rate_limits` 를 세션별로 읽어 표시** → 한 계정인데 세션마다 30/28/22/19/48%로 제각각. rate_limits는 **계정 단위**인데 각 rollout은 "그 세션이 마지막으로 돌던 시점의 값"을 박제하고 있었다. 폐기.
2) **app-server `account/rateLimits/read` 를 1차 소스로 승격**(현재 코드) → 한 창 안에서는 통일됐지만 **창을 넘지 못한다.** P1 그대로.
3) **rollout 최신 스냅샷과 app-server 값 중 더 최근 것 채택**(`accountCodexUsage`) → 창마다 probe 시점이 달라 여전히 갈린다.
4) **app-server 메서드 전수 확인** → `thread/list`, `thread/read`, `thread/loaded/list` 존재 확인. 세션 목록 소스로는 아직 안 써봤다.
5) **`\\?\` 정규화** → 미실행. 코드에 해당 처리가 한 줄도 없음을 grep으로 확인만 했다.

---

## 작업 — 이 순서로 해라

### 1단계: 조사 (수정 전에 반드시)

- **P2를 최우선으로 밝혀라.** Codex 0.146-alpha에서 "지금 실행 중인 스레드"가 실제로 어디에 기록되는가?
  - `threads` 는 언제 INSERT/UPDATE 되나 — 스레드 생성 즉시인가, 첫 턴 완료 후인가?
  - `logs_2.sqlite` 의 `logs` 는 무엇을 담나? 세션 식별에 쓸 수 있나?
  - Electron 데스크톱 앱과 VS Code 확장이 **서로 다른 저장소**를 쓰나? (`.codex-global-state.json` 에 `electron-*`, `local-projects`, `thread-workspace-root-hints`, `thread-project-assignments` 키가 있다)
  - `~/.codex` 밖에 또 다른 위치가 있나? (`%APPDATA%`, `%LOCALAPPDATA%`)
- **source of truth 판정.** 후보 ①`state_5.sqlite` 직접 read-only ②app-server `thread/list`·`thread/loaded/list` ③rollout JSONL ④조합 — **버전이 올라가도 안 깨질 순서로** 우선순위를 매기고, 각각 공개 계약인지 내부 구현인지 밝혀라.
- **P6 판정**: `https://chatgpt.com/#settings/Usage` 가 실제로 부르는 엔드포인트·인증 방식·응답 스키마. **`~/.codex/auth.json` 의 토큰을 재사용할 수 있나?**(파일 존재만 확인했다. 내용은 이 문서에 넣지 않았고 너도 보고서에 값을 옮겨 적지 마라.) Cloudflare 차단은? app-server 대비 장단점은?

### 2단계: 수정 (확신이 서는 것만)

1. **근본 원인을 진단하고 위 대상 파일을 직접 수정해라.**
2. **최소 변경만.** 문제와 무관한 리팩터·포맷 변경 금지.
3. 대상 파일 외에는 건드리지 마라. 필요하면 먼저 물어봐라.
4. **확신이 안 서면 수정하지 말고 보고서 "미수정·이유"에 적어라.** 특히 P2의 원인을 못 밝혔다면 세션 소스를 갈아엎지 마라.
5. 고칠 때 최소한 다음은 반영해라(진단이 이를 뒤집으면 뒤집힌 쪽을 따르고 이유를 적어라):
   - `normalisePath` 가 `\\?\`, `\\?\UNC\server\share`, 드라이브 문자 대소문자, 긴 경로를 안전히 다루도록
   - P1·P7: 창 간 값 일치 (공유 캐시 / 단일 재조회 중 네가 옳다고 보는 쪽. **다중 프로세스 동시 쓰기 경합 대책 포함**)
   - P3: "지금 활성인 세션" 판정 — `updated_at_ms` / `recency_at_ms` / `has_user_event` / `archived` 를 어떻게 조합할지

### 3단계: 검증

- `npm run compile` 이 통과해야 한다. **컴파일 안 되는 상태로 끝내지 마라.**
- `npm run lint` 도 돌려라.
- 가능하면 실제 `~/.codex` 데이터로 동작을 확인해라(읽기 전용).

---

## ⚠️ 절대 하지 말 것 — 이 레포의 지뢰 (과거에 실제로 터졌다)

1. **`package.json` 을 `JSON.stringify` 로 재작성하지 마라.** 이전 세션에 이걸 저질러 337줄 재포맷 diff가 났고 되돌렸다. 원본은 **4-space 들여쓰기 + 인라인 배열**이라 stringify로 재현 불가. 부분 편집만 해라.
2. **`[hide]` 로 시작하는 진단 로그를 지우지 마라.** 별건(세션 숨김이 풀리는 현상)이 미해결이라 일부러 남겨둔 것이다.
3. **`git commit` / `git push` / 태그 생성 금지.** 커밋은 사용자가 직접 한다.
4. **버전 번호(`package.json` 의 `version`)를 올리지 마라.** 릴리즈는 별도 절차다.
5. **`~/.codex` 의 어떤 파일도 쓰지 마라.** SQLite는 반드시 **read-only(`?mode=ro`, immutable 아님)** 로 열어라. WAL 모드라 쓰기 락을 잡으면 사용자의 Codex가 망가진다.
6. **비밀값 금지** — `auth.json` 내용, 세션 쿠키, API 키, 토큰을 코드·보고서·로그 어디에도 넣지 마라. 구조·필드명 수준으로만 다뤄라.
7. **`~/.codex` 밖의 사용자 개인 파일을 읽거나 옮기지 마라.**

---

## 보고 — `docs/codex_rescue/260801_045234_response_codex-usage-source-of-truth.md` 에 이 순서로 써라

1. `내 가설 판정` — H1·H2·H3 각각 동의/부분동의/기각 + 이유. **특히 H1과 P2의 모순을 어떻게 해소했는지.**
2. `P2 조사 결과` — 실행 중인 스레드가 실제로 어디 기록되는가. **못 밝혔으면 "못 밝혔다"고 명시하고 어디까지 확인했는지 적어라.**
3. `source of truth 판정` — 우선순위 + 안정성 등급(공개 계약 / 내부 구현)
4. `P6 답변` — ChatGPT 웹 세션 조회 실현 가능성 (엔드포인트·인증·차단·`auth.json` 재사용 가부)
5. `변경한 파일·라인 요약` — 파일별로
6. `무엇을 왜 바꿨나 (before → after)` — 코드로
7. `미수정 항목과 이유` — P1~P7 중 손대지 않은 것과 그 이유. **여기를 비우지 마라.**
8. `빌드·검증 결과` — `npm run compile` / `npm run lint` 실제 출력
9. `남은 리스크·확신도` — 추측인 부분과 확실한 부분을 구분. 버전 업으로 깨질 지점, DB 락/WAL 주의 등
10. `Claude가 추가로 확인해야 할 것` — 없으면 "없음"

---

## 추가 제공 가능

필요하면 아래를 더 줄 수 있다. 무엇이 필요한지 10번에 적어라.
- `threads` 전체 덤프(비밀 컬럼 제외), `_sqlx_migrations` 44행 목록
- rollout JSONL 원문(마스킹 후)
- `.codex-global-state.json` 의 특정 키 값
- `logs_2.sqlite` 의 `logs` 스키마·샘플
