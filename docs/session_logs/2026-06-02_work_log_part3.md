# 2026-06-02 세션 로그 part3 — 좀비 상태바 항목 근본원인 규명(인스턴스 소유권) + 퀵픽 정리 항목 + 업데이트 자동 리로드 권유

> **세션 성격**: part2 finish 후 좀비 세션 재제기 → 워크플로우 3마리(+종합) 정밀분석 → 근본원인=StatusBarItem 인스턴스 소유권(타 인스턴스 제거 불가, reload 유일) 확정 → 퀵픽에 좀비정리 항목 + 버전감지 자동 리로드 권유 추가(v1.7.11)
> **컨텍스트 시작**: part2 완전종료 후 사용자가 좀비 토스트 스크린샷("command not found") 제기, 에이전트 3마리 요청
> **컨텍스트 종료**: 정상 종료 (사용자 완전종료 + 위키 박제). 좀비 부재로 실기기 테스트는 증상 재현 시로 연기
> **모드**: 완전종료
> **커밋 범위**: 이번 part에서 생성 예정 (v1.7.11 + part3 로그)

---

## 1. 작업 흐름 (시간순)

### 1-1. 좀비 상태바 항목 재제기
**배경**: part1에서 좀비 수정(cleanupGhostItems/autoCleanup) 했으나 재발. 사용자 스크린샷: 회색 "AD: Opus 4.8 idle 45m" 클릭 → "Actual command not found, wanted to execute claudeContextBar.showSessionMenu" 토스트, 퀵픽 안 뜸. 사용자 "좀비 클릭하면 삭제되게" 요구.
**처리**: 스카우트 — 설치 폴더는 `ezoosk.claude-context-bar-1.7.10` **단 하나뿐**(옛 폴더 없음, autoCleanup 작동). 즉 '옛 폴더' 문제 아님. 워크플로우 3마리(+종합) 정밀분석.
**결과**: 근본원인 확정 (4-1).

### 1-2. 워크플로우 zombie-statusbar-diagnosis (4마리)
- 가설A(confirmed 0.78): 업데이트 시 옛 인스턴스 deactivate 미호출 + autoCleanup이 reload 전 옛 폴더 삭제→옛 인스턴스 비정상화.
- 가설B(confirmed 0.97): VS Code API상 타 인스턴스 StatusBarItem 조회/dispose 불가 + 명령 가로채기 불가 → **클릭 삭제 불가능, reload 유일**.
- 가설C(confirmed 0.9): deactivate는 이미 완전(손대지 말 것). 재발방지=버전감지 reload 권유 + 퀵픽 정리 항목.
- 종합(0.9): canClickDelete=false 확정.

### 1-3. 수정 (v1.7.11)
**처리**:
- 퀵픽 `showSessionMenu`에 "🗑 오래된/좀비 항목 정리 (창 다시 로드)" 항목 항상 추가(action:'cleanupGhosts') → 선택 시 즉시 `workbench.action.reloadWindow`. Item 타입 union에 'cleanupGhosts' 추가.
- activate에 globalState 버전 감지: `claudeStateBar.lastActivatedVersion` ≠ 현재 버전이면 1회 "업데이트됨, 좀비 남을 수 있음, 다시 로드?" 경고.
**결과**: 컴파일 통과, v1.7.11 빌드. 좀비 부재로 실기기 검증은 증상 재현 시로 연기.

---

## 2. 의사결정 로그

| # | 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|---|
| 1 | "좀비 클릭 삭제"는 구현 안 함(불가능 인정) | VS Code API에 타 인스턴스 StatusBarItem 조회/dispose 없음(타입정의 전수확인) | 클릭 가로채기/command 재등록(둘 다 API상 막힘) | 사용자 원안 불가, 차선책으로 |
| 2 | 살아있는 항목 퀵픽을 통로로 "좀비 정리(reload)" 제공 | 좀비 자체는 죽은 command라 클릭 불가 | 좀비 직접 클릭(불가) | 회색 직접 클릭 대신 파란 항목 경유 |
| 3 | 좀비 정리 선택 시 확인 없이 즉시 reload | 사용자 "바로 제거" 강조 + 메뉴 선택 자체가 의도 | 모달 확인 1회 | 실수 클릭 시 reload(라벨에 명시로 완화) |
| 4 | 버전감지 자동 리로드 권유 추가 | 좀비 최다 발생=업데이트 직후, globalState 버전감지 0건이 핵심 결손 | autoCleanup modal 격상(deleted=0 좀비 못 잡음) | globalState 1키 추가 |

---

## 3. 시행착오 / 사이드퀘스트

### 3-1. "옛 폴더 문제" 선입견 차단
- **잘못된 가정**: part1처럼 옛 버전 폴더가 남아 좀비.
- **발견**: 설치 폴더 1.7.10 하나뿐. autoCleanup 정상 작동.
- **복구**: 시야를 "죽은 인스턴스가 남긴 StatusBarItem 픽셀"로 전환.
- **교훈**: 좀비 토스트는 폴더가 아니라 '인스턴스 생명주기' 문제일 수 있음. 폴더부터 의심하되 1개뿐이면 다른 경로.

---

## 4. 발견한 코드베이스 함정 (휘발 방지)

