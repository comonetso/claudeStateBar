---
type: codex_response
mode: edit
stamp: 260801_045234
slug: codex-usage-source-of-truth
author: codex
---

# Codex 세션·사용량 source of truth 조사 및 수정 결과

## 1. 내 가설 판정

### H1 — “`state_5.sqlite`가 1차 저장소이고 rollout JSONL은 하위 호환용이다”

**기각에 가까운 부분 동의**다.

- `state_5.sqlite.threads`는 빠른 목록·검색·메타데이터용 projection/index로 중요하다. `cwd`, `model`, `reasoning_effort`, `tokens_used`, `updated_at_ms`, `recency_at_ms`가 실제로 들어 있다.
- 그러나 공개 app-server 문서는 `thread/list`의 기본 동작이 JSONL을 스캔해 DB 메타데이터를 복구할 수 있고, `useStateDbOnly: true`일 때만 DB 결과로 제한된다고 명시한다. 또한 archive는 “persisted JSONL log”를 옮긴다고 설명한다. 즉 현 `history_mode='legacy'`에서는 JSONL이 단순한 폐기 예정 부산물이라고 볼 수 없다.
- 설치된 0.146.0-alpha.9.2의 `thread/list` 결과도 `path`를 가진 저장 스레드를 반환했지만, 목록 객체에는 현재 표시에 필요한 `model`과 `reasoningEffort`가 없었다. SQLite만 읽거나 `thread/list`만 호출해도 현 상태바 정보를 완전히 만들 수 없다.
- 무엇보다 P2 시점에는 JSONL과 DB 모두 같은 한 스레드만 있었다. SQLite 승격은 없는 스레드를 만들어내지 못한다.

결론: **SQLite는 유용한 색인이지, 이 확장에서 rollout을 대체할 단독 정본이 아니다.** 공개 계약은 DB 파일·컬럼이 아니라 app-server 프로토콜이다.

