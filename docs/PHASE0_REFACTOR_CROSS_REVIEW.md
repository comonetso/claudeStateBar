# Phase 0 동작보존 리팩터링 교차검증 보고서

> 대상 프로젝트: `claude-state-bar` VS Code 확장  
> 검토 기준 커밋: `ce1933d` (`v1.7.43`)  
> 검토 대상: 미커밋 `extension.ts` 변경 및 `src/core/`, `src/providers/` 신규 모듈  
> 검토일: 2026-07-22  
> 검토 성격: 읽기 중심 교차검증. 소스 구현은 변경하지 않음

## 1. 결론

현재까지 추출된 13개 모듈은 **정상 활성 상태의 주요 동작을 거의 그대로 보존한다.**

`ce1933d`의 기존 함수와 신규 모듈의 함수를 TypeScript AST 기준으로 비교한 결과, 의도적으로 의존성 주입 방식이 바뀐 다음 두 함수 외에는 추출된 동일 이름 함수의 본문이 원본과 일치했다.

- `playSoundFile()`
  - 원본 전역 `extensionRunsOnRemote` 직접 참조
  - 신규 `runtimeContext.getRunsOnRemote()` 참조
- `tickStageItem()`
  - 원본 `planLang()` 직접 참조
  - 신규 `initStageIndicator()`로 주입된 `isKorean()` 콜백 참조

다만 Phase 0 완료 전에 다음 두 항목을 확인하거나 수정해야 한다.

1. **중간 위험:** `disposeStage()` 이후 늦게 끝난 비동기 refresh가 상태바 아이템을 다시 생성할 수 있다.
2. **낮은 위험/범위 이탈:** `package.json` 버전만 `1.7.46`으로 변경되어 baseline 및 Changelog와 불일치한다.

따라서 현재 판정은 다음과 같다.

> **stage dispose 수명주기 위험을 정리하면, 현재 13개 모듈 추출분은 Phase 0 동작보존 리팩터링으로 승인 가능한 상태다.**

---

## 2. 검토 범위

### 2.1 변경 규모

- 원본 `src/extension.ts`: 약 3,278줄
- 현재 `src/extension.ts`: 약 2,459줄
- 신규 추출 모듈: 13개
- 기준 diff:
  - `package.json`: 버전 1줄 변경
  - `src/extension.ts`: import 추가 및 기존 구현 제거/대체
  - `src/core/`, `src/providers/`: 신규 파일이므로 일반 `git diff`에는 나타나지 않고 untracked 파일로 확인

### 2.2 추출 모듈

#### `src/core/`

- `fs.ts`
- `logger.ts`
- `format.ts`
- `displayName.ts`
- `textFormat.ts`
- `sound.ts`
- `runtimeContext.ts`
- `beepGate.ts`
- `stageIndicator.ts`

#### `src/providers/claude/`

- `tokenParser.ts`
- `pathCodec.ts`
- `modelLimits.ts`
- `display.ts`

### 2.3 집중 검증 항목

- 전역 상태 공유 단절 여부
- `activate()` 초기화 순서
- 타이머와 disposable 소유권 이전
- 신규 모듈의 `extension.ts` 역참조 및 import 순환
- `beepGate` 상태 9종의 세션 소멸 GC
- `stageIndicator` 언어 콜백이 첫 tick 전에 주입되는지
- 남아 있는 plan usage와 block primer 순환의 안전한 분리 방법
- primer 검증 루프의 `refreshPlanUsage()` 직후 `lastUsage` 동기 읽기 결합

---

## 3. 발견사항

## 3.1 중간 위험: dispose 후 stage 상태바 재생성 가능성

### 관련 위치

- `src/core/stageIndicator.ts:31-35`
  - `ensureStageItem()`이 `stageStatusItem === null`이면 새 아이템을 생성한다.
- `src/core/stageIndicator.ts:40-55`
  - `updateStageItem()`이 항상 `ensureStageItem()`을 호출한다.