### 4-1. ★ VS Code StatusBarItem은 만든 host 인스턴스 소유 — 타 인스턴스 제거 불가
- StatusBarItem은 `createStatusBarItem`한 extension host 인스턴스 메모리에 사는 객체. dispose 핸들도 그 인스턴스에만 존재.
- VS Code API에 "기존 상태바 아이템 열거/조회"(getStatusBarItems 등) 전역 API **없음**. StatusBarItem 인터페이스는 show/hide/dispose만, 핸들 보유자만 호출.
- 옛 인스턴스가 정상 deactivate 없이 죽으면(업데이트/크래시) 아이템 픽셀이 화면에 동결 잔존 → 현재 인스턴스는 핸들 없어 **절대 제거 불가**. **유일 제거 수단 = window reload(extension host 재시작)**.
- 좀비 클릭 시 "command not found": 그 아이템 command(showSessionMenu)는 죽은 인스턴스가 등록한 것이라 현재 레지스트리에 없음. 핸들러 호출 자체가 안 됨 → 현재 인스턴스가 가로채기 불가(onWillExecuteCommand류 이벤트 없음, command ID 중복등록은 에러).
- 즉 **"좀비 클릭 → 삭제"는 VS Code API상 구현 불가능**.

### 4-2. autoCleanup이 reload 전 옛 폴더 삭제 → 좀비 악화 가능
- 업데이트 후 사용자가 reload 안 하면 옛 인스턴스가 메모리에 생존. autoCleanup(activate 2초 후)이 옛 폴더를 fs.rmSync로 삭제하면 그 살아있는 옛 인스턴스가 비정상화돼 정상 deactivate 못 탐.
- isProtected는 '현재 실행 폴더'만 보호, '아직 살아있는 옛 인스턴스 폴더'는 사각지대.
- (Windows는 실행 중 파일 잠금으로 rmSync 실패 가능 — 그 경우엔 단순 '미reload 잔존'. 어느 경로든 결론은 reload 유일.)

### 4-3. deactivate는 이미 완전 — 손대지 말 것
- StatusBarItem 생성 경로 2곳(statusBarItems 맵, planFallbackItem). deactivate + subscriptions.dispose 둘 다 모두 dispose. 좀비는 dispose 버그가 아니라 'deactivate 미호출'(VS Code 한계).

---

## 5. 사용자 핵심 발언 박제

- > "내가 진정으로 원하는 건 좀비 세션이 (퀵픽) 메뉴에 나오면 바로 제거하는 거야."
  - 맥락: 좀비 제거 UX 요구.
  - 적용: 좀비 직접 클릭은 불가(죽은 command) → 살아있는 항목 퀵픽에 "좀비 정리(즉시 reload)" 항목으로 충족. 체감상 "퀵픽에서 바로 제거".

---

## 6. 검증 매트릭스

| 변경 항목 | 컴파일 | 실기기 | 사용자 검증 |
|---|---|---|---|
| 퀵픽 "오래된/좀비 항목 정리" → 즉시 reload (1.7.11) | ✅ | ❌ | ❌ (좀비 부재로 연기) |
| 버전감지 자동 리로드 권유 (1.7.11) | ✅ | ❌ | ❌ (다음 업데이트 시 자동 발동) |

---

## 7. 외부 의존 보드

없음

---

## 8. 변경 파일 인벤토리

```
M src/extension.ts  — showSessionMenu에 'cleanupGhosts' 퀵픽 항목(선택 시 reloadWindow) + Item 타입 union 확장 + activate globalState 버전감지 후 1회 reload 권유
M package.json      — 버전 1.7.10 → 1.7.11
```

---

## 9. 미해결 항목

### 9-1. 즉시 처리 필요
- 없음

### 9-2. 검증 미완
- v1.7.11 좀비 정리(퀵픽→reload) + 버전감지 권유 **실기기 미검증**. 좀비 부재로 연기 — **증상 재현 시 테스트**: 파란 항목 클릭 → "오래된/좀비 항목 정리" → reload → 회색 사라지는지.

### 9-3. 별도 트랙
- **폰트 영구 저장**(part1 §9-1, part2 §9-3 계속 이월): workflowPanel.ts fontPx를 context.globalState로. 미착수.
- 워크플로우 종합의 추가 권고(autoCleanup modal 격상, cleanupGhostItems 영어 병기)는 미적용 — 필요 시 추가.

---

## 10. 이어받기 포인트 ★

```
- 시작 지점: src/workflowPanel.ts (폰트 fontPx, line 138-143) — 이월 1순위
- 다음 한 줄 액션: (이월) 폰트 크기 webview setState → context.globalState 영구 저장
- 직전 커밋 해시: 이번 part commit 후 확인 (v1.7.11)
- 컴파일 상태: 통과
- 작업 진행도: 좀비 근본원인 규명 + 1.7.11 수정 완료. 실기기 검증만 증상 재현 시로 연기.
- 주의:
  - 좀비 제거는 reload만이 답(StatusBarItem 인스턴스 소유권, 4-1). 클릭 삭제는 API상 불가 — 다시 시도하지 말 것.
  - v1.7.11 설치 후 증상 재현되면 파란 항목 클릭 → "오래된/좀비 항목 정리"로 검증
  - 폰트 영구화가 이월 누적 1순위
```

---

## 11. 컨텍스트 메타

- **종료 사유**: 정상 종료 (사용자 완전종료 + 위키 박제)
- **중단 시점**: v1.7.11 빌드 후, 좀비 부재로 실기기 테스트 못 하고 종료
- **미완성 상태로 남은 부분**: v1.7.11 좀비 정리 실기기 미검증(증상 재현 대기). 폰트 영구화 이월.
- **다음 세션 시작 시 주의**: 좀비 재현되면 1.7.11 정리 동작 검증. 좀비는 reload만 답(4-1) — 클릭삭제 재시도 금지.
