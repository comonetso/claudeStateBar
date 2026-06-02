# 2026-06-02 세션 로그 part2 — 완료 비프 무음 근본원인(stop_hook 오염) 규명·수정 + 질문비프 첫질문 무음 수정 + 워크플로우 빈상태 패널

> **세션 성격**: /start 이어받기(v1.7.7) → 워크플로우 퀵픽 빈상태 표시 → 완료 비프 "전혀 안 울림" 정밀분석(워크플로우 5마리) → 근본원인=stop_hook 오염 확정 → lastActivityAt 도입 수정 → 케이스별 실기기 테스트(Opus/Sonnet) → 질문비프 첫질문 무음 버그 발견·수정 → 워크플로우 없음 클릭 시 패널 열기
> **컨텍스트 시작**: /start로 v1.7.7 안정 상태 이어받기. part1(같은 날) §9 미해결의 "비프/좀비 실기기 검증 미완"을 사용자가 비프 무음 증상으로 제기
> **컨텍스트 종료**: 정상 종료 (사용자 완전종료 + 위키 박제 선택)
> **모드**: 완전종료
> **커밋 범위**: 이번 세션에서 생성 예정 (v1.7.10 + 세션로그)

---

## 1. 작업 흐름 (시간순)

### 1-1. 서브에이전트(워크플로우) 패널 질의응답
**배경**: 사용자가 워크플로우 뷰어 동작 관련 2가지 질문.
**처리/결과**:
- Q "서브에이전트 없으면 퀵픽에 안 뜨나?" → 맞음. [src/extension.ts](src/extension.ts) `showSessionMenu`의 `workflows.length > 0` 조건부.
- Q "리눅스/SSH 경로 처리?" → Claude Code는 **접속한(작업 중인) 환경의 홈** `~/.claude/`에 기록. 확장은 `extensionKind:["ui"]`라 항상 로컬 실행 → 로컬 `~/.claude`만 읽음. Remote-SSH 터미널에서 Claude Code 돌리면 워크플로우가 서버에 있어 확장 패널엔 안 보임(불일치).
- 설명이 장황·혼란스럽다는 사용자 지적 다회 → "실행한 머신"이 아니라 "접속한 홈"으로 표현 정정. (시행착오 3-1)

### 1-2. 워크플로우 빈상태 표시 (UX)
**요구**: 워크플로우 없어도 퀵픽에 항목이 떠야 "기능이 깨졌나" 오해 안 함.
**처리**: `showSessionMenu`에서 `workflows.length > 0`이면 기존 표시, else "진행 중인 워크플로우 없음" 항목 추가.
**결과**: 컴파일 통과. (이후 1-7에서 클릭 동작 보강)

### 1-3. 완료 비프 "전혀 안 울림" 정밀분석 (워크플로우 5마리)
**배경**: part1에서 비프 오발 막으려 수정1·2 넣었는데, 이번엔 **아예 안 울림**. 사용자 "너무 보수적이었다, 정밀분석하고 안 되면 원복도".
**처리**:
- 스카우트(직접): 실제 세션 JSONL의 완료 시점 게이트를 PowerShell로 평가 → 완료 세션 5개 전부 `wouldBeep=true`(정적으론 울려야 정상). 모순 발견 → 런타임 타이밍 의심.
- `log()`는 OutputChannel만(디스크 로그 없음) 확인.
- 워크플로우 `beep-silent-diagnosis`(4가설 병렬 + 종합, 한국어 강제) 실행 — 5마리, 19분, 27.8만 토큰.
**결과**: 근본원인 확정 (4-1).

### 1-4. 비프 수정 — lastActivityAt 도입 (v1.7.8)
**처리**: 비프 게이트의 `lastActivity` 출처를 `session.lastUpdated`(=lastRealTimestamp, stop_hook 포함) → **비프 전용 `lastActivityAt`(assistant|user 엔트리만)**으로 교체. 7곳 변경(인터페이스 2 + 지역변수 + forward pass + return + findActiveSessions 2 + 완료비프 + 질문비프). `lastRealTimestamp`(idle/정렬/툴팁)는 미변경.
**결과**: 컴파일 통과. 직접 검증(같은 세션): 수정 전 정상발동 0/13 → 수정 후 11/13. v1.7.8 빌드.