- `src/core/stageIndicator.ts:81-87`
  - `disposeStage()`가 아이템을 dispose한 후 `stageStatusItem = null`로 설정한다.
- `src/extension.ts:651`, `src/extension.ts:703`
  - context disposal 및 `deactivate()`에서 `disposeStage()`를 호출한다.
- `src/extension.ts:2067`
  - 비동기 `refreshAllSessions()` 마지막 구간에서 `updateStageItem()`을 호출한다.

### 원인

`refreshAllSessions()`는 파일 시스템을 여러 차례 await하는 비동기 함수다. extension이 비활성화될 때 이미 진행 중인 refresh가 자동으로 취소되지는 않는다.

현재 `disposeStage()`는 다음 상태를 만든다.

```ts
stageStatusItem?.dispose();
stageStatusItem = null;
```

이후 늦게 끝난 refresh가 `updateStageItem()`을 호출하면 `ensureStageItem()`은 `null`을 보고 새 StatusBarItem을 생성한다.

### 재현 시나리오

1. Remote-SSH 또는 세션 파일이 많은 환경에서 `refreshAllSessions()`가 시작된다.
2. `findActiveSessions()`와 workflow scan이 끝나기 전에 창 reload, extension disable 또는 extension 교체가 발생한다.
3. dispose 경로에서 `disposeStage()`가 실행된다.
4. 기존 비동기 refresh continuation이 나중에 재개된다.
5. `updateStageItem()` → `ensureStageItem()`이 새 StatusBarItem을 생성한다.
6. 새 아이템은 이미 종료된 lifecycle 뒤에 생성되므로 이를 다시 정리할 소유자가 없다.

### baseline과의 차이

`ce1933d`에서는 stage item을 dispose했지만 참조를 `null`로 바꾸지 않았다. 따라서 비활성화 후 늦은 refresh가 새 아이템을 생성하는 경로는 없었다.

원본 방식 역시 disposed 객체에 대한 늦은 접근이 완벽하게 안전하다고 볼 수는 없지만, **새 아이템을 재생성하여 누수시키는 동작은 이번 리팩터링에서 추가된 차이**다.

### 권장 수정

Phase 0 제약에 따라 refresh 취소 토큰이나 새 timeout 취소 핸들은 추가하지 않는다. 대신 stage lifecycle guard만 둔다.

```ts
let stageDisposed = false;

export function initStageIndicator(isKoreanFn: () => boolean): void {
    isKorean = isKoreanFn;
    stageDisposed = false;
}

export function updateStageItem(active: StageInput | null): void {
    if (stageDisposed) return;
    // 기존 로직 그대로
}

export function disposeStage(): void {
    stageDisposed = true;
    if (stageTickInterval) {
        clearInterval(stageTickInterval);
        stageTickInterval = null;
    }
    stageStatusItem?.dispose();
    stageStatusItem = null;
}
```

이 방식은 정상 활성 상태의 tick, tooltip, 표시 조건을 바꾸지 않고 비활성화 이후 재생성만 막는다.

## 3.2 낮은 위험/범위 이탈: 버전 메타데이터 불일치

### 관련 위치

- `package.json:5`
  - 현재 `"version": "1.7.46"`
- `CHANGELOG.md:3`
  - 최신 항목 `1.7.43`
- baseline `ce1933d`
  - package 버전 `1.7.43`

### 재현 시나리오

1. 현재 상태로 VSIX를 패키징한다.
2. 결과물이 `1.7.46` 릴리스로 인식된다.
3. Changelog와 baseline은 `1.7.43`이므로 릴리스 메타데이터가 불일치한다.

### 판정

런타임 로직 파손은 아니다. 그러나 순수 동작보존 리팩터링 diff에는 포함되지 않는 것이 안전하다.

- 의도적인 다음 릴리스 준비라면 Changelog/릴리스 계획과 함께 관리한다.
- 의도하지 않은 변경이라면 Phase 0 커밋에서는 `1.7.43`으로 되돌린다.

---

