// 🔴 이행용 껍데기 — 실행기는 claude-rc-relay/relay.mjs 하나다(10-18 리규형님 "코드가 파편화된 것이 문제").
// PC 팀 공급자(claude-yeogiaen·claude-hrg)만 이 파일로 따로 떠서, 개인 실행기에만 넣은 화면 중복 막기가 빠져 생각 상자에 진행 글이 두 번 찍혔다(10-18 사고).
// PC Paseo 설정(config.json agents.providers.<팀>.command)이 아직 이 파일을 가리켜 지우지 않고 relay.mjs 를 그대로 실행하게만 둔다.
// `node launch.mjs --real <claude> …` 로 떠도 relay.mjs 가 읽는 process.argv 가 같고, relay 의 import 는 모두 relay 자기 위치 기준이라 그대로 돈다.
// 여기에 기능을 넣지 마라 — 고칠 것은 relay.mjs 에.
// 배포 단계에서 PC 설정 command 를 ...\claude-rc-relay\relay.mjs 로 바꾸고, 이 파일을 쓰는 프로세스가 없어진 뒤 이 폴더를 지운다.
import "../claude-rc-relay/relay.mjs";
