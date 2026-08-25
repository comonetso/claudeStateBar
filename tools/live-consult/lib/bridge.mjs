// bridge.mjs — codex app-server 알림을 `codex exec --json` 호환 이벤트로 바꾼다.
//
// 왜 이 계층이 존재하는가
// ----------------------------------------------------------------------------
// VS Code 확장(claudeStateBar)의 Codex 진행 패널은 `docs/codex_rescue/.log/<스탬프>_events.jsonl`
// 을 읽어 카드를 그린다. 그 파서는 `src/providers/codexRescue/execEvents.ts` 이고, exec 형식
// (`{type, ...}`)만 안다. app-server 는 JSON-RPC 알림(`{method, params}`)을 보내며 모양이 전혀
// 다르다. 변환 없이 그대로 쓰면 패널이 통째로 빈다. 이 확장은 마켓플레이스 배포품이라
// "새 전송 방식을 쓰면 화면이 깨진다"는 선택지가 없다.
//
// 그래서 이 모듈의 목표는 딱 하나다: **app-server 로 돌려도 패널이 exec 때와 똑같이 보이게 한다.**
// 새 정보를 화면에 더 넣는 건 부차적이고, 넣더라도 파서가 이미 아는 어휘 안에서만 한다.
//
// 파서가 인식하는 최상위 type (execEvents.ts:291 switch)
//   thread.started · turn.started · item.started · item.updated · item.completed ·
//   turn.completed · turn.failed · error
//   → 그 외는 `unknownTypes++` 로 조용히 버려진다(화면에 안 나온다).
//
// 파서가 인식하는 item.type (i18n `cx.kind.*` · CSS `.kind.k-*`)
//   agent_message · reasoning · command_execution · file_change · web_search ·
//   mcp_tool_call · collab_tool_call · todo_list · error
//   → 그 외는 칩에 `cx.kind.<타입>` 키 문자열이 그대로 찍히고(i18n.t 는 미등록 키를 키 그대로
//     반환한다), 색도 없고, 그룹으로 접히지도 않는다.
//   → 예외가 하나 있다: `claude_steer`. app-server 가 보내는 타입이 아니라 **이 모듈이 만드는**
//     타입이고, 확장 쪽(i18n·CSS·execEvents)이 짝을 맞춰 인식한다. `STEER_ITEM_KIND` 참조.
//
// 순수 함수 위주다. 파일 I/O 는 하지 않는다 — 어디에 어떻게 쓸지는 호출자(live-consult.mjs)가 정한다.
//
// 근거: 2026-08-25 Phase 0 실측 원문
//   C:\Users\bluec\AppData\Local\Temp\codex-steer-fixture\2026-08-25T12-11-27-190Z\rpc.jsonl
// 대조: docs/codex_rescue/.log/*_events.jsonl (실제 codex exec --json 출력)

'use strict';

// ── 상수 ─────────────────────────────────────────────────────────────────────

/**
 * 파서가 아는 item.type 어휘. 여기 없는 값은 화면에서 깨지므로 절대 그대로 흘려보내지 않는다.
 * (출처: src/i18n.ts 의 cx.kind.* 키 9개. 늘리려면 확장 쪽 i18n·CSS 를 먼저 늘려야 한다)
 *
 * ⚠️ 이 집합은 `toExecItem()` 의 switch case 와 1:1 이어야 한다. 여기에만 값을 추가하면
 *    switch 의 default 로 떨어져 강등되고(안전), 반대로 case 만 추가하면 이 집합이 거짓이 된다.
 */
export const KNOWN_ITEM_KINDS = new Set([
    'agent_message', 'reasoning', 'command_execution', 'file_change',
    'web_search', 'mcp_tool_call', 'collab_tool_call', 'todo_list', 'error',
]);

/**
 * 사용자 개입(steer) 전용 item.type. **`KNOWN_ITEM_KINDS` 에 일부러 넣지 않았다.**
 *
 * 저 집합은 "app-server 가 보낸 item 을 그대로 통과시켜도 되는가"를 판정하는 기준이고
 * `toExecItem()` 의 switch case 와 1:1 이어야 한다. 이 타입은 app-server 에서 오지 않는다 —
 * `makeSteerEvent()` 가 우리 손으로 합성한다. 그래서 별도 상수로 둔다.
 *
 * 확장 쪽 짝(있어야 화면이 제대로 나온다):
 *   src/i18n.ts       `cx.kind.claude_steer` → "클로드" / "Claude"
 *   패널 CSS          `.kind.k-claude_steer` → #d98b45 (채팅 패널의 클로드 색과 같은 값)
 *   execEvents.ts     label/body 를 `message` 에서 뽑는다 (아래 makeSteerEvent 주석 참조)
 */
export const STEER_ITEM_KIND = 'claude_steer';

/**
 * 텍스트 필드 상한.
 *
 * 임의로 고른 값이 아니라 소비자에서 유도했다: execEvents.ts 의 `clipBody(max = 4000)` 가
 * body 를 4000자에서 자른다. 즉 4000자를 넘겨 봐야 화면에 절대 나오지 않고 파일만 무거워진다.
 * 이 파일은 원격 워크스페이스에서 5초마다 통째로 전송되므로(range read 가 없다) 크기가 곧 비용이다.
 */