## 4. 동작보존 검증 상세

## 4.1 순수 함수와 parser 추출

다음 함수들은 baseline 함수 본문과 신규 모듈 함수 본문이 AST 기준으로 일치했다.

### core

- `readTextFile`
- `log`
- `formatIdleDuration`
- `formatTokens`
- `extractLastSyllable`
- `getShortName`
- `serializeResultObject`
- `summarizeResultFull`
- `playBeep`
- `getSoundPath`
- `getSoundGain`
- `amplifyWavToTemp`
- `playCompletionSound`
- `playWorkflowCompleteSound`
- `playQuestionSound`
- `ensureStageItem`
- `updateStageItem`

### Claude provider

- `getLatestTokenCount`
- `encodeWorkspacePath`
- `getWorkspaceProjectDirs`
- `projectDirMatchesFolder`
- `decodeProjectPath`
- `getContextLimitForModel`
- `getShortModelName`
- `getEffortLabel`

함수의 export 여부, 주석, 타입 위치는 달라졌지만 런타임 본문은 동일하다.

## 4.2 logger 공유 상태

### 신규 구조

```text
extension.ts
  ├─ setLogChannel(outputChannel)
  ├─ log(...)
  └─ core/sound.ts ──> core/logger.ts의 같은 log(...)
```

### 검증 결과

- `src/extension.ts:218`에서 채널 생성
- `src/extension.ts:219`에서 `setLogChannel()` 호출
- `src/extension.ts:221`에서 첫 `log()` 호출
- 명령 등록 및 초기 refresh는 그 이후

따라서 주입 전 로그 손실은 없다.

TypeScript CommonJS/Node 모듈 캐시에서 `extension.ts`와 `sound.ts`는 동일한 `core/logger` 인스턴스를 사용하므로 상태가 복제되지 않는다.

채널이 null일 때 no-op인 동작도 원본의 optional chaining 동작과 동일하다.

## 4.3 runtimeContext 공유 상태

### 검증 결과

- `src/extension.ts:223`에서 `context.extensionUri.scheme` 평가
- `src/extension.ts:224`에서 `setRunsOnRemote()` 호출
- 최초 session refresh는 `src/extension.ts:599`
- sound 명령도 activation 이후에만 실행 가능

따라서 sound 모듈이 remote 여부의 기본값 `false`를 잘못 사용하는 정상 실행 경로는 없다.

## 4.4 import 순환

현재 신규 모듈 import 그래프는 다음과 같다.

```text
extension.ts
 ├─ core/fs
 ├─ core/logger
 ├─ core/format
 ├─ core/displayName
 ├─ core/textFormat
 ├─ core/runtimeContext
 ├─ core/beepGate
 ├─ core/stageIndicator
 ├─ core/sound
 │   ├─ core/logger
 │   └─ core/runtimeContext
 └─ providers/claude/tokenParser
     └─ core/fs
```

`core → extension` 또는 `providers → extension` import는 없다.

`stageIndicator`가 `planLang`을 콜백으로 받는 것은 런타임 의존성 주입이며 모듈 import 순환이 아니다.

## 4.5 beepGate 상태 9종과 GC

### 세션별 상태 8종

1. `alertedSessions`
2. `lastKnownEndTurnAt`
3. `pendingCompletion`
4. `lastKnownQuestionAt`
5. `pendingQuestion`
6. `alertedStuckToolUseAt`
7. `alertedWorkflowDone`
8. `seenRunningWorkflowKeys`

`src/extension.ts:2038-2058`의 세션 제거 경로에서 모두 정리된다.

- 단일 session key Map은 직접 `delete(sessionFile)`
- workflow key는 `${sessionFile}|` prefix로 순회 삭제
- pending timer는 `clearTimeout()` 후 Map에서 삭제

### runtime 전체 상태 1종

9. `firstScan`

`firstScan`은 세션별 상태가 아니라 extension runtime 전체의 startup beep suppression flag다. 따라서 세션 소멸 GC 대상이 아니다.

