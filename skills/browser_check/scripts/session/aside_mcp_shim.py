#!/usr/bin/env python3
# T6 시제품: 원격 PC 의 Aside 를 MCP repl 도구로 쓰기 위한 얇은 중계기(표준 라이브러리만).
# aside mcp 는 로컬 데몬 계정 조회 때문에 원격 repl 을 못 한다(R1 §3). 대신 대화형
# `aside repl --host <HOST>` 를 파이프로 붙들고, MCP tools/call 을 한 줄로 바꿔 흘려보낸다.
import json, os, re, select, subprocess, sys, time

HOST = os.environ['ASIDE_SHIM_HOST']          # required — the private host name lives in config, not in code
ASIDE = os.environ.get('ASIDE_BIN', 'aside')  # absolute path recommended (non-interactive shells may lack PATH)
LINE_LIMIT_S = 55  # 원격 한 줄 제한이 약 60초(T6 §4) — 넘으면 세션이 통째로 죽는다
ANSI = re.compile(rb'\x1b\[[0-9;]*m')
MARK = re.compile(rb'\[(ok|error) \| \d+ms\]')


class Pipe:
    def __init__(self):
        self.p = None
        self.buf = b''
        self.session_dir = None

    def _read_until(self, pat, timeout):
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([self.p.stdout], [], [], 0.3)
            if r:
                c = os.read(self.p.stdout.fileno(), 65536)
                if not c:
                    out, self.buf = self.buf, b''
                    return ANSI.sub(b'', out), 'eof'
                self.buf += c
                clean = ANSI.sub(b'', self.buf)
                if re.search(pat, clean):
                    self.buf = b''
                    return clean, 'ok'
        out, self.buf = self.buf, b''
        return ANSI.sub(b'', out), 'timeout'

    def ensure(self):
        if self.p and self.p.poll() is None:
            return None
        self.p = subprocess.Popen([ASIDE, 'repl', '--host', HOST], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        intro, st = self._read_until(rb"type 'help'", 40)
        m = re.search(rb'sessionDir: (\S+)', intro)
        self.session_dir = m.group(1).decode(errors='replace') if m else None
        return '[shim] 새 repl 세션을 열었다(이전 변수·탭은 없다). sessionDir=%s' % self.session_dir

    def run(self, code):
        note = self.ensure()
        # 여러 줄·주석을 한 줄로: AsyncFunction 본문으로 넘긴다(T6 §8 af.js 로 확인).
        # 호출 사이에 남길 값은 globalThis 에 둔다.
        line = ('await (new (Object.getPrototypeOf(async function(){}).constructor)(%s))();'
                % json.dumps(code))
        self.p.stdin.write((line + '\n').encode())
        self.p.stdin.flush()
        out, st = self._read_until(MARK, LINE_LIMIT_S + 10)
        text = out.decode(errors='replace').replace('repl > ', '')
        if st != 'ok':
            try:
                self.p.kill()
            except Exception:
                pass
            self.p = None
            text += '\n[shim] %s — 세션이 끝났다. 다음 호출에서 새로 연다.' % st
        is_err = st != 'ok' or '[error |' in text
        return ((note + '\n') if note else '') + text, is_err


def main():
    pipe = Pipe()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        msg = json.loads(raw)
        mid, method = msg.get('id'), msg.get('method')
        if mid is None:
            continue  # 알림
        if method == 'initialize':
            res = {'protocolVersion': msg['params'].get('protocolVersion', '2025-06-18'),
                   'capabilities': {'tools': {}}, 'serverInfo': {'name': 'aside-remote-shim', 'version': '0.1'}}
        elif method == 'tools/list':
            res = {'tools': [{'name': 'repl', 'description': 'Aside repl on remote host %s (persistent, <=55s per call, keep state on globalThis)' % HOST,
                              'inputSchema': {'type': 'object', 'properties': {'code': {'type': 'string'}}, 'required': ['code']}}]}
        elif method == 'tools/call':
            text, is_err = pipe.run(msg['params']['arguments']['code'])
            res = {'content': [{'type': 'text', 'text': text}], 'isError': is_err}
        else:
            sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'no method'}}) + '\n')
            sys.stdout.flush()
            continue
        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'result': res}, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    if pipe.p and pipe.p.poll() is None:
        pipe.p.stdin.write(b'exit\n')
        pipe.p.stdin.flush()


if __name__ == '__main__':
    main()
