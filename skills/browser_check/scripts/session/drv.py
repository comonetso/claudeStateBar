#!/usr/bin/env python3
# 영구 aside repl 세션 구동기 — 명령 파일 큐 방식.
# 사용: python3 drv.py <작업폴더>   (백그라운드)
#   <작업폴더>/q/NNN.js 를 넣으면 순서대로 실행해 <작업폴더>/o/NNN.txt 에 결과를 쓴다.
#   파일 내용이 '__EXIT__' 이면 세션을 끝낸다.
#   JS 는 async 함수 본문으로 감싸 base64 로 한 줄에 실어 보낸다(여러 줄 전송 시 첫 줄만 실행되는 함정 회피,
#   문자열 속 import 낱말 정적 거절 회피). 호출 간 값 유지는 globalThis.X 로.
import subprocess, time, re, select, os, sys, base64, glob, json

D = sys.argv[1]
os.makedirs(D + '/q', exist_ok=True)
os.makedirs(D + '/o', exist_ok=True)
LOG = open(D + '/drv.log', 'a', buffering=1)
ANSI = re.compile(rb'\x1b\[[0-9;]*m')

def log(*a):
    LOG.write(time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a) + '\n')

p = subprocess.Popen([os.environ.get('ASIDE_BIN', 'aside'), 'repl', '--host', os.environ['ASIDE_HOST']],  # private values come from env/config, never hard-coded
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
buf = b''

def read_until(pat, timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], 0.5)
        if r:
            chunk = os.read(p.stdout.fileno(), 1 << 20)
            if not chunk:
                break
            buf += chunk
            clean = ANSI.sub(b'', buf)
            if re.search(pat, clean):
                out = clean; buf = b''; return out, True
        if p.poll() is not None and not r:
            break
    out = ANSI.sub(b'', buf); buf = b''
    return out, False

intro, ok = read_until(rb'type .help.', 40)
log('INTRO', ok, intro.decode(errors='replace')[:500])
open(D + '/o/000-intro.txt', 'wb').write(intro)

MARK = rb'\[(ok|error) \| \d+ms\]'
done = set()
while True:
    open(D + '/alive', 'w').write(str(time.time()))
    if p.poll() is not None:
        log('REPL EXITED', p.returncode)
        open(D + '/dead', 'w').write(str(p.returncode))
        break
    files = sorted(f for f in glob.glob(D + '/q/*.js') if f not in done)
    if not files:
        time.sleep(0.3)
        continue
    f = files[0]
    done.add(f)
    name = os.path.basename(f)[:-3]
    src = open(f, encoding='utf-8').read()
    if src.strip() == '__EXIT__':
        p.stdin.write(b'exit\n'); p.stdin.flush()
        try:
            p.wait(20)
        except Exception:
            p.kill()
        log('EXIT', p.returncode)
        open(D + '/o/' + name + '.txt', 'w').write('EXIT ' + str(p.returncode))
        open(D + '/dead', 'w').write('exit')
        break
    wrapped = '(async () => {\n' + src + '\n})()'
    b64 = base64.b64encode(wrapped.encode('utf-8')).decode()
    line = "await (0, eval)(Buffer.from('" + b64 + "', 'base64').toString('utf8'))"
    t0 = time.time()
    p.stdin.write((line + '\n').encode()); p.stdin.flush()
    out, ok = read_until(MARK, 70)
    dt = time.time() - t0
    log('RUN', name, 'ok' if ok else 'TIMEOUT', round(dt, 1))
    with open(D + '/o/' + name + '.txt', 'wb') as w:
        w.write(out)
        w.write(('\n<<wall %.1fs %s>>\n' % (dt, 'marker' if ok else 'NO-MARKER')).encode())