### 판정

세션 GC 누락은 발견하지 못했다.

## 4.6 stageIndicator 첫 tick 언어 주입

### 현재 호출 순서

1. `src/extension.ts:599`
   - `refreshAllSessions()` 호출
2. `src/extension.ts:1675`
   - `await findActiveSessions()`에서 현재 JS 호출 스택 양보
3. `src/extension.ts:631`
   - `initStageIndicator(() => planLang() === 'ko')`
4. `src/extension.ts:632`
   - `startStageTicker()`
5. `src/extension.ts:2067`
   - 비동기 refresh가 재개된 뒤 `updateStageItem()`

JavaScript의 `await`는 이미 완료된 Promise여도 continuation을 microtask로 넘긴다. 따라서 첫 refresh의 `updateStageItem()`보다 언어 콜백 주입이 먼저 완료된다.

또한 1초 ticker도 `initStageIndicator()` 뒤에 시작한다.

### 판정

- 첫 tick 전 언어 주입: 안전
- 첫 tooltip이 영어 기본값으로 표시될 위험: 현재 호출 순서에서는 없음

향후 리팩터링 안전성을 높이기 위해 `initStageIndicator()`를 최초 `refreshAllSessions()`보다 위로 옮길 수는 있지만, 현재 동작을 수정하기 위한 필수 조치는 아니다.

## 4.7 타이머와 disposable 소유권

### 보존된 부분

- 기존 1초 stage interval이 `startStageTicker()`로 이동
- 기존 context dispose와 `deactivate()` 양쪽 cleanup이 `disposeStage()`로 통합
- `disposeStage()`는 interval clear와 status item dispose를 수행
- `pendingCompletion`, `pendingQuestion` timer cleanup은 기존 위치와 의미를 유지

### 주의할 부분

- `startStageTicker()`에는 중복 시작 방지 guard가 없다.
- 그러나 baseline도 activate가 중복 실행되면 기존 interval handle을 덮어쓰는 구조였으므로 새로운 회귀는 아니다.
- Phase 0에서 별도 mutex, 취소 토큰, 추가 timer handle을 도입하지 않는다.
- 새로 발견된 문제는 3.1의 dispose 뒤 재생성 경로뿐이다.

---

## 5. 남은 순환 구간의 현재 호출 그래프

현재 plan usage 및 primer 호출 흐름은 다음과 같다.

```text
refreshPlanUsage
 ├─ fetchUsage
 ├─ lastUsage 갱신
 ├─ await detectBlockClose
 │   └─ primeNewBlock                // await하지 않음
 │       └─ blockPrimer.firePrimer
 │           └─ handlePrimerOutcome // callback, void
 │               └─ verification loop
 │                   ├─ 15초 대기
 │                   ├─ await refreshPlanUsage
 │                   └─ lastUsage를 즉시 동기 읽기
 └─ refreshAllSessions               // await하지 않음
```

핵심 순환은 다음 두 종류다.

1. plan usage → session UI refresh
2. plan usage → primer → plan usage verification

이 순환 자체는 런타임 workflow로 필요하다. 제거해야 하는 것은 **모듈 import 순환**이지, 필요한 런타임 callback 흐름이 아니다.

---

## 6. 권장 모듈 구조

```text
src/extension.ts                         composition root
src/providers/claude/sessionOrchestrator.ts
src/providers/claude/planUsageController.ts
src/providers/claude/blockPrimerController.ts
src/providers/claude/types.ts            선택 사항
```

의존 방향:

```text
extension.ts
 ├─ sessionOrchestrator
 ├─ planUsageController
 └─ blockPrimerController
```

세 controller는 서로 직접 import하지 않는다. 필요한 상호 호출은 `extension.ts`가 callback으로 연결한다.

---

## 7. 안전한 분리 순서

## 7.1 1단계: blockPrimer 흐름 추출

먼저 다음을 `blockPrimerController.ts`로 함께 이동한다.

