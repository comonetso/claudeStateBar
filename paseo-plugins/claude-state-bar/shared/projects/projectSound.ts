// 프로젝트에서 끌 수 있는 소리(10-24 리규형님 — 프로젝트별 소리 끄기). 아무것도 불러오지 않는다 — 서버 파일(server/projects/projects·projectMute)이
// 이 값을 쓰면서 shared/projects/projects(→ @getpaseo/plugin·zod)를 끌어오면, 그 서버 파일만 따로 불러 쓰는 곳(팀원 관리 시험 등)이 깨진다.

/** 프로젝트에서 끌 수 있는 소리 — "질문만 남기고 끄기"는 이 넷 모두. 질문은 늘 울려 여기 없다(버튼 "질문은 늘 울림") */
export const mutableSoundKinds = ["completion", "workflow", "warning", "danger"] as const;
export type MutableSoundKind = (typeof mutableSoundKinds)[number];
/** 끌 수 있는 소리의 화면 이름 — 설정 화면 소리 칸(끝남·따르릉·경고·위험)과 같은 뜻. 경고·위험은 컨텍스트 사용률 소리라 "컨텍스트"를 붙인다
 *  (10-24 리규형님 "위험 경고가 뭐지?") */
export const mutableSoundNames: Record<MutableSoundKind, string> = { completion: "끝남", workflow: "워크플로우 끝", warning: "컨텍스트 경고", danger: "컨텍스트 위험" };