### 1-5. 케이스별 실기기 테스트 (1차)
- 케이스1 완료음(자리비움): ✅ 통과
- 케이스2 질문음: ❌ 안 들림 → 1-6으로

### 1-6. 질문 비프 첫질문 무음 버그 발견·수정 (v1.7.9)
**발견**: 케이스2 질문음 무음. 실데이터 확인 → AskUserQuestion(8번 tool_use) → 9초 후 user 답변(settle cancel 아님). 코드 정독 → 질문비프 `if(prev===undefined){ baseline만 }` (line 2058). 리로드로 `lastKnownQuestionAt` 비었고 세션 첫 질문이 prev===undefined에 걸려 무음.
**처리**: 가드 `!suppressBeep` 풀고 → `suppressBeep`(첫 스캔)일 때만 baseline, 그 외 `prev===undefined || curr>prev`를 새 질문으로 보고 울림. 완료비프는 미변경(빈번해서 정상).
**결과**: v1.7.9 빌드. 재테스트 케이스2 ✅, 연속 질문 ✅.

### 1-7. 워크플로우 없음 클릭 시 패널 열기 (v1.7.10)
**배경**: 빈상태 항목(action:undefined) 클릭 시 메뉴만 닫히고 상태바 호버 툴팁이 떠 사용자 혼란("이게 왜 뜨지").
**처리**: 빈 항목 `action: undefined → 'workflows'`. [src/workflowPanel.ts](src/workflowPanel.ts)는 이미 빈 목록 시 "이 세션에 아직 워크플로우가 없습니다" 표시(line 170-173) → 코드 변경 불필요.
**결과**: v1.7.10 빌드.

### 1-8. 케이스별 실기기 테스트 (2차, 완료)
- 케이스1 완료음 ✅ / 케이스2 질문음 ✅(수정후) / 케이스3 연속대화 억제 ✅ / 케이스4 thinking 완료 1회 ✅
- **Sonnet 전환 테스트**: thinking 과정이 화면에 보이는데도 중간 오발 없이 완료음 1회. ✅
- 컨텍스트 77% 경고음: 정상(Opus 1M→Sonnet 200K 전환 시 오버, 당연한 동작).

---

## 2. 의사결정 로그

| # | 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|---|
| 1 | 원복 대신 lastActivityAt 도입 | 원복 시 thinking 과다 2.07배 재발(워크플로우 실측) | 완전원복 / settle 임계 상향 | 변경 7곳이나 수정1·2 유지하며 균형 |
| 2 | lastRealTimestamp는 안 건드리고 비프 전용 클럭 분리 | idle/정렬/툴팁 부작용 차단 | lastRealTimestamp에서 stop_hook 제외(공유) | 필드 1개 추가하나 영향범위 격리 |
| 3 | 완료비프는 prev===undefined 미변경, 질문비프만 "새질문 울림" | 완료="끝남"은 흘러간 세션에 울리면 안 됨 / 질문="입력대기"는 새로 뜨면 울려야 | 둘 다 동일 처리 | 의미상 비대칭이 오히려 타당 |
| 4 | 타이머 markerAt 가드(워크플로우 변경8) 보류 | 이 환경 동시세션 0이라 미발생, 위험 중간 | 즉시 적용 | 다중세션 누락 재관찰 시 추가 |

---

## 3. 시행착오 / 사이드퀘스트

### 3-1. 경로 설명 장황·부정확
- **잘못된 가정/표현**: "실행한 머신의 홈"으로 설명 → 혼란.
- **발견**: 사용자가 "VS Code는 로컬 실행, SSH로 접속하는 것" "접속한 홈이잖아" 반복 정정.
- **복구**: "지금 작업 중인(접속한) 환경의 홈 `~/.claude/`"로 표현 통일.
- **교훈**: 환경 경로 설명은 사용자 멘탈모델("접속")에 맞춰 간결하게.

### 3-2. 정적 분석의 한계 (중요)
- **잘못된 가정**: 파일 최종 상태로 게이트 평가하면 비프 발동 여부 판단 가능.
- **발견**: 완료 세션 5개 전부 wouldBeep=true인데 실제 무음 → 모순.
- **복구**: 런타임 타이밍/디스크 기록 순서로 시야 전환 → stop_hook 오염 발견.
- **교훈**: 폴링+파일워처 기반 동작은 "파일 최종 상태"가 아니라 "쓰기 시점별 상태"로 봐야. 정적 wouldBeep는 표본의 terminal 뒤에 hook이 없던 우연.

