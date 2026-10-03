#!/usr/bin/env python3
"""android-check — Claude 가 안드로이드 실기기·에뮬레이터를 누르고, 보고, 로그를 읽고, 앱 실행을 맡는다.

Flutter 앱(Semantics → content-desc)과 네이티브 앱(text · resource-id · Compose testTag)을 함께 다룬다.
외부 의존: adb. 반응 시간 측정만 Pillow 가 필요하다(없으면 그 기능만 빠진다).

  setup                         비공개 설정을 처음 만든다(있으면 건드리지 않음)
  doctor [--json]               사전 점검: 연결·잠금·미러링 검은 화면·디스플레이·adb 버전·ARTEMIS·수집기
  elements                      화면 요소 목록(이름·위치·누를 수 있는지)
  tap <이름|x,y> [opts]          이름으로 찾아 누르기
  back [opts] / rotate <landscape|portrait|auto|restore> [opts]
  screenshot <파일>
    opts: --measure(반응 시간) --log --package P(그 사이 앱 로그·오류) --shot F(동작 뒤 캡처)
  logwatch start|stop|status|read [--package P] [--errors] [--since "MM-DD hh:mm:ss"] [--tail N]
  app register --package P --type flutter|native --project-dir D [--run-args ...] [--install-task T]
  app start|reload|restart|stop|status|log --package P
공통: --data-dir(비공개 설정 폴더, 보통 ${CLAUDE_PLUGIN_DATA}) --serial --display --json
"""

import argparse
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

for _stream in (sys.stdout, sys.stderr):  # sys.exit("…") 는 stderr 로 나간다 — 한글이 깨지지 않게
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
IS_WIN = sys.platform == "win32"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if IS_WIN else 0
DETACH = (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200) | NO_WINDOW) if IS_WIN else 0

# Flutter 예외·화면 넘침, 네이티브 강제 종료·ANR 등 — 앱 프로세스 줄에만 적용한다
ERROR_PATTERN = re.compile(
    r"EXCEPTION CAUGHT|RenderFlex overflowed|overflowed by|Another exception was thrown|"
    r"Unhandled Exception|FATAL EXCEPTION|AndroidRuntime|ANR in|setState\(\) called after dispose|"
    r"Null check operator|RangeError|is not a subtype of|StackOverflowError|OutOfMemoryError| E/"
)
# 오류는 아니지만 화면이 멈칫한 흔적 — 반응이 느릴 때 원인 짚기용(2026-10-04: 메뉴 첫 열기 1.5초 = Skipped 67 frames)
WARN_PATTERN = re.compile(r"Skipped \d+ frames|Davey! duration|Long monitor contention|Slow (Looper|operation|dispatch)|GC freed .* paused [0-9]{3,}ms")
MIN_CHANGE = 48  # 이보다 작은 변화(점멸 표시등 등)는 반응으로 치지 않는다


# ───────────────────────── 설정 ─────────────────────────

class Ctx:
    def __init__(self, a):
        self.a = a
        self.data_dir = a.data_dir or os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
            os.path.expanduser("~"), ".claude", "plugins", "data", "android-check")
        self.cfg_path = os.path.join(self.data_dir, "config.json")
        self.cfg = {}
        if os.path.exists(self.cfg_path):
            with open(self.cfg_path, encoding="utf-8") as f:
                self.cfg = json.load(f)
        self.adb_bin = self.cfg.get("adb") or os.environ.get("ADB") or shutil.which("adb") or "adb"
        self._serial = a.serial

    def save_cfg(self):
        os.makedirs(self.data_dir, exist_ok=True)
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(self.cfg, f, ensure_ascii=False, indent=2)

    def run(self, args, binary=False, timeout=30, serial=True):
        cmd = [self.adb_bin] + (["-s", self.serial] if serial and self.serial else []) + list(args)
        out = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
        return out.stdout if binary else out.stdout.decode("utf-8", "replace")

    @property
    def serial(self):
        if self._serial:
            return self._serial
        devs = [l.split()[0] for l in self.run(["devices"], serial=False).splitlines()[1:]
                if l.strip().endswith("\tdevice") or l.strip().endswith(" device")]
        if len(devs) != 1:
            sys.exit(f"기기를 하나로 정할 수 없습니다(연결된 기기 {len(devs)}대: {devs}). --serial 로 지정하세요.")
        self._serial = devs[0]
        return self._serial

    def display(self):
        """디스플레이가 여러 개면(폴더블·미러링 가상 화면) -d 없이 찍은 PNG 앞에 경고문이 섞여 깨진다.
        물리 화면(HWC) 중 캡처가 가장 큰(켜져 있는) 화면을 고른다. 결과는 설정에 캐시한다."""
        if self.a.display:
            return self.a.display
        listing = self.run(["shell", "dumpsys", "SurfaceFlinger", "--display-id"])
        ids = re.findall(r"^Display (\d+) \(HWC display", listing, re.M) or re.findall(r"^Display (\d+) \(", listing, re.M)
        if len(ids) <= 1:
            return ids[0] if ids else None
        cached = self.cfg.get("devices", {}).get(self.serial, {}).get("display")
        if cached in ids:
            return cached
        best = max(ids, key=lambda i: len(self.run(["exec-out", "screencap", "-d", i, "-p"], binary=True)))
        self.cfg.setdefault("devices", {}).setdefault(self.serial, {})["display"] = best
        if os.path.exists(self.cfg_path):
            self.save_cfg()
        return best