근거: [Codex App Server — thread/list와 `useStateDbOnly`](https://learn.chatgpt.com/docs/app-server), [OpenAI Codex app-server 소스/README](https://github.com/openai/codex/tree/main/codex-rs/app-server).

### H2 — “SQLite로 갈아타면 P1~P5가 한꺼번에 풀린다”

**기각**한다.

- P1/P5/P7은 세션 저장소 문제가 아니라 창별 extension host가 각자 rate-limit 프로세스와 메모리 값을 가진 문제다.
- P2는 DB에도 행이 없었으므로 해결되지 않는다.
- P3의 핵심은 “어느 스레드를 이 VS Code 창의 Codex webview가 현재 보여주는가”다. `cwd`나 DB recency만으로는 창별 선택 상태를 알 수 없다.
- DB의 `tokens_used`는 누적값이며, 상태바의 context occupancy인 최신 `last_token_usage.total_tokens / model_context_window`와 의미가 다르다.
- 직접 DB 스키마에 결합하면 alpha 버전 마이그레이션과 WAL 동시읽기 부담만 늘어난다.

따라서 SQLite 세션 소스 전환은 하지 않았다.

### H3 — “`\\?\` 접두사가 SQLite 전환의 첫 지뢰다”

**동의**한다. SQLite 전환 여부와 무관하게 확정 결함이라 수정했다.

Rust의 `std::fs::canonicalize`는 Windows에서 extended-length 경로를 반환할 수 있다. Windows는 드라이브 경로에 `\\?\C:\...`, UNC 경로에 `\\?\UNC\server\share\...` 형식을 쓴다. 반면 rollout의 `session_meta.cwd`는 입력 cwd를 일반 형식으로 기록할 수 있다. 이 차이가 DB와 JSONL 표현 차이의 가장 설득력 있는 원인이다.

근거: [Rust `std::fs::canonicalize`의 Windows 동작](https://doc.rust-lang.org/std/fs/fn.canonicalize.html), [Microsoft extended-length/UNC 경로 문서](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).

## 2. P2 조사 결과

### 결론

**“실행 중 스레드가 제3의 저장소에만 있었다”는 증거는 찾지 못했다. P2의 당시 UI 상태를 사후 자료만으로 완전히 재현·확정하지도 못했다.** 다만 H1의 저장소 누락 설명과 `logs_2.sqlite-wal` 근거는 반박됐다.

현재 가장 근거가 강한 설명은 다음과 같다.

1. Codex VS Code 확장 창마다 별도 app-server 프로세스가 있다.
2. Codex webview에서 기존 스레드를 다른 창/워크스페이스에서 다시 열어도 그 스레드의 저장 `cwd`가 새 창의 폴더로 바뀐다고 보장되지 않는다.
3. 이 확장은 OpenAI 확장의 선택된 thread ID를 받지 못하고, `session_meta.cwd`와 현재 workspace folder만 비교한다.
4. 그러면 화면에서는 기존 스레드가 응답 중이어도, 생성 cwd가 다른 프로젝트인 그 rollout은 workspace scope에서 제외된다. 같은 창에는 해당 폴더에 속한 옛 rollout만 남거나 아무것도 남지 않는다.

이번 조사 중에도 대화의 workspace roots가 바뀌었지만 `state_5.sqlite`의 현재 스레드는 계속 최초 `claudeContextBar` cwd 하나로 유지되는 유사 현상을 관측했다. 다만 이것이 당시 `sportedAppBuild` 화면과 정확히 같은 조작이었다는 역사 자료는 없으므로 **P2의 정확한 UI 재현 원인은 중간 확신**으로 남긴다.

### `threads`는 언제 생기나

공개 프로토콜상 `thread/start`는 새 thread 객체를 즉시 반환하고 `thread/started` 알림을 보낸다. `turn/start`도 turn 객체를 즉시 반환하고 실제 실행 시작 때 `turn/started`가 온다. 따라서 “첫 턴 완료 후에야 스레드가 생긴다”는 가설은 맞지 않는다.

정확히 어느 SQL transaction 시점에 `threads` INSERT가 commit되는지는 공개 계약이 아니어서 단정하지 않는다. 그러나 **첫 턴 완료까지 기다리는 모델은 아니다.** `thread.updatedAt`은 resume만으로 갱신되지 않고 새 turn을 시작할 때 갱신된다고 공식 문서가 명시한다.

근거: [Codex App Server — thread/start, turn/start, updatedAt](https://learn.chatgpt.com/docs/app-server).

### `logs_2.sqlite`는 무엇인가

실제 스키마는 다음 구조의 tracing/log 저장소였다.

```text
id, ts, ts_nanos, level, target, feedback_log_body,
module_path, file, line, thread_id, process_uuid, estimated_bytes
```

- 세션 본문/정본 테이블이 아니다.
- `thread_id`는 nullable이다. app-server 초기화, config load, HTTP, telemetry 등 threadless 로그가 매우 많다.
- P2 근거로 제시된 04:45:30~04:47:30 구간을 본문 없이 집계한 결과, 두 프로세스의 26행 전부 `thread_id IS NULL`이었다. `thread/start`/`turn/start`로 분류되는 기록도 확인되지 않았다.
- 따라서 04:46의 `logs_2.sqlite-wal` mtime은 “누락된 스레드가 여기 기록 중이었다”가 아니라 “app-server/HTTP/logging 활동이 있었다”는 뜻뿐이다. 현재 확장의 창별 rate-limit probe도 이런 threadless 활동을 만들 수 있다.

세션 식별 정본으로 사용할 수 없다. 장애 진단의 보조 로그로만 유효하다.

### 프로세스와 저장소

조사 시점에 확인된 프로세스는 다음과 같았다.

- Codex 데스크톱 앱 app-server 1개
- VS Code 번들 Codex app-server 2개
- VS Code 번들 CLI: `0.146.0-alpha.9.2`
- PATH의 전역 `codex`: `0.145.0`

새로 띄운 0.146 app-server에서:

- `thread/list`: `state_5.sqlite`/rollout과 같은 지속 목록 반환
- `thread/loaded/list`: 0건
- 같은 스레드의 `status`: `notLoaded`

이는 `loaded`가 머신 전체 상태가 아니라 **그 app-server 프로세스 메모리의 상태**임을 확인한다. 공식 문서도 `thread/loaded/list`를 “currently loaded in memory”라고 정의하며, 마지막 subscriber가 사라진 뒤에도 해당 서버가 최대 30분 보유한다고 설명한다. 별도로 띄운 app-server는 다른 VS Code app-server의 live observer가 아니다.

`.codex-global-state.json`은 데스크톱 UI의 프로젝트·창·thread assignment 보조 상태를 담고 있었지만, 모든 VS Code webview의 현재 선택 스레드를 제공하는 공용 세션 정본은 아니었다. 사용자 지시대로 `~/.codex` 밖의 개인 경로는 스캔하지 않았고, 별도 정본의 증거도 찾지 못했다.

## 3. source of truth 판정

### 권장 우선순위

1. **app-server 공개 프로토콜 — 안정성 A**
   - `thread/list`, `thread/read`, `thread/turns/list`, `account/rateLimits/read`는 공개 문서가 있는 제품 계약이다.
   - 저장 목록·계정 사용량에는 가장 안정적이다.
   - 단, 새로 띄운 app-server의 runtime `status`와 `thread/loaded/list`는 그 프로세스 기준이다. 다른 VS Code 창의 app-server live 상태는 보지 못한다.
   - `thread/list` 요약만으로는 현 0.146에서 상태바에 필요한 model/effort/context token이 완전하지 않았다.

2. **rollout JSONL — 안정성 B-**
   - legacy history의 실제 persisted log이며, context token·model·effort·task lifecycle을 현재 확장이 얻을 수 있는 소스다.
   - 파일 위치와 존재는 공식 app-server 문서에서도 확인되지만, 개별 JSONL record schema는 내부 형식이라 tolerant parser와 폴백이 필요하다.
   - 현재 확장처럼 구조 필드만 증분 파싱하는 방식은 합리적이다.

3. **`state_5.sqlite` 직접 read-only — 안정성 C**
   - 빠른 색인·교차진단에는 좋다.
   - 파일명, 스키마 버전, 컬럼 의미, migration은 내부 구현이다.
   - WAL-aware `mode=ro`가 필요하고 `immutable=1`은 사용하면 안 된다. active WAL을 무시해 최신 row를 놓칠 수 있다.
   - 현재 기능의 1차 소스로 승격하지 않는다.

4. **`logs_2.sqlite` — 세션 source of truth로 부적합**
   - tracing/진단용이다. nullable `thread_id`와 프로세스 로그 때문에 세션 목록이나 activity clock으로 쓰면 오탐한다.

### 이 확장에 대한 최종 조합

- 세션 context/model/effort/lifecycle: rollout JSONL 유지
- 계정 rate limit: app-server `account/rateLimits/read`
- 창 간 동일성: extension `globalStorage` 공유 캐시
- SQLite: 향후 discovery 최적화의 optional index 후보일 뿐, 이번에는 미사용
- “현재 이 webview가 선택한 스레드”: OpenAI VS Code 확장이 공개 API를 제공하기 전에는 정확한 판정 불가

## 4. P6 답변 — ChatGPT 웹 사용량 직접 조회

### 알려진 엔드포인트

Codex의 ChatGPT usage backend는 현재 `GET https://chatgpt.com/backend-api/wham/usage` 계열로 관측된다. OpenAI Codex 저장소의 이슈와 코드 경로 설명에서도 `backend-client ... get_rate_limits -> /wham/usage`가 확인된다. 다만 이것은 **공개 웹 API 계약이 아니다.** Settings 화면의 query parameter와 응답 필드는 수시로 바뀔 수 있다.

참고: [openai/codex #10869 — `/backend-api/wham/usage`](https://github.com/openai/codex/issues/10869).

### 인증

이 PC의 `~/.codex/auth.json`은 값을 출력하지 않고 필드명만 확인했다.

```text
auth_mode = chatgpt
tokens = id_token, access_token, refresh_token, account_id
```

Codex backend 호출은 일반적으로 `Authorization: Bearer <access_token>`과 계정 선택용 ID를 사용한다. 공식 app-server 문서의 외부 토큰 모드도 `accessToken`과 `chatgptAccountId`를 한 쌍으로 받고, 401이면 refresh callback을 요구한다.

브라우저의 `__Secure-next-auth.session-token` 쿠키가 현재 Settings Usage 호출의 유일하거나 안정적인 인증 수단인지는 공식 계약에서 확인할 수 없었다. **모른다.** 쿠키 이름을 코드에 박아서는 안 된다.

### `auth.json` 재사용 가부

기술적으로 access token과 account ID로 같은 backend를 호출할 가능성은 높다. 그러나 이 확장에서 직접 읽는 구현은 권장하지 않는다.

- access/refresh token을 직접 다루게 되어 보안 경계가 커진다.
- 만료·refresh·account switch·workspace header를 재구현해야 한다.
- `auth.json` schema와 `/wham/usage` 모두 비공개 구현이다.
- 현재 app-server가 바로 그 인증·refresh·응답 정규화를 공개 프로토콜 뒤에서 처리한다.

따라서 **웹 세션/`auth.json` 직접 조회 대신 `account/rateLimits/read` 유지**가 정답이다.

### Cloudflare

Claude의 cookie 기반 `claude.ai` 호출과 동일하다고 볼 근거가 없다. 이 PC에서는 Rust app-server가 bearer 인증으로 rate limit을 정상 조회했다. 따라서 현재 경로에는 Electron `net` TLS 우회가 필요하다는 증거가 없다. 반대로 browser cookie를 흉내 내는 비공개 ChatGPT 호출은 Cloudflare·CSRF·세션 정책 변화에 노출될 수 있다.

### app-server 대비 결론

| 항목 | app-server | ChatGPT 웹 직접 호출 |
|---|---|---|
| 계약 | 공개 JSON-RPC 문서 | 비공개 backend |
| 인증 | Codex가 소유·refresh | 확장이 token/cookie 소유 |
| 응답 | `usedPercent`, window, reset 정규화 | schema drift 직접 대응 |
| 보안 | 비밀값을 확장이 읽지 않음 | `auth.json` 또는 cookie 접근 필요 |
| 추천 | **채택** | **기각** |

## 5. 변경한 파일·라인 요약

- `src/providers/codex/discovery.ts:182`
  - `normalisePath`를 export하고 extended drive/UNC, case, separator, root를 안전하게 정규화했다.
- `src/providers/codex/usageProvider.ts:30-176`
  - `codex-account-usage-v1.json` 공유 캐시를 추가했다.
  - JSON validation, future/age guard, mode `0600`, 임시 파일 후 atomic rename을 적용했다.
  - `wx` exclusive-create lock, 20초 stale lock 회수, ownership token 기반 release를 적용했다.
  - 여러 창 중 한 창만 app-server를 probe하고 나머지는 캐시를 기다리게 했다.
- `src/extension.ts:201-204`
  - `context.globalStorageUri.fsPath`를 공유 캐시 위치로 설정하고 시작 시 기존 값을 읽는다.
- `src/extension.ts:635-648`
  - 다른 extension host가 교체한 캐시를 watcher로 즉시 반영한다.
- `src/extension.ts:1845`
  - watcher 누락·sleep 이후에도 정기 세션 refresh가 캐시를 재확인한다.
- `src/extension.ts:2474-2502`
  - 공유 fetch 결과와 출처를 사용한다.
- `src/extension.ts:2537-2545`
  - live/shared account 값이 있으면 timestamp가 더 최신인 per-thread rollout snapshot이 덮어쓰지 못하게 했다.
- `README.md:65-74`, `README.ko.md:65-74`
  - 공유 캐시·잠금 동작을 동기화해 문서화했다.
- `README.md`, `README.ko.md` Known limitations
  - webview 선택 thread와 recorded cwd의 차이를 명시했다.
- `CHANGELOG.md:10,16-18,26`
  - 창 간 rate-limit 일치, 경로 정규화, UI 선택 스레드 한계를 기록했다.

## 6. 무엇을 왜 바꿨나 (before → after)

### 경로 정규화

Before:

```ts
let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
const looksWindows = /^[a-zA-Z]:/.test(s);
```

`\\?\F:\proj`가 `//?/F:/proj`가 되어 prefix 제거·case folding 모두 실패했다. 드라이브 루트 `C:\`도 `C:`로 훼손했다.

After 핵심:

```ts
if (/^\/\/\?\/UNC\//i.test(s)) {
    s = '//' + s.slice('//?/UNC/'.length);
} else if (/^\/\/\?\/[a-zA-Z]:\//.test(s)) {
    s = s.slice('//?/'.length);
}

if (s !== '/' && !/^[a-zA-Z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
const looksWindows = /^[a-zA-Z]:\//.test(s) || /^\/\/[^/]/.test(s);
```

검증 케이스: extended drive, extended UNC, 일반 UNC, `C:\`, `/`, POSIX mixed-case 경로가 전부 기대값과 일치했다.

### 창 간 account usage

Before:

```ts
codexLiveUsage = await fetchCodexRateLimits(); // 창별 메모리
return live.observedAt >= snap.observedAt ? live : snap;
```

- 창마다 app-server를 띄웠다.
- polling phase가 달랐다.
- 새 rollout record의 timestamp가 live probe보다 늦으면, 그 안의 더 오래된 account snapshot이 다시 선택될 수 있었다.

After 핵심:

```ts
const result = await fetchSharedCodexRateLimits(
    context.globalStorageUri.fsPath,
    pollIntervalMs
);

return codexLiveUsage ?? codexSnapshotFallback;
```

- `wx` lock winner 한 개만 probe한다.
- follower는 atomic cache replacement를 읽는다.
- watcher와 30초 refresh 양쪽에서 다른 창의 값을 채택한다.
- 계정 정본이 한 번 있으면 per-thread snapshot은 fallback으로만 남는다.

동시 호출 8개를 가짜 JSON-RPC app-server로 검증한 결과:

```json
{
  "spawns": 1,
  "sources": ["probe", "shared-cache", "shared-cache", "shared-cache", "shared-cache", "shared-cache", "shared-cache", "shared-cache"],
  "used": [53, 53, 53, 53, 53, 53, 53, 53],
  "cachedUsed": 53,
  "lockLeft": false
}
```

## 7. 미수정 항목과 이유

### P2 — 현재 webview 스레드 누락

세션 소스를 SQLite/app-server 목록으로 교체하지 않았다. 당시 새 thread가 실제로 없었고, 다른 app-server의 loaded 상태를 새 프로세스가 볼 수도 없기 때문이다. 전역 최신 스레드를 모든 창에 강제로 표시하면 한 창은 맞을 수 있지만, 동시에 서로 다른 스레드를 쓰는 다른 창들이 모두 틀린다.

정확한 수정에는 OpenAI VS Code 확장이 현재 webview의 selected thread ID를 공개하거나, 같은 owning app-server 연결을 공유하는 API가 필요하다.

### P3 — 오래된 workspace 세션 표시

현재 항목은 `idle 1h16m`라고 명시됐으므로 rollout parser가 이를 실행 중(active task)으로 오판한 증거는 아니다. `hideAfter` 전까지 idle session을 보이는 것은 기존 제품 기능이다.

- `updatedAt`: 공식 문서상 새 turn 시작 때 갱신. resume만으로는 갱신되지 않음.
- `recencyAt`: 목록 정렬 키로 공개됐지만 “현재 실행 중”이라는 의미는 아님.
- `has_user_event`: 이 DB의 실제 user thread에서도 0이어서 판정에 쓸 수 없음.
- `archived`: 목록 제외 필터에는 유효.
- 진짜 runtime active: owning app-server의 `status.type === 'active'` 또는 rollout의 `task_started`/`task_complete` lifecycle이 필요.

현재 확장은 후자인 rollout lifecycle을 이미 사용한다. 다른 webview의 selected thread를 모르는 상태에서 recency 기반 대체를 추가하면 다중 창 오탐이 커지므로 바꾸지 않았다.

### P4 — SQLite 세션 소스

직접 DB reader를 추가하지 않았다. source-of-truth 판정상 이득보다 schema/WAL/version 결합 위험이 컸다. 단, DB 값을 훗날 사용해도 즉시 실패하지 않도록 path normalizer는 고쳤다.

### P6 — 웹/API 직접 조회

추가하지 않았다. app-server가 더 높은 안정성과 더 작은 보안 경계를 제공한다.

### `thread_spawn_edges`

코드는 추가하지 않았다. 실제 스키마는 `parent_thread_id`, `child_thread_id PRIMARY KEY`, `status`이고 현재 0행이다. 공개 app-server도 `parentThreadId`/`ancestorThreadId` 필터와 descendant archive를 제공하므로 향후 explicit spawn tree를 만들 수 있는 구조는 맞다. 하지만 데이터 0행 상태에서 workflow viewer를 구현하면 빈 기능이 된다.

## 8. 빌드·검증 결과

### `npm run compile`

통과했다.

```text
> claude-state-bar@1.8.0 compile
> tsc -p ./

compile_exit=0
```

### `npm run lint`

실행했지만 저장소 개발 의존성 문제로 실행 자체가 실패했다.

```text
> claude-state-bar@1.8.0 lint
> eslint src --ext ts

'eslint' is not recognized as an internal or external command,
operable program or batch file.
lint_exit=1
```

`node_modules/.bin`에는 `tsc`만 있고, `package.json` devDependencies와 저장소에는 ESLint 패키지/config가 없다. 대상 파일 제한과 무관한 패키지 설치·manifest 변경은 하지 않았다. 이는 lint finding이 아니라 lint 도구 미구성이다.

### 추가 검증

- `git diff --check`: 통과 (`exit=0`)
- 실제 `state_5.sqlite`, `logs_2.sqlite`: `sqlite3 -readonly`로만 조회
- 경로 정규화 6케이스 + drive/UNC cwd match: 통과
- 공유 캐시 동시 호출 8개: spawn 1회, 값 8개 일치, lock 잔존 없음
- `npm run compile`: 최종 재실행 통과
- `git commit`, push, tag: 실행하지 않음
- `package.json` version: 변경하지 않음

## 9. 남은 리스크·확신도

### 높은 확신

- P1/P5/P7의 직접 원인은 창별 timer·메모리·spawn이다.
- rollout의 account snapshot은 session-local stale snapshot이며 live account 값을 덮으면 안 된다.
- `logs_2.sqlite`는 세션 정본이 아니다.
- 새 app-server의 `thread/loaded/list`는 다른 app-server의 live 상태를 보여주지 않는다.
- `\\?\`/extended UNC 정규화 결함과 수정 결과.
- ChatGPT 웹 직접 조회보다 공개 `account/rateLimits/read`가 적절하다.

### 중간 확신

- P2 당시 화면은 새 `sportedAppBuild` thread가 아니라 다른 cwd로 생성된 기존 thread를 표시/재개했거나, 실제 turn 시작 전 UI 상태였을 가능성이 가장 높다.
- Rust canonicalization이 DB의 extended path와 JSONL 일반 path 차이를 만든 구체적 내부 호출 경로. 플랫폼 동작과 관측값은 일치하지만 Codex 내부 해당 호출부까지 추적하지는 않았다.

### 낮은 확신/모름

- 04:46 당시 OpenAI webview가 선택한 정확한 thread ID. 사후 지속 데이터만으로 복원할 수 없다.
- ChatGPT Settings Usage 화면이 현재 browser cookie와 bearer token 중 어떤 조합을 최종 사용하며, cookie 이름이 장기적으로 무엇인지. 공개 계약이 아니다.
- `recency_at_ms`가 모든 제품 surface에서 갱신되는 정확한 내부 이벤트 집합. 정렬 키라는 공개 사실 이상은 단정하지 않는다.

### 버전·운영 리스크

- PATH의 `codex`는 0.145.0이고 IDE 번들은 0.146.0-alpha.9.2다. rate-limit 메서드는 양쪽에 존재하지만, 향후 프로토콜 drift 시 fallback으로 내려간다. 다른 확장의 private binary 경로에 결합하는 수정은 더 취약해 적용하지 않았다.
- cache는 같은 VS Code profile의 `globalStorage` 범위다. 다른 VS Code profile/portable user-data-dir까지 공유하지 않는다.
- 계정을 바꾼 직후에는 다음 probe 전까지 직전 계정 snapshot이 잠시 보일 수 있다. cache에는 account ID나 token을 넣지 않아 비밀값 노출을 피했다.
- 직접 SQLite를 도입한다면 반드시 URI `mode=ro`, 짧은 query, WAL-aware connection을 사용해야 한다. `immutable=1`은 active WAL을 누락할 수 있다.
- Extension Development Host 다중 창 실측은 아직 하지 않았다. watcher 전파는 F5로 확인해야 한다.

## 10. Claude가 추가로 확인해야 할 것

1. Extension Development Host를 3개 띄워 같은 로컬 profile에서 동시에 시작했을 때 Output에 `probe` 1회와 나머지 `shared-cache`가 찍히는지 확인한다.
2. 한 창에서 rate limit이 바뀐 뒤 다른 창 상태바가 cache watcher로 수초 내 같은 값이 되는지 확인한다.
3. P2를 정확히 닫으려면 다음 재현 때 각 창에서 다음을 동시에 기록한다.
   - OpenAI Codex Output의 thread ID와 `thread/start`/`thread/resume` 여부
   - `state_5.sqlite`의 해당 ID, cwd, updated/recency 시각
   - rollout `session_meta.cwd`와 turn start 시각
   - 새 thread인지 기존 thread를 다른 창에서 연 것인지
4. lint를 release gate로 유지하려면 별도 승인 후 ESLint 패키지와 config를 저장소에 복구한다. 이번 수정 범위에는 포함하지 않았다.

비밀 자료(`auth.json` 값, cookie, API key)는 추가로 필요하지 않다.

## 11. 로컬 설치 후 현장 재현 추가 결과

2026-08-01 로컬 VSIX 설치 후 다중 창에서 다음을 추가로 확인·수정했다.

1. app-server의 `usedPercent`는 소진율인데 상태바가 이를 그대로 출력해 ChatGPT 웹의 잔여율과 반대로 보였다. 원본/캐시는 소진율로 보존하고 UI에서만 `100 - usedPercent`로 변환한다.
2. app-server epoch seconds를 milliseconds로 정규화해 cache에 저장한 뒤, 다른 창이 cache를 읽으며 다시 `× 1000`했다. 이 때문에 정상 `4d 10h`가 `2064963d 23h`처럼 표시됐다. app-server raw window와 normalized cache window 파서를 분리했고 `windowMinutes` 유실도 함께 수정했다.
3. Sported 창은 공유 account snapshot을 정상 수신했지만 workspace에 매칭된 실제 Codex session이 없어 계정 잔여량까지 숨겼다. 선택 thread를 추측하지 않고, session이 없을 때 account-only `⬢ Codex` fallback을 표시하도록 수정했다.
4. standalone Claude plan item의 표시 조건도 모든 provider의 session 존재 여부를 보던 오류가 있었다. Claude/Codex 각각 실제 session 존재 여부를 판단하도록 분리했다.
5. Claude plan 30초 polling은 05:29:50, 05:30:18, 05:30:48, 05:31:18, 05:31:48에 연속 성공했다. 화면의 26%가 유지된 것은 API가 매번 같은 정수 값을 반환했기 때문이며 timer 결함은 재현되지 않았다.