### 3-3. AskUserQuestion 파라미터 누락
- 테스트 중 `questions` 파라미터 빠뜨려 InputValidationError 2회. 재호출로 복구.

---

## 4. 발견한 코드베이스 함정 (휘발 방지)

### 4-1. ★ stop-review-gate-hook의 system 엔트리가 비프 게이트 오염 (무음 핵심)
- codex 플러그인의 `stop-review-gate-hook.mjs`(사용자가 켜둠)가 **매 턴 완료 ~0.6초 후** `{"type":"system","subtype":"stop_hook_summary"}` 줄을 JSONL에 기록.
- 비프 게이트의 `lastActivity`(=session.lastUpdated=lastRealTimestamp)가 이 system 줄을 "활동"으로 카운트 → `newerActivityExists`(lastActivity > curr+500)=true → **즉시 suppress**. 또는 settle 창 내 파일워처 트리거로 타이머 리셋.
- 실측(현 세션): 모든 text end_turn 직후 +588~749ms에 stop_hook_summary. 한 케이스는 다음 진짜 user 메시지가 +2.5분인데도 0.6초 hook에 묻힘.
- **비대칭 증거**: 어제 비프 게이트 로직 무변경. 수정1(curr를 thinking→text로 이동)이 감지시점을 stop_hook 오염 구간으로 옮긴 게 방아쇠. stop_hook이 settle창에 떨어지는 비율 text 56% vs thinking 15%.
- **대응**: 비프 전용 `lastActivityAt`(type==='assistant'||'user'만) 도입, 완료/질문 비프의 lastActivity 출처를 그것으로 교체.

### 4-2. JSONL 비-대화 엔트리 종류 (lastActivity에서 제외 대상)
- `system/stop_hook_summary`(완료 0.6초 후), `queue-operation`(enqueue), `file-history-snapshot`, `attachment`, `last-prompt`, `mode`, `ai-title` 등은 실제 대화 활동 아님.
- `lastRealTimestamp`(line 1351)는 `last-prompt`만 제외 → queue-operation/system은 포함됨. idle/정렬엔 무방하나 비프엔 노이즈.

### 4-3. 질문/완료 비프의 prev===undefined = "그 세션 첫 관측"
- `lastKnownEndTurnAt`/`lastKnownQuestionAt`은 메모리 맵 → 리로드/재활성 시 비워짐.
- prev===undefined를 "흘러간 것"으로 baseline 처리하면, 리로드 후 **세션 첫 질문/완료가 무음**. 질문은 드물어 항상 당함(완료는 빈번해 금방 정상화).
- 수정: suppressBeep(첫 스캔)일 때만 baseline, 런타임 중 첫 관측은 새 이벤트로 처리.

### 4-4. thinking-only end_turn 무시(수정1, part1)는 유지가 맞음
- 원복 시뮬레이션 비프 87→180건(2.07배). thinking-only end_turn 126개가 thinking 턴마다 중간 비프로 재발. 절대 원복 금지.

---

## 5. 사용자 핵심 발언 박제

- > "서브에이전트가 없더라도 퀵패널에 보이고 빈 화면이라도 보여줘야 할 거 아니야. 그게 UX잖아. 아예 안 보이면 프로그램이 잘못됐는지 알 거 아냐."
  - 맥락: 워크플로우 0건 시 항목 자체 미표시.
  - 적용: 빈 상태도 명시 표시 + 클릭 시 빈 패널 열기. (없음 = 정상임을 사용자가 확인 가능해야)

- > "나는 네가 어떻게 작업하든 질문이 떴을 때 비프음이 울리면 되는 거야."
  - 맥락: 질문 비프 동작 정의.
  - 적용: 구현 방식 무관, "질문 뜸 = 비프"가 불변 요구.

- > "어제 너무 보수적으로 작업한 것 같아. 다시 정밀 분석하고, 정 안 되면 원복도 고려해봐."
  - 맥락: 비프 무음.
  - 적용: 과보수 수정은 정밀 재분석 후 균형점 찾기. 원복은 최후수단.

---

## 6. 검증 매트릭스