const MAX_TEXT = 4000;

/**
 * 알림 자체를 통째로 버리는 목록 — `isDropped()` 참고.
 * events 파일뿐 아니라 **원문 감사 로그에도 남기지 않는다**는 뜻이다.
 */
const DROPPED_METHODS = new Set([
    // 전체 diff 를 매번 다시 보낸다. 변경이 쌓일수록 한 통이 커지고, 파서는 diff 를 읽지도 않는다.
    'turn/diff/updated',
    // 아래 둘은 크기가 아니라 내용 때문에 버린다. 요금제·사용률·installationId·environmentId 같은
    // 계정 식별 정보가 들어 있다. stderr 를 통째로 버리는 것과 같은 이유다(Phase 0 실측 #11).
    // events.jsonl 은 git 저장소 안의 docs/ 아래에 남고 여러 머신으로 동기화된다.
    'account/rateLimits/updated',
    'remoteControl/status/changed',
]);

/**
 * 파서가 쓰지 않는, 그러나 원문 감사 로그에는 남겨 둘 만한 알림.
 * (`isDropped()` 는 false — 원문에는 남는다. `toExecEvent()` 는 null — 화면에는 안 나온다)
 * 명시적으로 적어 두는 이유: 나중에 "왜 이건 안 보이지"를 코드에서 바로 답하기 위해서다.
 *   mcpServer/startupStatus/updated — exec 에는 대응 활동이 없다. 서버 6개면 6줄이 늘 뜬다.
 *   hook/started · hook/completed   — 위와 같다. 훅 실패는 `warning` 으로 따로 온다(실측).
 *   thread/status/changed           — 승인/입력 대기만 예외로 살린다(아래 참조).
 */

// item.type camelCase → exec 의 snake_case 어휘. 단순 변환으로는 안 되는 것만 명시한다.
const ITEM_TYPE_MAP = {
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    webSearch: 'web_search',
    mcpToolCall: 'mcp_tool_call',
    collabAgentToolCall: 'collab_tool_call',
    // `plan` 은 이름이 아예 다르다. exec 쪽 어휘는 todo_list 다.
    plan: 'todo_list',
    reasoning: 'reasoning',
    error: 'error',
};

// ── 작은 도구들 ───────────────────────────────────────────────────────────────

function camelToSnake(s) {
    return String(s)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase();
}

