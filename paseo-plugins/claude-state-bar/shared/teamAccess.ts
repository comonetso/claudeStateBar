// 팀원 권한(10-11 저녁 리규형님 "계정 만들 때 설정 먼저") — 서버 팀원 도구에 보낼 값의 모양과 기본값.
// 다른 묶음을 불러오지 않는다 — PC 데몬 쪽 저장·반영 코드와 시험이 Paseo 묶음 없이 쓴다(검사 정의는 shared/team.ts 의 accessSchema)

/**
 * 서버 한 대에서 이 팀원에게 주는 권한 — 팀원 홈은 늘 쓰기.
 * writable = 쓰기로 열 폴더(팀원 프로젝트 안, 그 밖은 반영 때 뺀다) — 팀원 프로젝트는 여기 없으면 읽기만 ·
 * ports = 서버 안에서 열어 줄 포트(DB 3306 등, 비우면 다 막힘) · logs = 읽기 전용으로 붙일 기록(TEAM_LOGS) ·
 * hideSecrets = 프로젝트 안 비밀 파일(.env 류)을 팀원에게 안 보이게 ·
 * addOnly = 계정파일만 폴더(10-12 리규형님 — 화면 이름, 서버 도구는 add — 분석 보고서 보관함: 새 파일을 만들고 자기 파일만 고치고 지운다, 남의 파일은 읽기만)
 */
export type TeamAccess = { writable: string[]; addOnly?: string[]; ports: number[]; logs: string[]; hideSecrets: boolean };

/**
 * 처음 만드는 팀원 — 풀권한·계정파일만 폴더·포트·기록 없음, 비밀 파일 그대로(10-11 리규형님 "열면 내 권한과 같게" · Codex 권고:
 * 나눠 준 프로젝트는 안의 내용까지 리규형님처럼 읽히고, 가리기는 켠 계정만). 서버 팀원 도구의 생략값(false)과 같다
 */
export const defaultAccess = (): TeamAccess => ({ writable: [], addOnly: [], ports: [], logs: [], hideSecrets: false });

/**
 * 계정을 만든 뒤 그 서버에서 관리자 권한으로 한 번 실행할 명령(10-12 리규형님 — "가끔 그런 경우가 생긴다", 예: 팀원 전용
 * 명령·지침 복사). 처음엔 한 칸, 추가해서 다섯 개까지. 성공한 명령은 다시 실행하지 않는다
 */
export const AFTER_MAX = 5;
export const AFTER_LEN = 1000;
/** 실행한 명령의 마지막 결과 — out 은 출력 끝 몇 줄(화면 표시용) */
export type AfterResult = { command: string; ok: boolean; code: number | null; out: string; at: number };

/**
 * 팀원에게 읽기 전용으로 붙일 수 있는 기록 — 서버 팀원 도구(team-daemon policy.py PM2·LOG)가 시스템 폴더 중 이 둘만 허락한다.
 * PM2 기록은 날짜별로 새 파일이 생겨 파일 하나씩은 못 붙이고 폴더째 붙인다(그 서버 모든 앱의 기록이 보인다)
 */
export const TEAM_LOGS = [
  { path: "/root/.pm2/logs", label: "서버 기록 전체(PM2)", note: "이 서버 모든 앱의 기록 — 날짜별로 새 파일이 생겨 폴더째만 붙일 수 있습니다" },
  { path: "/var/log/poi_departure_monitor.log", label: "POI 감시 기록", note: "출발지 감시 기록 파일 하나" },
] as const;