| 변경 항목 | 컴파일 | 실기기 | 사용자 검증 |
|---|---|---|---|
| 워크플로우 빈상태 표시 (1.7.8) | ✅ | ✅ | ✅ |
| 비프 stop_hook 오염 수정 lastActivityAt (1.7.8) | ✅ | ✅ | ✅ (케이스1·3·4 + Sonnet) |
| 질문 비프 첫질문 무음 수정 (1.7.9) | ✅ | ✅ | ✅ (케이스2 + 연속) |
| 워크플로우 없음 클릭→패널 (1.7.10) | ✅ | ❌ | ❌ (빌드 직후, 설치 확인 대기) |

---

## 7. 외부 의존 보드

없음

---

## 8. 변경 파일 인벤토리

```
M src/extension.ts  — 비프 게이트 lastActivityAt 도입(7곳: SessionInfo/TokenUsage 인터페이스, empty, 지역변수, forward pass assistant|user만 갱신, return, findActiveSessions 2곳, 완료비프·질문비프 lastActivity 출처 교체) + 질문비프 첫질문 무음 수정(suppressBeep baseline + prev===undefined 새질문 울림) + 워크플로우 빈상태 항목(action:'workflows')
M package.json      — 버전 1.7.7 → 1.7.10
```
(src/workflowPanel.ts는 빈 목록 처리 이미 존재해 미변경. vsix 1.7.8/1.7.9/1.7.10은 gitignore)

---

## 9. 미해결 항목

### 9-1. 즉시 처리 필요
- 없음 (핵심 버그 다 잡힘)

### 9-2. 검증 미완
- v1.7.10의 "워크플로우 없음 클릭 → 빈 패널 열림" 실기기 확인 (빌드 직후, 사용자 설치/확인 대기). 코드·빌드는 완료.

### 9-3. 별도 트랙
- **폰트 영구 저장**(part1 §9-1에서 이월): workflowPanel.ts 폰트(fontPx)가 webview setState라 패널 닫으면 리셋. context.globalState 전환 필요. 이번 세션 미착수.
- **타이머 markerAt 가드**(워크플로우 변경8): 다중 활성 세션 환경에서 완료비프 누락 재관찰 시 curr>prev 분기에 markerAt 동일 시 no-op 가드 추가.
- queue-operation 등 noise를 lastRealTimestamp에서도 제외할지(현재 비프만 격리). idle/정렬엔 무영향이라 보류.

---

## 10. 이어받기 포인트 ★

```
- 시작 지점: src/workflowPanel.ts (폰트 fontPx 저장 로직, line 138-143) + src/extension.ts (createOrShowWorkflowPanel 호출부)
- 다음 한 줄 액션: (이월) 폰트 크기를 webview setState → context.globalState 영구 저장으로 전환
- 직전 커밋 해시: 이번 세션 commit 후 확인 (v1.7.10)
- 컴파일 상태: 통과
- 작업 진행도: 비프(완료·질문) 무음 근본수정 완료·실기기 검증 완료. 워크플로우 빈상태/클릭 완료. 폰트 영구화만 이월.
- 주의:
  - 비프 무음 근본은 stop_hook 오염(4-1). 향후 비프 관련 작업 시 lastActivityAt(assistant|user만)가 정답 클럭. lastUpdated 쓰지 말 것.
  - 1.7.10 워크플로우 없음 클릭 동작만 실기기 미확인 — 다음 세션 시작 시 사용자에게 확인
  - 워크플로우 격리 worktree 쓰면 끝나고 git worktree remove 잊지 말 것
```

---

## 11. 컨텍스트 메타

- **종료 사유**: 정상 종료 (사용자 완전종료 + 위키 박제 선택)
- **중단 시점**: 1.7.10 빌드·실기기 테스트 통과 후, 마무리(/finish) 진입
- **미완성 상태로 남은 부분**: 1.7.10 "없음 클릭" 동작 실기기 미확인(코드·빌드 완료). 폰트 영구화 이월.
- **다음 세션 시작 시 주의**: 비프 관련 작업은 4-1(stop_hook 오염)·lastActivityAt 패턴 숙지 후 진입. 폰트 영구화가 이월 1순위.
- **세션 중반 모델 전환**: Sonnet으로 테스트차 전환 후 Opus 복귀.