- `detectBlockClose`
- `primeNewBlock`
- `handlePrimerOutcome`
- `disableAutoStart`
- `notifyTelegram`
- `lastBlockPollAt`
- `WAKE_GAP_MS`
- `PRIMER_VERIFY_INTERVAL_MS`
- `PRIMER_VERIFY_TRIES`
- `BLOCK_OPEN_MAX_MS`

이 함수들은 하나의 primer lifecycle을 구성하므로 따로따로 분리하는 것보다 같은 controller가 소유하는 편이 안전하다.

### 권장 dependency port

```ts
export interface BlockPrimerDeps {
    refreshPlanUsage(): Promise<void>;
    getLastUsage(): NormalizedUsage | null;
    translate(key: string, ...args: Array<string | number>): string;
    log(message: string): void;
    showWarning(message: string): void;
}
```

`credentials`, `telegram`, 기존 `blockPrimer`는 controller에서 직접 import해도 `extension.ts` 역참조가 생기지 않는다. 테스트 용이성을 우선하면 이들도 dependency로 주입한다.

controller factory는 생성 시 I/O, timer 시작 또는 primer fire를 수행하면 안 된다.

## 7.2 2단계: primer verification 타이밍 보존

현재 검증 루프의 중요한 시간 결합은 다음 세 줄이다.

```ts
await new Promise((r) => setTimeout(r, PRIMER_VERIFY_INTERVAL_MS));
await refreshPlanUsage();
const after = lastUsage?.sessionResetAt;
```

추출 뒤에도 정확히 다음처럼 유지해야 한다.

```ts
await new Promise((r) => setTimeout(r, PRIMER_VERIFY_INTERVAL_MS));
await deps.refreshPlanUsage();
const after = deps.getLastUsage()?.sessionResetAt;
```

### 금지할 변경

```ts
void deps.refreshPlanUsage();
```

- refresh 완료 전 stale `lastUsage`를 읽게 된다.

```ts
emit('refreshRequested');
```

- 일반 EventEmitter는 async listener 완료를 기다리지 않는다.

```ts
await deps.refreshPlanUsage();
await Promise.resolve();
const after = deps.getLastUsage();
```

- refresh 완료와 상태 읽기 사이에 불필요한 scheduling point가 생긴다.

```ts
const usage = await deps.refreshPlanUsage();
const after = usage.sessionResetAt;
```

- 현재 코드는 refresh 자신이 반환한 snapshot이 아니라 refresh 종료 시점의 live `lastUsage`를 읽는다.
- 동시 refresh가 존재할 때 의미가 달라질 수 있으므로 Phase 0에서는 피한다.

### 핵심 원칙

> `await refreshPlanUsage()`가 resolve된 동일 continuation에서, 추가 await 없이 live state getter를 즉시 읽는다.

기존 익명 `setTimeout`은 그대로 유지하고 별도 취소 핸들을 추가하지 않는다.

## 7.3 3단계: refreshPlanUsage controller 추출

### controller 소유 상태

```ts
export type PlanStatus =
    | 'unconfigured'
    | 'ok'
    | 'auth_expired'
    | 'blocked'
    | 'error';

export interface PlanState {
    lastUsage: NormalizedUsage | null;
    status: PlanStatus;
    lastPollDiag: string;
}
```

### controller API

```ts
export interface PlanUsageController {
    refresh(): Promise<void>;
    getLastUsage(): NormalizedUsage | null;
    getState(): Readonly<PlanState>;
}
```

### dependency port

```ts
export interface PlanUsageDeps {
    detectBlockClose(usage: NormalizedUsage): Promise<void>;
    onStateChanged(): void;
    translate(key: string, ...args: Array<string | number>): string;
}
```

### 반드시 보존할 호출 의미

- `detectBlockClose()`는 현재처럼 await한다.
- `refreshAllSessions()`에 해당하는 `onStateChanged()`는 await하지 않는다.
- unconfigured 조기 반환 전에도 session UI refresh를 요청한다.
- try/catch 종료 뒤에도 session UI refresh를 요청한다.
- manual refresh, interval refresh, primer verification refresh의 중첩 가능성을 유지한다.