/** 문자열만 통과시키고 상한에서 자른다. 잘렸다는 걸 눈으로 알 수 있게 말줄임표를 남긴다. */
function clip(v, max = MAX_TEXT) {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (!t) return undefined;
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function firstString(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

/**
 * app-server 의 상태 문자열(`inProgress`)을 exec 어휘(`in_progress`)로.
 * execEvents.statusFor 가 `in_progress | completed | failed | declined` 를 보고 색을 정한다.
 */
function normalizeStatus(v) {
    if (typeof v !== 'string' || !v) return undefined;
    return camelToSnake(v);
}

/**
 * reasoning 의 본문을 만든다.
 *
 * exec 는 `reasoning.text` 하나지만 app-server 는 `summary[]` 와 `content[]` 로 쪼개 준다
 * (실측에서는 요약이 꺼져 있어 둘 다 빈 배열이었다). 원소가 문자열인지 `{text}` 객체인지가
 * 버전마다 다를 수 있어 양쪽을 다 받는다. 요약을 먼저 쓰는 이유는 카드 한 줄에 더 적합해서다.
 */
function reasoningText(item) {
    const pick = (arr) => asArray(arr)
        .map((e) => (typeof e === 'string' ? e : firstString(e && e.text, e && e.summary)))
        .filter(Boolean)
        .join('\n');
    return clip(pick(item.summary) || pick(item.content) || item.text);
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * camelCase item 타입을 exec 의 snake_case 어휘로 바꾼다.
 * 매핑에 없으면 일반 규칙(camel→snake)으로 변환만 한다. **아는 어휘인지 여부는 판단하지 않는다** —
 * 그 판정은 `KNOWN_ITEM_KINDS` 와 `toExecItem()` 의 강등 로직이 맡는다.
 */
export function normalizeItemType(t) {
    if (!t) return '';
    const key = String(t);
    return ITEM_TYPE_MAP[key] || camelToSnake(key);
}

/**
 * 델타/고빈도/민감 알림인지. true 면 **events 파일에도, 원문 감사 로그에도 쓰지 마라.**
 *
 * app-server 는 아래를 폭포수처럼 보낸다(실측: 58초짜리 턴 하나에 `item/agentMessage/delta` 만 57개.
 * 한 글자씩 온다). 그대로 파일에 쓰면 수 MB 로 폭증한다. 확장은 이 파일을 원격 워크스페이스에서
 * 5초마다 통째로 읽어 전송한다 — range read 가 없다. 지금도 750KB 로 힘든 판이다.
 * 게다가 델타는 `item/completed` 에 실려 오는 최종 텍스트와 내용이 중복이라 버려도 손실이 없다.
 *
 *   item/agentMessage/delta · item/reasoning/textDelta · item/reasoning/summaryTextDelta ·
 *   item/commandExecution/outputDelta · process/outputDelta
 *
 * 이름을 나열만 하지 않고 패턴(마지막 세그먼트가 `...delta`)으로도 막는 이유: CLI 가 새 델타
 * 종류를 추가해도 자동으로 걸린다. 폭증은 조용히 일어나고 늦게 발견되므로 기본값이 안전해야 한다.
 */
export function isDropped(method) {
    if (!method) return true;
    const m = String(method);
    if (DROPPED_METHODS.has(m)) return true;
    const last = m.split('/').pop() || '';
    return /delta$/i.test(last);
}

/**
 * 멀티턴에서 item id 가 겹치지 않게 턴 id 를 접두사로 붙인다.
 *
 * exec 는 후속 턴에서도 `item_0` 부터 다시 세기 때문에 앞 턴 활동을 덮어쓰는 버그가 있었다.
 * app-server 알림에는 `turnId` 가 실려 오므로(실측: 모든 item 알림에 있었다) 원천적으로 막을 수 있다.
 *
 * turnId 가 없으면 접두사를 붙이지 않는다 — 즉 "첫 턴은 원본 id 그대로"를 호출자가
 * `turnId` 를 넘기지 않는 것으로 표현할 수 있다.
 */
export function compositeItemId(turnId, itemId) {
    const id = itemId == null ? '' : String(itemId);
    const t = turnId == null ? '' : String(turnId);
    if (!t) return id;
    return t + ':' + id;
}

/**
 * 이 알림에 대한 item id 를 정한다 — 첫 턴이냐 아니냐를 여기서 가른다.
 *
 * 🔴 첫 턴에는 접두사를 붙이지 않는다. 단일 턴 실행(대부분)이 exec 시절과 **완전히 같은 id** 를
 *    유지해야 패널의 상세 보기 키(`stamp + ' ' + id`)가 흔들리지 않는다.
 *
 * 확장 쪽 규칙과 정책은 같고 형식만 다르다. execEvents.ts:217 은
 *   `const id = st.turnSeq > 1 ? 't' + st.turnSeq + ':' + rawId : rawId;`
 * 로 "첫 턴은 맨몸, 이후 턴은 접두사"를 쓴다. 여기서 굳이 `t<N>:` 를 똑같이 쓰지 않는 이유는,
 * 확장이 자기 turnSeq 로 접두사를 **또** 붙이기 때문이다. 같은 형식이면 `t2:t2:item_0` 이 되어
 * 읽기 어려워진다. turnId 를 쓰면 `t2:<turnId>:item_0` 이 되어 어느 층이 붙였는지 눈에 보인다.
 * 둘 다 붙어도 유니크성은 깨지지 않는다(같은 턴의 모든 item 에 같은 접두사가 붙는다).
 *
 * 턴 순번은 ctx 에서 읽는다. 호출자가 아무것도 주지 않으면 첫 턴으로 본다 — 그래도 확장의
 * turnSeq 안전망이 남으므로 최악의 경우에도 exec 시절과 같은 수준이다.
 */
function itemIdFor(ctx, turnId, rawId) {
    const id = rawId == null || rawId === '' ? undefined : String(rawId);
    if (!id) return undefined;
    if (!turnId) return id;
    if (ctx && typeof ctx.turnSeq === 'number') {
        return ctx.turnSeq > 1 ? compositeItemId(turnId, id) : id;
    }
    if (ctx && ctx.firstTurnId) {
        return String(ctx.firstTurnId) === String(turnId) ? id : compositeItemId(turnId, id);
    }
    return id;
}

/**
 * app-server item → exec item.
 *
 * 🔴 `type` 만 바꿔서는 안 된다. 필드 이름도 다르다(`exitCode` vs `exit_code`,
 *    `inProgress` vs `in_progress`). execEvents.labelFor 는 kind 별로 정해진 필드를 읽으므로,
 *    이름이 어긋나면 칩만 맞고 본문이 빈 카드가 나온다.
 *
 * 🔴 필요한 필드만 화이트리스트로 옮긴다(원문을 통째로 넘기지 않는다). 이유가 둘이다.
 *    1) 크기 — 실측에서 `commandExecution.aggregatedOutput` 에 명령 출력 전체가 실려 왔다.
 *       참조 실행에서는 한 명령의 출력만 63KB 였다. execEvents 는 `aggregated_output` 을
 *       아예 읽지 않으므로(주석에 "DROP 한다"고 명시되어 있다) 넘길 이유가 없다.
 *    2) 유출 — 원문에는 cwd·processId 처럼 화면에 쓰이지 않는 값이 섞여 있다.
 *
 * @returns exec 형식 item 또는 null(버림)
 */
function toExecItem(item, ctx, turnId) {
    if (!item || typeof item !== 'object') return null;

    const rawType = String(item.type || '');
    const kind = normalizeItemType(rawType);
    const id = itemIdFor(ctx, turnId, item.id);

    // userMessage 는 버린다. 셋 다 이유가 된다.
    //  1) exec 에는 대응 item 이 없다(실측 로그 2건에서 0회). i18n·CSS 도 없어 칩이 깨진다.
    //  2) 첫 userMessage 는 CONSULT 요청서 전문이다. 수백 줄짜리 프롬프트가 카드로 박힌다.
    //  3) steer 로 보낸 문장도 userMessage 로 되돌아온다(실측). 그건 makeSteerEvent 가 이미
    //     자기 형식으로 내보내므로, 살려 두면 같은 문장이 두 번 뜬다.
    if (kind === 'user_message') return null;

    const base = { id: id || undefined, type: kind };

    switch (kind) {
        // 🔴 텍스트가 빈 agent_message / reasoning 은 내보내지 않는다.
        //
        // app-server 는 두 종류를 먼저 빈 껍데기(`text: ""`)로 `item/started` 하고, 본문은 델타로
        // 흘린 뒤 `item/completed` 에서 완성본을 준다. 델타를 버리는 이 설계에서 껍데기까지 내보내면
        // 내용이 0인 카드가 생긴다. 실측에서 reasoning 은 요약이 꺼져 있어 completed 에서도 끝내
        // 비어 있었고, 결과적으로 "생각 | reasoning" 이라고만 적힌 카드가 턴마다 3장씩 쌓였다.
        //
        // 버려도 되는 근거는 exec 로그 실측이다(docs/codex_rescue/.log/*_events.jsonl 2건):
        //   item.started  → command_execution 16 · file_change 2   (agent_message·reasoning 은 0)
        //   item.completed→ agent_message 11 · command_execution 16 · file_change 2 · error 4
        //   빈 텍스트 사례 0건
        // 즉 exec 도 "완성된 발화만 한 번" 냈다. 여기서 껍데기를 거르면 화면이 exec 시절과 같아진다.
        // 내용이 생기면 `item/completed` 에서 같은 id 로 카드가 만들어지므로 정보는 잃지 않는다.
        case 'agent_message': {
            const text = clip(item.text);
            return text ? { ...base, text } : null;
        }

        case 'reasoning': {
            const text = reasoningText(item);
            return text ? { ...base, text } : null;
        }

        case 'command_execution': {
            const exit = item.exitCode != null ? item.exitCode : item.exit_code;
            return {
                ...base,
                command: clip(item.command) || '',
                // exec 는 null 을 "아직 안 끝남"으로 쓴다(execEvents.labelFor 가 null 을 검사한다).
                exit_code: typeof exit === 'number' ? exit : null,
                status: normalizeStatus(item.status),
                // aggregated_output 은 일부러 넣지 않는다 — 위 주석의 크기 이유.
            };
        }

        case 'file_change': {
            // 원소 필드명이 버전에 따라 흔들릴 수 있어 후보를 여러 개 본다. path 가 label 의 전부다.
            const changes = asArray(item.changes).map((c) => ({
                path: clip(firstString(c && c.path, c && c.filePath, c && c.file), 512) || '',
                kind: firstString(c && c.kind, c && c.changeType, c && c.type),
            }));
            return { ...base, changes, status: normalizeStatus(item.status) };
        }

        case 'web_search':
            // execEvents 는 `action` 을 "버전마다 모양이 달라 쓸모없다"고 이미 판단해 무시한다.
            return { ...base, query: clip(firstString(item.query, item.text), 512) || '' };

        case 'mcp_tool_call':
            return {
                ...base,
                server: clip(firstString(item.server, item.serverName), 120) || '',
                tool: clip(firstString(item.tool, item.toolName, item.name), 200) || '',
                status: normalizeStatus(item.status),
            };

        case 'collab_tool_call':
            return {
                ...base,
                tool: clip(firstString(item.tool, item.toolName, item.name), 200) || '',
                status: normalizeStatus(item.status),
            };

        case 'todo_list': {
            // exec 는 `items:[{text, completed}]`. app-server 쪽 필드명이 확정되지 않아
            // (실측 로그에 plan 이 한 번도 안 나왔다) 흔한 후보를 모두 받는다.
            const src = asArray(item.items).length ? item.items
                : (asArray(item.plan).length ? item.plan : item.steps);
            const items = asArray(src).map((e) => {
                if (typeof e === 'string') return { text: clip(e, 512) || '', completed: false };
                const done = typeof (e && e.completed) === 'boolean'
                    ? e.completed
                    : String((e && e.status) || '').toLowerCase() === 'completed';
                return { text: clip(firstString(e && e.text, e && e.step, e && e.title), 512) || '', completed: done };
            });
            return { ...base, items };
        }

        case 'error':
            return { ...base, message: clip(firstString(item.message, item.text)) || '' };

        default: {
            // 매핑에 없는 새 item 타입.
            //
            // 그대로 넘기면 칩에 `cx.kind.<타입>` 이라는 키 문자열이 찍히고 색도 그룹핑도 없다.
            // 버리면 Codex 가 실제로 한 일이 화면에서 사라진다. 둘 다 나쁘다.
            //
            // 그래서 세 번째 길을 택했다: 아는 어휘인 `error` 로 강등한다.
            //  · execEvents.statusFor 는 error 를 `warn`(노란색)으로 그린다. 실패로 오해되지 않는다.
            //  · i18n 이 "알림"/"notice" 라서 "이건 알려 주는 정보"라는 뜻이 맞다.
            //  · 원본 타입명을 메시지 앞에 남겨 두면 뭐가 새로 생겼는지 화면에서 바로 읽힌다.
            // CLI 가 올라가도 패널이 깨지는 대신 노란 줄로 degrade 되는 게 이 코드베이스의 기존 태도다
            // (execEvents.ts 서두: "a CLI upgrade degrades the panel instead of breaking it").
            const detail = firstString(item.text, item.message, item.name, item.tool, item.command);
            return {
                ...base,
                type: 'error',
                message: clip('[' + (rawType || 'unknown') + '] ' + (detail || '')) || ('[' + rawType + ']'),
            };
        }
    }
}

/** 아는 어휘(`error` item)로 포장한 안내 한 줄. 화면에 노란 "알림" 카드로 나온다. */
function noticeEvent(id, message) {
    return { type: 'item.completed', item: { id, type: 'error', message: clip(message) || '' } };
}

/**
 * `thread/start` **응답**에서 thread.started 를 만든다.
 *
 * `toExecEvent()` 는 알림만 받는데 스레드 id 는 응답으로도 온다(실측: 응답 약 760ms,
 * `thread/started` 알림도 따로 온다). 둘 중 먼저 오는 쪽으로 쓰라고 따로 뺐다.
 * 두 번 써도 무해하다 — execEvents 는 thread_id 를 덮어쓰기만 한다.
 */
export function makeThreadStartedEvent(threadId) {
    return { type: 'thread.started', thread_id: threadId == null ? '' : String(threadId) };
}

/**
 * 끼어들기(steer)를 화면에 보이게 만드는 이벤트.
 *
 * 형식 선택 근거:
 *  · `steer.accepted` 같은 새 **최상위** type 은 안 보인다. execEvents 의 switch 에 없어서
 *    `unknownTypes++` 로 버려지고, 진단 수치만 오염된다. 그래서 최상위는 `item.completed` 다.
 *  · `agent_message` 로 위장하면 보이긴 하는데 **Codex 가 한 말처럼 보인다.** 사용자가 개입한
 *    문장을 모델의 발화로 읽게 되는 건 잘못된 정보다.
 *  · 예전에는 `error` item 으로 냈다. 그런데 `error` 의 화면 표기는 **"알림"** 이고, 그 칩은
 *    Codex CLI 안내("clamping SessionEnd hook timeout to 3s")에 이미 쓰이고 있다.
 *    실제로 사용자가 둘을 혼동했다 — 같은 노란 "알림" 칩인데 하나는 CLI 잡음이고 하나는
 *    사람이 개입한 문장이다. 그래서 전용 kind 를 판다.
 *
 * → `claude_steer`(화면 칩 "클로드", 주황 #d98b45, 상태 done). 경고가 아니라 정상적인 개입이다.
 *   그래서 `status` 필드를 **일부러 싣지 않는다**: execEvents.statusFor 는 status 가 없으면
 *   `item.completed` 를 곧장 `done` 으로 본다. `declined` 를 실으면 빨간 실패로 그려지는데,
 *   전달 실패는 실패지만 "Codex 가 실패했다"로 읽히면 안 되므로 문면으로만 구분한다.
 *
 * 🔴 `message` 필드가 화면에 나가는 **유일한 통로**다. execEvents 는 kind 별로 정해진 필드만
 *    읽고(labelFor·upsert), 여기서는 `message` 하나로 label 과 body 를 모두 만든다.
 *    그래서 거부 여부·순번·출처를 전부 이 한 줄에 담는다.
 *
 * 접두사에서 `↪ 끼어들기` 를 뺐다: 칩이 이미 "클로드"라고 말하므로 라벨 200자를 중복에
 * 쓰는 셈이다. 반대로 **전달 실패**는 칩·색으로 드러나지 않으므로 문면에 남긴다 —
 * 사용자가 한 말이 Codex 에게 닿지 않았다는 건 조용히 넘어가면 안 되는 사실이다.
 *
 * id 는 `steer_<seq>` 다. seq 는 runtime 이 `seq/` 디렉토리에서 O_EXCL 로 원자 예약하므로
 * **한 실행 안에서 유일**하다(턴이 바뀌어도 다시 세지 않는다). 그래서 개입마다 별도 카드가 되고,
 * 같은 seq 로 다시 부르면 upsert 로 덮어써진다(전달 시도 → 결과 갱신).
 *
 * 🔴 접두사 규칙은 `itemIdFor()` 로 통일했다. 예전에는 여기만 "turnId 가 있으면 무조건 붙인다"
 *    였는데, 그러면 단일 턴 실행에서도 steer 카드 id 만 `<uuid>:steer_1` 이 되어 나머지 item 과
 *    정책이 어긋났다. ctx 를 주지 않으면 첫 턴으로 보고 맨몸 id 를 쓴다 — 확장의 turnSeq
 *    안전망이 후속 턴에 `t<N>:` 를 붙여 주므로 멀티턴에서도 충돌하지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 턴 경계 계약 — `claude_steer` 는 새 턴을 열지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * execEvents 는 턴 경계를 **직전 턴의 terminal 이벤트 기준**으로 잡는다(`pendingTurnBreak` +
 * `openTurnIfPending`). `turn.completed` 뒤에 오는 첫 `TURN_OPENING_TYPES` 이벤트가 다음 턴을
 * 연다. 그런데 이 함수가 내는 이벤트의 최상위 type 은 `item.completed` 이고, 호출자
 * (live-consult.mjs:850, "턴이 이미 끝나 전달하지 못했다")는 **turn.completed 가 이미 쓰인 뒤**
 * 잔여 개입을 여기로 흘린다. 실측 원문에도 같은 상황이 있다(rpc.jsonl #115 turn/completed →
 * #117 turn/steer → #118 에러 응답).
 *
 * 그대로 두면 단일 턴 실행인데도 turnSeq 가 2로 올라가 **없는 2턴이 만들어지고**, 그 안에
 * 거부 카드 한 장만 들어간다. "최대 turn 이 1이면 헤더를 넣지 않는다"는 규칙이 깨진다.
 *
 * bridge 단독으로는 못 막는다. item 을 만드는 최상위 type(`item.started`/`item.updated`/
 * `item.completed`/`error`)이 전부 `TURN_OPENING_TYPES` 에 들어 있고, 호출자의 appendJson 은
 * 객체 하나를 한 줄로만 쓰므로 이벤트를 둘로 쪼개 순서를 되돌릴 수도 없다.
 *
 * 그래서 `error` 대신 전용 kind 를 판 것이 곧 해법의 조건이다: 파서가 `item.type === 'claude_steer'`
 * 인 `item.completed` 를 turn-opening 에서 제외하면 끝난다. 부작용이 없다는 근거 — steer 는
 * 정의상 **이미 도는 턴**에 밀어 넣는 것이라 턴의 첫 이벤트가 될 수 없다(호출자도 turn/start
 * 응답을 받은 뒤에야 펌프를 돈다). 반대로 advisory `warning`→`error` 는 실측에서 `turn/started`
 * **보다 먼저** 오므로(rpc.jsonl #8 vs #20, exec 경로와 같은 순서) 반드시 turn-opening 으로
 * 남겨야 한다. 두 경로가 같은 규칙을 쓰려면 이 비대칭이 필요하다.
 *
 * @param {object}  o
 * @param {number}  o.seq       runtime 이 예약한 개입 번호(실행 내 유일)
 * @param {string}  o.source    user-via-claude | claude-monitor
 * @param {boolean} o.accepted  false 면 Codex 에게 닿지 않았다는 뜻
 * @param {string}  o.text      개입 원문
 * @param {string}  o.turnId    개입 시점의 turnId
 * @param {object}  [o.ctx]     toExecEvent 와 공유하는 변환 컨텍스트(첫 턴 판정용). 없어도 된다.
 */
export function makeSteerEvent({ seq, source, accepted, text, turnId, ctx } = {}) {
    const n = Number(seq);
    const num = Number.isFinite(n) ? n : 0;
    const rawId = 'steer_' + num;
    const who = firstString(source) || 'unknown';
    const body = clip(text) || '';
    // 전달 실패만 문면에 표시한다. 성공은 칩("클로드")과 주황색이 이미 설명한다.
    const head = accepted === false ? '⛔ 전달 실패 #' : '#';
    return {
        type: 'item.completed',
        // 파서는 최상위의 모르는 필드를 무시한다. 사후 감사에서 "이 개입이 어느 턴에 들어갔나"를
        // 파일만 보고 답할 수 있게 남긴다(turn.started 가 turn_id 를 싣는 것과 같은 이유).
        turn_id: turnId == null ? '' : String(turnId),
        item: {
            id: itemIdFor(ctx, turnId, rawId),
            type: STEER_ITEM_KIND,
            message: head + num + ' · ' + who + (body ? ' · ' + body : ''),
        },
    };
}

/**
 * `thread/tokenUsage/updated` 알림에서 exec 스키마의 usage 를 뽑는다. 없으면 null.
 *
 * `toExecEvent()` 가 ctx 에 자동으로 쌓아 주지만, ctx 를 유지하지 않는 호출자를 위해 따로 열어 둔다.
 * 뽑은 값을 직접 보관했다가 `toExecEvent(turnCompletedNote, {tokenUsage})` 로 넘겨도 결과는 같다.
 */
export function readTokenUsage(notification) {
    const p = (notification && notification.params) || {};
    const tu = p.tokenUsage;
    return pickUsage(tu && (tu.total || tu));
}

/**
 * app-server 알림 하나를 exec 호환 이벤트로 바꾼다.
 *
 * 🔴 ctx 는 **실행 내내 같은 객체를 유지해서** 넘겨라. 매 호출 새 객체를 만들면
 *    (`toExecEvent(note, {turnId, threadId})` 처럼) 아래가 조용히 망가진다.
 *      · 토큰 사용량이 `turn.completed` 에 실리지 않는다 → 패널에서 토큰 표시가 통째로 사라진다.
 *        (app-server 의 turn/completed 에는 usage 가 없다. 중간 알림으로만 온다 — 아래 참조)
 *      · 대기 상태 전이 판정이 매번 초기화돼 같은 안내가 중복으로 파일에 쌓인다.
 *      · 후속 턴의 item id 접두사가 붙지 않는다(확장의 turnSeq 안전망이 받아 주긴 한다).
 *    권장 형태: 실행 시작 때 `const ctx = { threadId }` 를 한 번 만들고, 턴이 바뀔 때마다
 *    `ctx.turnId = <새 turnId>; ctx.turnSeq = <1부터 세는 턴 번호>;` 만 갱신한다.
 *
 * @param {{method?: string, params?: any}} notification  ws 로 받은 알림 그대로
 * @param {object} ctx  변환 컨텍스트(가변).
 *                      읽는 값: turnId(폴백) · threadId(폴백) · turnSeq 또는 firstTurnId(첫 턴 판정)
 *                      쓰는 값: tokenUsage · modelContextWindow · waitingKey
 * @returns {object|null} null 이면 "이 알림은 화면에 낼 게 없다"는 뜻이다(버려라).
 */
export function toExecEvent(notification, ctx) {
    if (!notification || typeof notification !== 'object') return null;
    const method = String(notification.method || '');
    if (!method || isDropped(method)) return null;

    const p = (notification.params && typeof notification.params === 'object') ? notification.params : {};
    const c = (ctx && typeof ctx === 'object') ? ctx : {};
    // 알림에 실려 온 값이 항상 우선이다. ctx 는 그게 없을 때만 쓰는 폴백이다.
    const turnId = firstString(p.turnId, p.turn && p.turn.id, c.turnId);

    switch (method) {
        case 'thread/started':
            return makeThreadStartedEvent(firstString(p.thread && p.thread.id, p.threadId, c.threadId) || '');

        case 'turn/started':
            // execEvents 는 turn.started 의 필드를 하나도 읽지 않는다. turn_id 를 실어 두는 건
            // 순전히 사후 감사를 위해서다(파서는 모르는 필드를 무시한다).
            return { type: 'turn.started', turn_id: turnId || '' };

        case 'item/started':
        case 'item/updated':
        case 'item/completed': {
            const item = toExecItem(p.item, c, turnId);
            if (!item) return null;
            const type = method === 'item/completed' ? 'item.completed'
                : (method === 'item/updated' ? 'item.updated' : 'item.started');
            return { type, item };
        }

        case 'turn/completed': {
            const status = String((p.turn && p.turn.status) || p.status || '');
            if (status === 'completed') {
                const ev = { type: 'turn.completed' };
                const usage = pickUsage(p.usage || (p.turn && p.turn.usage)) || c.tokenUsage;
                if (usage) ev.usage = usage;
                return ev;
            }
            // 🔴 completed 가 아니면 전부 실패로 낸다(취소·중단 포함).
            // 끝나지 않은 걸 완료로 그리면 사용자가 오지 않을 답을 기다린다. 반대 방향의 오차가 훨씬 싸다.
            const err = (p.turn && p.turn.error) || p.error;
            const msg = firstString(
                err && err.message, typeof err === 'string' ? err : undefined,
                status ? 'turn ' + status : undefined,
            );
            return { type: 'turn.failed', error: { message: clip(msg, 512) || 'turn failed' } };
        }

        case 'turn/failed':
            // 실측 CLI(0.145.0)에는 이 메서드가 없다 — status 로 판정한다(Phase 0 실측 #9).
            // 그래도 받아 두는 건 공짜이고, 생기면 바로 동작한다.
            return { type: 'turn.failed', error: { message: clip(firstString(p.error && p.error.message, p.message), 512) || 'turn failed' } };

        case 'error':
            // execEvents 는 최상위 error 를 활동 한 줄로 기록하되 **종료로 취급하지 않는다**.
            // 그 동작이 여기 그대로 맞다.
            return { type: 'error', message: clip(firstString(p.message, p.error && p.error.message)) || 'error' };

        case 'warning':
            // 🔴 exec 에서 이 문구가 어떻게 나왔는지 실측으로 확인했다:
            //    {"id":"item_0","type":"error","message":"clamping SessionEnd hook timeout to 3s ..."}
            // 즉 app-server 의 `warning` 이 exec 의 advisory error item 과 같은 것이다.
            // 최상위 error 로 내면 execEvents 가 알아서 같은 모양의 item 을 만들어 준다.
            return { type: 'error', message: clip(firstString(p.message, p.warning)) || 'warning' };

        case 'thread/status/changed': {
            // exec 에는 없던 신호다. idle↔active 같은 일상 전이는 버린다 — 턴 시작/종료로 이미 다 보인다.
            //
            // 다만 `waitingOnApproval` / `waitingOnUserInput` 만은 살린다. 이건 "Codex 가 멈춰서
            // 사람을 기다리는 중"이라는 뜻인데, 버리면 화면에는 그냥 조용한 실행으로만 보인다.
            // 사용자가 왜 안 끝나는지 모른 채 기다리는 게 이 도구에서 제일 나쁜 실패다.
            //
            // id 를 고정(`status_wait`)해서 대기 카드가 하나만 유지되게 한다. 해제되면 같은 id 로
            // 덮어써 "대기 해제"로 바뀐다 — 안 그러면 노란 대기 카드가 끝까지 남는다.
            // 직전 상태는 ctx 에 들고 있어야 알 수 있어서, 여기서만 ctx 를 쓴다.
            const st = p.status;
            const flags = asArray(st && st.activeFlags)
                .map((f) => (typeof f === 'string' ? f : firstString(f && f.type, f && f.name)))
                .filter(Boolean);
            const stType = firstString(st && st.type, typeof st === 'string' ? st : undefined);
            if (stType && /^waitingOn/i.test(stType)) flags.push(stType);
            const waiting = flags.filter((f) => /^waitingOn/i.test(String(f)));
            const key = waiting.join(',');
            const prev = typeof c.waitingKey === 'string' ? c.waitingKey : '';
            if (key === prev) return null;
            c.waitingKey = key;
            const id = itemIdFor(c, turnId, 'status_wait');
            return key
                ? noticeEvent(id, '⏸ 대기 중 · ' + key)
                : noticeEvent(id, '▶ 대기 해제');
        }

        case 'thread/tokenUsage/updated': {
            // 🔴 이벤트로 내보내지 않는다. 대신 ctx 에 최신값을 쌓아 두고 turn.completed 에 싣는다.
            //
            // 그래야 하는 이유: app-server 의 `turn/completed` 알림 params 에는 **usage 가 없다**
            // (실측 원문 확인: threadId 와 turn{id,status,startedAt,completedAt,durationMs} 뿐).
            // exec 는 turn.completed 에 usage 를 실어 보냈고 패널도 거기서만 읽는다. 여기서
            // 안 받아 두면 토큰 표시가 통째로 사라진다.
            //
            // 중간값을 그때그때 이벤트로 내지 않는 이유:
            //  · turn.completed 를 미리 내면 패널이 실행을 끝난 것으로 그린다 — 절대 안 된다.
            //  · 새 type 은 파서가 모르니 안 보인다.
            //  · notice 로 내면 긴 턴에서 노란 줄이 계속 쌓인다(실측 58초 턴에 4회).
            // 즉 화면 표시는 exec 와 동일하게 "완료 시 한 번"으로 유지하고, 값만 잃지 않게 한다.
            const usage = readTokenUsage(notification);
            if (usage) {
                c.tokenUsage = usage;
                // 컨텍스트 창 크기는 exec 에 없던 값이라 패널이 쓰지 않는다. 그래도 runtime 상태나
                // 향후 표시에 쓸 수 있게 ctx 에는 남겨 둔다(파일로는 안 나간다).
                const w = p.tokenUsage && p.tokenUsage.modelContextWindow;
                if (typeof w === 'number' && w > 0) c.modelContextWindow = w;
            }
            return null;
        }

        default:
            // mcpServer/startupStatus/updated · hook/started · hook/completed 등.
            // 원문 로그에는 남지만(isDropped=false) 화면에는 대응 어휘가 없어 내보내지 않는다.
            return null;
    }
}

/**
 * app-server 토큰 사용량을 exec 의 usage 스키마(snake_case)로.
 * execEvents 가 읽는 5개 필드만 옮긴다 — totalTokens 는 파서가 안 쓰므로 버린다.
 */
function pickUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const out = {
        input_tokens: n(u.inputTokens != null ? u.inputTokens : u.input_tokens),
        cached_input_tokens: n(u.cachedInputTokens != null ? u.cachedInputTokens : u.cached_input_tokens),
        cache_write_input_tokens: n(u.cacheWriteInputTokens != null ? u.cacheWriteInputTokens : u.cache_write_input_tokens),
        output_tokens: n(u.outputTokens != null ? u.outputTokens : u.output_tokens),
        reasoning_output_tokens: n(u.reasoningOutputTokens != null ? u.reasoningOutputTokens : u.reasoning_output_tokens),
    };
    // 전부 0 이면 아직 값이 없는 것이다. 0 짜리 usage 를 실어 보내면 패널에 "0 토큰"이 찍힌다.
    return Object.values(out).some((v) => v > 0) ? out : null;
}
