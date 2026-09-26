import os
import subprocess, time, re, sys, select, os
p = subprocess.Popen([os.environ.get('ASIDE_BIN','aside'),'repl','--host',os.environ['ASIDE_HOST']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
buf = b''
def read_until(pat, timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r,_,_ = select.select([p.stdout],[],[],0.5)
        if r:
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk: break
            buf += chunk
            if re.search(pat, buf): 
                out = buf; buf = b''; return out
    out = buf; buf = b''; return out + b'<<TIMEOUT>>'
def send(line):
    p.stdin.write((line + '\n').encode()); p.stdin.flush()
t0=time.time()
print('INTRO:', read_until(rb'type .help.', 30).decode(errors='replace'))
steps = [
  "const pp1 = await openTab('https://example.com/?r1=persist'); console.log('@@P1 ' + pp1.url())",
  "console.log('@@P2 same-var ' + pp1.url() + ' tabs=' + tabs.length + ' pageIsPp1=' + (page === pp1))",
  "const pp2 = 41; console.log('@@P3 ' + (pp2 + 1))",
  "console.log('@@P4 ' + pp2 + ' ' + typeof pp1)",
  "state",
  "await closeTab(pp1); console.log('@@P5 closed tabs=' + tabs.length)",
]
for s in steps:
    t=time.time(); send(s)
    out = read_until(rb'\[(ok|error) \| \d+ms\]|\}\s*\n', 60)
    print(f'--- {s[:50]}  ({time.time()-t:.1f}s)\n' + out.decode(errors='replace')[:1500])
send('exit')
try: p.wait(20)
except Exception: p.kill()
print('exitcode', p.returncode, 'total', round(time.time()-t0,1))