다음과 같은 새 제어는 Phase 0에서 추가하지 않는다.

- `isRefreshing`
- mutex
- debounce
- latest-only queue
- 이전 refresh 취소

## 7.4 4단계: refreshAllSessions를 마지막에 추출

`refreshAllSessions()`는 UI, beep, plan state, workflow scan, stage update가 모두 얽힌 가장 큰 orchestration 함수다. 따라서 primer와 plan controller의 경계가 먼저 안정된 다음 마지막으로 이동하는 것이 안전하다.

### 초기 dependency port 예시

```ts
export interface SessionOrchestratorDeps {
    findActiveSessions(): Promise<SessionInfo[]>;

    getPlanTextSuffix(compact: boolean): string;
    getPlanTooltipBlock(): string;
    updatePlanFallback(noRealSessions: boolean): void;

    findWorkflowsForSession(sessionFile: string): Promise<WorkflowInfo[]>;
    getTrackedSessionFile(): string | null;
    pushWorkflows(workflows: WorkflowInfo[]): void;
}
```

이미 분리된 다음 모듈은 직접 import해도 된다.

- `core/beepGate`
- `core/sound`
- `core/format`
- `core/displayName`
- `core/stageIndicator`
- `providers/claude/display`

### 이동 시 보존할 순서

1. 함수 입구에서 first-scan flag 소비
2. active sessions 탐색
3. status bar item 생성/갱신
4. threshold/completion/question/stuck-tool beep gate 처리
5. workflow completion 처리
6. 사라진 session item 및 beep 상태 GC
7. plan fallback 갱신
8. stage 갱신
9. workflow panel push

### 금지할 변경

- refresh 호출 직렬화
- 기존 fire-and-forget 호출을 await로 변경
- session scan과 workflow scan 병렬화
- GC를 별도 지연 이벤트로 이동
- workflow cache 재사용 순서 변경
- first-scan flag 소비 시점을 `findActiveSessions()` 이후로 이동

이 변경들은 성능 개선처럼 보일 수 있지만 동시 호출과 beep timing을 바꾸므로 Phase 0 범위를 벗어난다.

## 7.5 5단계: extension.ts에서 조립

```ts
const sessions = createSessionOrchestrator({
    getPlanTextSuffix: compact => planView.textSuffix(compact),
    getPlanTooltipBlock: () => planView.tooltipBlock(),
    updatePlanFallback: noSessions => planView.updateFallback(noSessions),
    // 나머지 dependency
});

let plan!: PlanUsageController;

const primer = createBlockPrimerController({
    refreshPlanUsage: () => plan.refresh(),
    getLastUsage: () => plan.getLastUsage(),
    translate: planT,
    log,
    showWarning: message => {
        void vscode.window.showWarningMessage(message);
    }
});

plan = createPlanUsageController({
    detectBlockClose: usage => primer.detectBlockClose(usage),
    onStateChanged: () => {
        void sessions.refresh();
    },
    translate: planT
});

// 모든 callback wiring이 끝난 후 현재 activate 순서대로 시작한다.
void sessions.refresh();
void plan.refresh();
```

주의할 점:

- factory 생성 중 callback을 호출하지 않는다.
- `plan` 할당 전에 `primer.refreshPlanUsage()`가 실행되지 않도록 한다.
- interval 등록과 최초 refresh는 모든 wiring 완료 뒤 수행한다.
- runtime callback 고리는 허용하지만 controller끼리 직접 import하지 않는다.

---

## 8. 검증 결과

### 통과

```text
npx tsc --noEmit
```

- 결과: 통과
- TypeScript type/import 오류 없음
- 빌드 산출물을 쓰지 않는 방식으로 확인

### 실행 불가

```text
npm run lint
```

결과:

```text
'eslint' is not recognized as an internal or external command
```