# ───────────────────────── 화면 ─────────────────────────

def need_pillow(ctx):
    try:
        from PIL import Image, ImageChops  # noqa: F401
        return True
    except ImportError:
        alt = ctx.cfg.get("python_image")
        if alt and os.path.exists(alt) and os.path.abspath(alt) != os.path.abspath(sys.executable):
            os.execv(alt, [alt] + sys.argv)  # Pillow 가 있는 파이썬으로 다시 실행
        sys.exit("반응 시간 측정에는 Pillow 가 필요합니다. `pip install pillow` 또는 설정의 python_image 를 지정하세요.")


def capture(ctx, display):
    from PIL import Image
    args = ["exec-out", "screencap"] + (["-d", display] if display else []) + ["-p"]
    return Image.open(io.BytesIO(ctx.run(args, binary=True))).convert("RGB")


def elements(ctx):
    xml = ctx.run(["exec-out", "uiautomator dump /sdcard/android_check.xml >/dev/null 2>&1; cat /sdcard/android_check.xml"])
    try:
        return parse_elements(xml)
    except ET.ParseError:
        sys.exit("화면 구조를 읽지 못했습니다(잠금 화면·보안 화면일 수 있음).")


def parse_elements(xml):
    """uiautomator 덤프에서 이름(content-desc·text)이나 resource-id 가 있는 노드만 뽑는다."""
    xml = xml[xml.find("<?xml"):] if "<?xml" in xml else xml
    out = []
    root = ET.fromstring(xml)
    for n in root.iter("node"):
        label = n.get("content-desc") or n.get("text") or ""
        rid = n.get("resource-id") or ""
        if not (label or rid):
            continue
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds", "[0,0][0,0]")))
        out.append({"label": label, "id": rid, "cls": n.get("class", "").split(".")[-1],
                    "pkg": n.get("package", ""), "clickable": n.get("clickable") == "true",
                    "bounds": [x1, y1, x2, y2], "center": [(x1 + x2) // 2, (y1 + y2) // 2]})
    return out


def find(ctx, query):
    if re.fullmatch(r"\d+,\d+", query):
        x, y = map(int, query.split(","))
        return (x, y), query
    els = elements(ctx)
    exact = [e for e in els if query in (e["label"], e["id"]) or e["id"].endswith("/" + query)]
    part = [e for e in els if query in e["label"]]
    hit = exact or part
    if not hit:
        sys.exit(f"'{query}' 를 화면에서 찾지 못했습니다. `elements` 로 목록을 보세요.")
    e = sorted(hit, key=lambda e: not e["clickable"])[0]
    return tuple(e["center"]), e["label"] or e["id"]


def changed_outside(a, b, boxes):
    from PIL import ImageChops
    d = ImageChops.difference(a, b)
    for x1, y1, x2, y2 in boxes:
        d.paste((0, 0, 0), (max(0, x1 - 4), max(0, y1 - 4), x2 + 4, y2 + 4))
    box = d.getbbox()
    if box and (box[2] - box[0]) < MIN_CHANGE and (box[3] - box[1]) < MIN_CHANGE:
        return None
    return box


def act_and_measure(ctx, display, action, timeout_s):
    from PIL import ImageChops
    base = capture(ctx, display)
    boxes, end = [], time.time() + 1.2  # 누르기 전 관찰 — 원래 깜빡이는 곳을 찾는다
    while time.time() < end:
        b = ImageChops.difference(base, capture(ctx, display)).getbbox()
        if b:
            boxes.append(b)
    t0 = time.time()
    action()
    sent = time.time() - t0
    first = settled = None
    prev = base
    while time.time() - t0 < timeout_s:
        cur = capture(ctx, display)
        now = time.time() - t0
        if first is None and changed_outside(base, cur, boxes):
            first = now
        elif first is not None and not changed_outside(prev, cur, boxes):
            settled = now
            break
        prev = cur
    return {"sent_s": round(sent, 2), "first_change_s": None if first is None else round(first, 2),
            "settled_s": None if settled is None else round(settled, 2), "masked": boxes[:3]}


def rotate(ctx, mode):
    keep = "/sdcard/android_check_rotation.txt"
    if mode == "restore":
        saved = ctx.run(["shell", "cat", keep]).split()
        if len(saved) == 2:
            ctx.run(["shell", "settings", "put", "system", "accelerometer_rotation", saved[0]])
            ctx.run(["shell", "settings", "put", "system", "user_rotation", saved[1]])
            ctx.run(["shell", "rm", keep])
        return
    if not ctx.run(["shell", "cat", keep]).strip() or "No such file" in ctx.run(["shell", "ls", keep]):
        acc = ctx.run(["shell", "settings", "get", "system", "accelerometer_rotation"]).strip()
        usr = ctx.run(["shell", "settings", "get", "system", "user_rotation"]).strip()
        ctx.run(["shell", f"echo '{acc} {usr}' > {keep}"])
    if mode == "auto":
        ctx.run(["shell", "settings", "put", "system", "accelerometer_rotation", "1"])
    else:
        ctx.run(["shell", "settings", "put", "system", "accelerometer_rotation", "0"])
        ctx.run(["shell", "settings", "put", "system", "user_rotation", "1" if mode == "landscape" else "0"])


# ───────────────────────── 로그 ─────────────────────────

def device_time(ctx):
    # 🔴 한 문자열로 보낸다 — 인자로 나눠 보내면 adb 가 공백을 그대로 이어 붙여 기기에서
    #    `date +%m-%d` `%H:%M:%S.000` 두 인자로 쪼개지고 빈 값이 나온다(2026-10-04 실측).
    return ctx.run(["shell", "date '+%m-%d %H:%M:%S.000'"]).strip()


def app_pids(ctx, package, text=""):
    """현재 PID + 로그의 'Start proc <pid>:<package>' (앱이 다시 뜨면 PID 가 바뀐다)."""
    pids = set(ctx.run(["shell", "pidof", package]).split()) if package else set()
    pids |= set(re.findall(rf"Start proc (\d+):{re.escape(package)}[/ ]", text)) if package else set()
    return pids


def filter_app(lines, pids):
    """줄 머리(`MM-DD hh:mm:ss.mmm L/TAG( PID):`)의 프로세스 번호로만 거른다 — 본문에 번호가
    들어 있는 시스템 줄(`Delivering touch to (5308)`)이 섞이지 않게."""
    if not pids:
        return lines
    pat = re.compile(r"^\S+ \S+ [VDIWEF]/[^(]*\(\s*(" + "|".join(sorted(pids)) + r")\):")
    return [l for l in lines if pat.search(l)]


TOUCH = re.compile(r"InputDispatcher\(\s*\d+\): Delivering touch to \((\d+)\).*?'(\w+)'")


APP_GOT_POINTER = re.compile(r"ViewPostIme pointer")  # 앱 창(ViewRootImpl)이 포인터를 받았다는 표시


def touch_report(raw, pids, app_lines=()):
    """누른 터치가 앱에 닿았는지 — 미러링 검은 화면 같은 창이 터치를 가져가는 것을 바로 잡아낸다.
    터치 하나는 내비게이션 바 같은 시스템 감시 창에도 함께 전달되고, 앱으로 간 전달 줄이 로그에서
    빠지기도 한다(2026-10-04 실측). 그래서 앱 쪽 수신 표시가 하나라도 있으면 '닿음'으로 본다."""
    targets = [(m.group(1), m.group(2)) for m in TOUCH.finditer(raw)]
    app_got = any(pid in pids for pid, _ in targets) or any(APP_GOT_POINTER.search(l) for l in app_lines)
    if app_got:
        return "앱에 닿음"
    if not targets:
        return None
    others = sorted({f"PID {pid} 창 {win}" for pid, win in targets})
    return "앱에 안 닿음 — 받은 창: " + ", ".join(others) + " · 미러링 검은 화면 창을 의심(doctor 로 확인)"


def logs_since(ctx, since, package):
    raw = ctx.run(["logcat", "-d", "-v", "time", "-T", since], timeout=60)
    pids = app_pids(ctx, package, raw)
    lines = filter_app(raw.splitlines(), pids)
    return (lines, [l for l in lines if ERROR_PATTERN.search(l)], [l for l in lines if WARN_PATTERN.search(l)],
            touch_report(raw, pids, lines))


def logwatch_state(ctx):
    return os.path.join(ctx.data_dir, "logwatch", f"{re.sub(r'[^A-Za-z0-9]', '_', ctx.serial)}.json")


def cmd_logwatch(ctx):
    a, st = ctx.a, logwatch_state(ctx)
    os.makedirs(os.path.dirname(st), exist_ok=True)
    info = json.load(open(st, encoding="utf-8")) if os.path.exists(st) else None
    alive = info and pid_alive(info["pid"])
    if a.arg == "start":
        if alive:
            return print(f"수집기가 이미 돌고 있습니다: {info['file']}")
        path = os.path.join(os.path.dirname(st), time.strftime("%Y%m%d-%H%M%S") + f"-{os.path.basename(st)[:-5]}.log")
        f = open(path, "w", encoding="utf-8", errors="replace")
        p = subprocess.Popen([ctx.adb_bin, "-s", ctx.serial, "logcat", "-v", "time"], stdout=f, stderr=subprocess.STDOUT,
                             creationflags=DETACH, start_new_session=not IS_WIN)
        json.dump({"pid": p.pid, "file": path, "started": time.time()}, open(st, "w", encoding="utf-8"))
        return print(f"로그 수집 시작: {path}")
    if a.arg == "stop":
        if alive:
            kill(info["pid"])
        return print("로그 수집 중지" + (f": {info['file']}" if info else ""))
    if a.arg == "status":
        return print(json.dumps({"running": bool(alive), **(info or {})}, ensure_ascii=False))
    if a.arg == "read":
        if not info:
            sys.exit("수집기를 켠 적이 없습니다. `logwatch start` 부터.")
        lines = open(info["file"], encoding="utf-8", errors="replace").read().splitlines()
        if a.since:
            lines = [l for l in lines if l[:18] >= a.since]
        if a.package:
            lines = filter_app(lines, app_pids(ctx, a.package, "\n".join(lines)))
        if a.errors:
            lines = [l for l in lines if ERROR_PATTERN.search(l)]
        for l in lines[-(a.tail or 200):]:
            print(l[:300])


# ───────────────────────── 프로세스 도우미 ─────────────────────────

def pid_alive(pid):
    if IS_WIN:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True, creationflags=NO_WINDOW)
        return str(pid) in out.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def kill(pid):
    if IS_WIN:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
    else:
        try:
            os.killpg(pid, 15)
        except OSError:
            pass


# ───────────────────────── 앱 실행 맡기 ─────────────────────────

def app_state_path(ctx, package):
    return os.path.join(ctx.data_dir, "apps", f"{package}.json")


def cmd_app(ctx):
    a = ctx.a
    if a.arg == "register":
        if not (a.package and a.type and a.project_dir):
            sys.exit("--package --type flutter|native --project-dir 가 필요합니다.")
        entry = {"type": a.type, "project_dir": os.path.abspath(a.project_dir)}
        if a.run_args:
            entry["run_args"] = a.run_args.split()
        if a.install_task:
            entry["install_task"] = a.install_task
        ctx.cfg.setdefault("apps", {})[a.package] = entry
        ctx.save_cfg()
        return print(f"등록: {a.package} → {entry}")
    if not a.package:
        sys.exit("--package 가 필요합니다.")
    app = ctx.cfg.get("apps", {}).get(a.package)
    if not app:
        sys.exit(f"{a.package} 가 등록돼 있지 않습니다. `app register` 부터.")
    return (flutter_app if app["type"] == "flutter" else native_app)(ctx, a.package, app)


def native_app(ctx, package, app):
    a = ctx.a
    if a.arg in ("start", "reload", "restart"):
        gradlew = os.path.join(app["project_dir"], "gradlew.bat" if IS_WIN else "gradlew")
        task = app.get("install_task", ":app:installDebug")
        t0 = time.time()
        r = subprocess.run([gradlew, task], cwd=app["project_dir"], capture_output=True, text=True,
                           creationflags=NO_WINDOW, env=dict(os.environ, ANDROID_SERIAL=ctx.serial))
        if r.returncode != 0:
            print(r.stdout[-3000:], r.stderr[-3000:])
            sys.exit(f"설치 실패({task})")
        ctx.run(["shell", "am", "force-stop", package])
        ctx.run(["shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"])
        return print(f"설치·실행 완료 {round(time.time() - t0, 1)}초 ({task})")
    if a.arg == "stop":
        ctx.run(["shell", "am", "force-stop", package])
        return print("앱 종료")
    if a.arg == "status":
        return print(json.dumps({"running": bool(ctx.run(["shell", "pidof", package]).strip())}))
    sys.exit("네이티브 앱은 log 대신 `logwatch read --package` 를 쓰세요.")


def runner_call(state, path, timeout=180):
    req = urllib.request.Request(f"http://127.0.0.1:{state['port']}{path}", method="POST",
                                 headers={"X-Token": state["token"]})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def flutter_app(ctx, package, app):
    a, sp = ctx.a, app_state_path(ctx, package)
    state = json.load(open(sp, encoding="utf-8")) if os.path.exists(sp) else None
    alive = state and pid_alive(state["pid"])
    if a.arg == "start":
        if alive:
            return print(f"이미 맡고 있습니다(appId={state.get('appId')}). reload / restart / stop 을 쓰세요.")
        if ctx.run(["shell", "pidof", package]).strip() and not a.force:
            sys.exit("기기에서 이 앱이 이미 돌고 있습니다 — 사람이 띄운 `flutter run` 일 수 있습니다. "
                     "겹쳐 띄우면 서로 끊으니 그 창의 r 을 부탁하거나, 그 창을 닫은 뒤 --force 로 다시 하세요.")
        os.makedirs(os.path.dirname(sp), exist_ok=True)
        p = subprocess.Popen([sys.executable, os.path.abspath(__file__), "runner", "--data-dir", ctx.data_dir,
                              "--serial", ctx.serial, "--package", package],
                             creationflags=DETACH, start_new_session=not IS_WIN,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + (a.wait or 600)
        while time.time() < deadline:  # 첫 빌드는 몇 분 걸린다
            time.sleep(2)
            if os.path.exists(sp):
                state = json.load(open(sp, encoding="utf-8"))
                if state.get("appId") or state.get("error"):
                    break
            if not pid_alive(p.pid):
                break
        if not state or not state.get("appId"):
            sys.exit(f"앱이 뜨지 않았습니다. `app log --package {package}` 로 빌드 로그를 보세요. {state and state.get('error')}")
        return print(f"실행 완료 — appId={state['appId']} (Claude 가 맡음)")
    if a.arg in ("reload", "restart", "stop"):
        if not alive:
            sys.exit("맡고 있는 실행이 없습니다. `app start` 부터.")
        t0 = time.time()
        res = runner_call(state, "/" + a.arg)
        return print(json.dumps({"action": a.arg, "seconds": round(time.time() - t0, 2), **res}, ensure_ascii=False))
    if a.arg == "status":
        return print(json.dumps({"running": bool(alive), **(state or {})}, ensure_ascii=False))
    if a.arg == "log":
        lp = sp[:-5] + ".log"
        if os.path.exists(lp):
            for l in open(lp, encoding="utf-8", errors="replace").read().splitlines()[-(a.tail or 80):]:
                print(l[:300])


def cmd_runner(ctx):
    """백그라운드 실행기: `flutter run --machine` 을 붙잡고 127.0.0.1 HTTP 로 reload/restart/stop 을 받는다."""
    a, package = ctx.a, ctx.a.package
    app = ctx.cfg["apps"][package]
    sp = app_state_path(ctx, package)
    log = open(sp[:-5] + ".log", "w", encoding="utf-8", errors="replace")
    flutter = shutil.which("flutter") or "flutter"
    proc = subprocess.Popen([flutter, "run", "--machine", "-d", a.serial] + app.get("run_args", []),
                            cwd=app["project_dir"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, creationflags=NO_WINDOW, text=True, encoding="utf-8", errors="replace")
    st = {"pid": os.getpid(), "flutter_pid": proc.pid, "token": secrets.token_hex(16), "started": time.time()}
    lock, waiters, seq = threading.Lock(), {}, [0]

    def write_state():
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False)

    def reader():
        for line in proc.stdout:
            line = line.rstrip()
            log.write(line + "\n")
            log.flush()
            if not (line.startswith("[{") and line.endswith("}]")):
                continue
            try:
                msg = json.loads(line)[0]
            except (ValueError, IndexError):
                continue
            ev, params = msg.get("event"), msg.get("params", {})
            if ev == "app.start":
                st["appId"] = params.get("appId")
                write_state()
            elif ev == "app.stop":
                st["stopped"] = True
                write_state()
            elif "id" in msg and msg["id"] in waiters:
                waiters[msg["id"]]["res"] = msg.get("result", msg.get("error"))
                waiters[msg["id"]]["ev"].set()
        st["exited"] = True
        st.setdefault("error", "flutter run 이 끝났습니다")
        write_state()

    def send(method, params, timeout=180):
        with lock:
            seq[0] += 1
            i = seq[0]
            waiters[i] = {"ev": threading.Event(), "res": None}
            proc.stdin.write(json.dumps([{"id": i, "method": method, "params": params}]) + "\n")
            proc.stdin.flush()
        ok = waiters[i]["ev"].wait(timeout)
        return waiters.pop(i)["res"] if ok else {"error": "응답 시간 초과"}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            if self.headers.get("X-Token") != st["token"]:
                self.send_response(403)
                self.end_headers()
                return
            path = self.path.strip("/")
            if path in ("reload", "restart"):
                res = send("app.restart", {"appId": st.get("appId"), "fullRestart": path == "restart", "pause": False,
                                           "reason": "manual"})
            elif path == "stop":
                res = send("app.stop", {"appId": st.get("appId")}, timeout=30)
                threading.Timer(1.0, lambda: (proc.kill(), os._exit(0))).start()
            else:
                res = {"error": "unknown"}
            body = json.dumps({"result": res}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    st["port"] = srv.server_address[1]
    write_state()
    threading.Thread(target=reader, daemon=True).start()
    srv.serve_forever()


# ───────────────────────── 점검 ─────────────────────────

def artemis_dir_from_claude():
    """Claude Code 에 등록된 ARTEMIS MCP 의 위치를 읽는다 — 개인 경로를 코드에 두지 않기 위해."""
    p = os.path.join(os.path.expanduser("~"), ".claude.json")
    try:
        srv = json.load(open(p, encoding="utf-8")).get("mcpServers", {}).get("artemis", {})
    except (OSError, ValueError):
        return None
    d = srv.get("cwd") or srv.get("env", {}).get("PYTHONPATH")
    return d if d and os.path.isdir(d) else None


SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)$")


def read_env_names(path):
    """.env 를 읽되 비밀(이름이 _KEY·_TOKEN·_SECRET·_PASSWORD 로 끝남)은 값 대신 True/False 만 남긴다.
    경로 같은 비밀 아닌 값(ARTEMIS_ADB_PATH 등)만 그대로 둔다."""
    names = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            names[k] = bool(v) if SECRET_NAME.search(k) else v
    return names


def adb_version(path):
    try:
        out = subprocess.run([path, "version"], capture_output=True, text=True, timeout=10, creationflags=NO_WINDOW).stdout
        m = re.search(r"Version (\S+)", out)
        return m.group(1) if m else None
    except OSError:
        return None


def cmd_setup(ctx):
    if os.path.exists(ctx.cfg_path) and not ctx.a.force:
        return print(f"설정이 이미 있습니다(건드리지 않음): {ctx.cfg_path}")
    cfg = {}
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    cands = [shutil.which("adb")] + ([os.path.join(sdk, "platform-tools", "adb.exe" if IS_WIN else "adb")] if sdk else [])
    cfg["adb"] = next((c for c in cands if c and os.path.exists(c)), "adb")
    art = artemis_dir_from_claude()
    if art:
        cfg["artemis_dir"] = art
        py = os.path.join(art, ".venv", "Scripts" if IS_WIN else "bin", "python.exe" if IS_WIN else "python")
        if os.path.exists(py):
            cfg["python_image"] = py
    try:
        __import__("PIL")
        cfg.setdefault("python_image", sys.executable)
    except ImportError:
        pass
    cfg["devices"], cfg["apps"] = {}, {}
    ctx.cfg = cfg
    ctx.save_cfg()
    print(json.dumps({"written": ctx.cfg_path, "notes": cfg}, ensure_ascii=False, indent=2))


def cmd_doctor(ctx):
    rows, verdict = [], "ready"

    def row(name, ok, detail, fix=""):
        nonlocal verdict
        if ok is False:
            verdict = "blocked"
        elif ok is None and verdict == "ready":
            verdict = "degraded"
        rows.append({"check": name, "ok": ok, "detail": detail, "fix": fix})

    row("설정 파일", os.path.exists(ctx.cfg_path), ctx.cfg_path, "" if os.path.exists(ctx.cfg_path) else "`setup` 실행")
    ver = adb_version(ctx.adb_bin)
    row("adb", bool(ver), f"{ctx.adb_bin} ({ver})", "" if ver else "Android platform-tools 설치·설정의 adb 경로 확인")
    devs = [l.split("\t") for l in ctx.run(["devices"], serial=False).splitlines()[1:] if "\t" in l]
    ready = [d[0] for d in devs if d[1] == "device"]
    bad = [f"{d[0]}={d[1]}" for d in devs if d[1] != "device"]
    row("기기 연결", bool(ready), f"사용 가능 {ready} {('· 문제 ' + str(bad)) if bad else ''}",
        "" if ready else "케이블/무선 연결·폰의 USB 디버깅 허용(사람)")
    if ready and (ctx.a.serial or len(ready) == 1):
        win = ctx.run(["shell", "dumpsys", "window"])
        locked = "isKeyguardShowing=true" in win or "mDreamingLockscreen=true" in win
        row("잠금 화면", not locked, "잠김" if locked else "풀림", "폰 잠금 해제(사람)" if locked else "")
        wins = ctx.run(["shell", "dumpsys", "window", "windows"])
        # 화면 전체를 덮어 터치를 가져가는 창만. 이름에 blackscreen 이 있어도 1×1px 화면 깨움 유지 창
        # (screenwakeholder.WakeLockScreenLayout)은 터치를 막지 않는다(2026-10-04 실측).
        black = [w for w in re.findall(r"Window #\d+ Window\{\S+ \S+ (\S*blackscreen\S*)\}", wins)
                 if "screenwakeholder" not in w]
        fix = []
        if any("galaxycontinuity" in b for b in black):
            fix.append("Samsung Flow Smart View: 도구 모음 '휴대전화 화면'을 켜짐으로")
        if any("mdx" in b for b in black):
            fix.append("휴대폰과 연결: 설정 → 휴대폰 화면 → '연결된 동안 휴대폰 화면 숨기기' 끄기")
        row("미러링 검은 화면 창", not black, ", ".join(black) or "없음", " / ".join(fix))
        listing = ctx.run(["shell", "dumpsys", "SurfaceFlinger", "--display-id"])
        phys = re.findall(r"^Display (\d+) \(HWC display", listing, re.M)
        virt = len(re.findall(r"\(Virtual display\)", listing))
        row("디스플레이", True, f"물리 {len(phys)}개 · 가상 {virt}개 → 사용 {ctx.display()}")
    art = ctx.cfg.get("artemis_dir") or artemis_dir_from_claude()
    if art and os.path.isdir(art):
        env = read_env_names(os.path.join(art, ".env")) if os.path.exists(os.path.join(art, ".env")) else {}
        keys = [k for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPEN_ROUTER_API_KEY") if env.get(k)]
        row("ARTEMIS", bool(keys) or None, f"{art} · 키 {keys or '없음'}", "" if keys else "ARTEMIS .env 에 AI 키(사람이 직접)")
        pinned = env.get("ARTEMIS_ADB_PATH")
        same = pinned and os.path.normcase(os.path.abspath(pinned)) == os.path.normcase(os.path.abspath(ctx.adb_bin))
        row("adb 버전 일치", True if same else None,
            f"ARTEMIS {pinned or '(자체 선택)'} · 이 도구 {ctx.adb_bin}",
            "" if same else "ARTEMIS .env 에 ARTEMIS_ADB_PATH 와 ADB 를 이 adb 로 고정(버전이 다르면 서로 서버를 끊는다)")
        if IS_WIN:
            sc = os.path.join(art, ".venv", "Lib", "site-packages", "sitecustomize.py")
            row("ARTEMIS CMD 창 숨김", os.path.exists(sc) or None, sc,
                "" if os.path.exists(sc) else "README 의 sitecustomize.py 를 ARTEMIS venv 에 넣기(실행마다 CMD 창이 뜬다)")
    else:
        row("ARTEMIS", None, "설치 안 됨 — 탐색·전수 시험만 빠진다", "필요하면 ARTEMIS 설치 후 `mcp --install claude`")
    try:
        __import__("PIL")
        pil = sys.executable
    except ImportError:
        pil = ctx.cfg.get("python_image") if ctx.cfg.get("python_image") and os.path.exists(ctx.cfg["python_image"]) else None
    row("반응 측정(Pillow)", bool(pil) or None, pil or "없음", "" if pil else "`pip install pillow` 또는 설정 python_image")
    if ready and (ctx.a.serial or len(ready) == 1):
        st = logwatch_state(ctx)
        info = json.load(open(st, encoding="utf-8")) if os.path.exists(st) else None
        on = bool(info and pid_alive(info["pid"]))
        row("로그 수집기", on or None, info["file"] if on else "꺼짐", "" if on else "긴 테스트 전 `logwatch start`(기기 로그는 1~2분이면 밀려난다)")
    if ctx.a.json:
        return print(json.dumps({"verdict": verdict, "checks": rows}, ensure_ascii=False, indent=2))
    mark = {True: "✅", False: "❌", None: "⚠️"}
    for r in rows:
        print(f"{mark[r['ok']]} {r['check']:<14} {r['detail']}" + (f"\n      → {r['fix']}" if r["fix"] else ""))
    print(f"\n판정: {verdict}")


def cmd_session_start(ctx):
    """세션 시작 훅 — 파일 존재만 본다. 기기·네트워크에 닿지 않는다."""
    if not os.path.exists(ctx.cfg_path):
        return
    adb = ctx.cfg.get("adb")
    if adb and not os.path.exists(adb) and not shutil.which(adb):
        print(f"[android-check] 설정의 adb 를 찾을 수 없습니다: {adb}")


# ───────────────────────── 진입점 ─────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=["setup", "doctor", "elements", "tap", "back", "rotate", "screenshot",
                                   "logwatch", "app", "runner", "session-start"])
    p.add_argument("arg", nargs="?")
    for o in ("--data-dir", "--serial", "--display", "--package", "--shot", "--since", "--type", "--project-dir",
              "--run-args", "--install-task"):
        p.add_argument(o)
    p.add_argument("--measure", action="store_true")
    p.add_argument("--log", action="store_true")
    p.add_argument("--errors", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--force", action="store_true")
    p.add_argument("--timeout", type=float, default=6.0)
    p.add_argument("--tail", type=int)
    p.add_argument("--wait", type=int)
    a = p.parse_args()
    ctx = Ctx(a)

    simple = {"setup": cmd_setup, "doctor": cmd_doctor, "logwatch": cmd_logwatch, "app": cmd_app,
              "runner": cmd_runner, "session-start": cmd_session_start}
    if a.cmd in simple:
        return simple[a.cmd](ctx)
    if a.cmd == "elements":
        els = elements(ctx)
        if a.json:
            return print(json.dumps(els, ensure_ascii=False))
        for i, e in enumerate(els):
            print(f"{i:3} {'●' if e['clickable'] else ' '} {e['label'][:30]!r:34} {e['id'][-28:]:28} {e['cls'][:16]:16} {tuple(e['center'])}")
        return
    need_pillow(ctx) if (a.measure or a.cmd == "screenshot" or a.shot) else None
    display = ctx.display()
    if a.cmd == "screenshot":
        capture(ctx, display).save(a.arg or "screen.png")
        return print("저장:", a.arg or "screen.png")
    if a.cmd == "tap":
        (x, y), name = find(ctx, a.arg)
        action, label = (lambda: ctx.run(["shell", "input", "tap", str(x), str(y)])), f"탭 '{name}' ({x},{y})"
    elif a.cmd == "rotate":
        action, label = (lambda: rotate(ctx, a.arg)), f"화면 회전 {a.arg}"
    else:
        action, label = (lambda: ctx.run(["shell", "input", "keyevent", "KEYCODE_BACK"])), "뒤로 가기"
    since = device_time(ctx) if a.log else None
    result = {"action": label}
    if a.measure:
        result.update(act_and_measure(ctx, display, action, a.timeout))
    else:
        action()
        time.sleep(1.0 if (a.log or a.shot) else 0)
    if a.shot:
        capture(ctx, display).save(a.shot)
        result["shot"] = a.shot
    if a.log:
        lines, errors, warns, touch = logs_since(ctx, since, a.package)
        result.update({"touch": touch, "log_lines": len(lines), "errors": errors[:20], "warnings": warns[:10],
                       "log_tail": lines[-8:]})
    if a.json:
        return print(json.dumps(result, ensure_ascii=False))
    print(label, {k: v for k, v in result.items() if k in ("sent_s", "first_change_s", "settled_s", "shot")})
    if a.log:
        if result["touch"]:
            print(("  ✋ 터치: " if result["touch"] == "앱에 닿음" else "  ⛔ 터치: ") + result["touch"])
        print(f"그 사이 로그 {result['log_lines']}줄 / 오류 {len(result['errors'])}줄 / 성능 경고 {len(result['warnings'])}줄")
        for l in result["errors"]:
            print("  🔴", l[:220])
        for l in result["warnings"]:
            print("  🟡", l[:220])
        for l in result["log_tail"]:
            print("   ", l[:200])


if __name__ == "__main__":
    main()