이는 현재 작업 폴더에 ESLint 실행 파일이 없는 환경 문제다. 리팩터링 코드의 lint 오류로 판정할 수 없다.

### 자동 테스트

프로젝트에는 자동화된 runtime 테스트가 없다. 실제 VS Code Extension Development Host 테스트가 필요하다.

---

## 9. 권장 수동 회귀 테스트

## 9.1 activation 및 언어

- 한국어 설정으로 Extension Development Host 시작
- 첫 stage tooltip이 한국어인지 확인
- 영어로 변경 후 열린 stage tooltip이 다음 refresh/tick에 영어로 바뀌는지 확인
- 첫 scan에서 기존 completion/question sound가 울리지 않는지 확인

## 9.2 sound/runtimeContext

- 로컬 Windows에서 warning/danger/completion/question/workflow preview 실행
- Remote-SSH workspace에서 extension이 UI host로 실행될 때 로컬 사운드가 나는지 확인
- 실제 extension process가 remote host에서 실행되는 조건에서는 sound가 skip되는지 로그 확인

## 9.3 beepGate 및 GC

- warning threshold 한 번 통과 시 한 번만 beep
- danger threshold 한 번 통과 시 한 번만 beep
- context reset 후 다음 threshold에서 다시 beep
- completion debounce 중 새 user/tool activity가 들어오면 pending beep가 취소되는지 확인
- session이 hideAfter로 사라진 뒤 Map/Set 크기가 줄어드는지 debugger로 확인
- workflow running → done에서 한 번만 beep

## 9.4 stage lifecycle

- 인위적으로 `findActiveSessions()` 또는 filesystem read를 지연
- refresh 진행 중 extension disable/reload
- dispose 뒤 `createStatusBarItem()`이 다시 호출되지 않는지 확인
- 이 테스트는 3.1 수정 후 반드시 수행

## 9.5 primer timing

- mock 또는 진단 로그로 verification 각 반복의 순서를 확인

```text
delay 완료
→ refreshPlanUsage 시작
→ fetchUsage 완료
→ lastUsage 갱신
→ detectBlockClose 완료
→ refreshPlanUsage resolve
→ 같은 continuation에서 lastUsage.sessionResetAt 읽기
```

- `primer-verified`와 `primer-unverified` 판정이 baseline과 같은 resetAt 값으로 발생하는지 비교

---

## 10. Phase 0 완료 체크리스트

- [ ] `disposeStage()` 사후 재생성 위험 처리
- [ ] `package.json`의 `1.7.46`이 의도된 것인지 확인
- [x] 추출 함수 본문 baseline 대조
- [x] logger 주입 순서 확인
- [x] runtimeContext 주입 순서 확인
- [x] core/provider → extension 역참조 없음
- [x] beepGate 세션 상태 GC 확인
- [x] first-scan이 runtime 상태임을 확인
- [x] stage 언어 콜백이 첫 tick 전에 주입됨을 확인
- [x] `npx tsc --noEmit` 통과
- [ ] ESLint 실행 환경 복구 후 `npm run lint`
- [ ] Extension Development Host에서 수동 회귀 테스트
- [ ] primer 분리 시 `await refresh → 즉시 live state read` 순서 보존
- [ ] refresh controller에 mutex/debounce/cancellation을 추가하지 않음

---

## 11. 최종 승인 기준

다음 조건을 만족하면 현재 추출분을 Phase 0 동작보존 리팩터링으로 승인할 수 있다.

1. stage dispose 이후 늦은 refresh가 새 StatusBarItem을 만들지 않는다.
2. package 버전 변경이 의도된 릴리스 작업인지 명확히 분리한다.
3. Extension Development Host에서 activation, sound, beep gate, stage, workflow 표시가 baseline과 동일하다.
4. 남은 controller 분리 과정에서 concurrency 제어, timer cancellation, 새로운 scheduling point를 추가하지 않는다.
5. primer verification은 `await refreshPlanUsage()` 직후 live `lastUsage`를 동기적으로 읽는다.

