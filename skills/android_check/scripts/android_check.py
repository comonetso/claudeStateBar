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
  flow save <이름> --session <ARTEMIS trace_id> [--keep-all]   ARTEMIS 가 찾은 길을 단계 목록으로 굳힌다
  flow run <이름> [--from-step N] [--find-timeout 초]          폰 하네스로 AI 없이 다시 돌린다(막히면 그 단계)
  flow show|script <이름> / flow list
공통: --data-dir(비공개 설정 폴더, 보통 ${CLAUDE_PLUGIN_DATA}) --serial --display --json
"""

import argparse
import io
import json
import math
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
        self.cfg.setdefault("deny_packages", [])
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
        t0, state = time.time(), None
        deadline = t0 + (a.wait or 600)
        if os.path.exists(sp):
            os.remove(sp)  # 지난 실행의 상태 파일을 새 실행 것으로 착각하지 않게
        while time.time() < deadline:  # 첫 빌드는 몇 분 걸린다 — 'app.started'(다 뜸)까지 기다린다
            time.sleep(2)
            if os.path.exists(sp):
                try:
                    state = json.load(open(sp, encoding="utf-8"))
                except ValueError:
                    continue
                if state.get("ready") or state.get("error"):
                    break
            if not pid_alive(p.pid):
                break
        if not state or not state.get("ready"):
            sys.exit(f"앱이 뜨지 않았습니다(마지막 진행: {state and state.get('progress')}). "
                     f"`app log --package {package}` 로 빌드 로그를 보세요. {state and state.get('error') or ''}")
        return print(f"실행 완료 {round(time.time() - t0)}초 — appId={state['appId']} (Claude 가 맡음)")
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
            if ev == "app.start":  # 시작 요청 — 빌드·설치는 이 뒤에 한다
                st["appId"] = params.get("appId")
                write_state()
            elif ev == "app.started":  # 앱이 기기에서 다 떴다 — 여기서부터 reload 가 된다
                st["ready"] = True
                write_state()
            elif ev == "app.progress" and params.get("message"):
                st["progress"] = params["message"]
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


# ───────────────────────── 길 굳히기 — ARTEMIS 가 찾은 길을 폰 하네스로 다시 돌린다 ─────────────────────────
# 처음 보는 흐름은 ARTEMIS 가 화면을 보며 찾고(느리고 AI 비용), 찾은 길은 여기서 단계 목록으로 굳혀
# 폰 하네스(phone-harness, adb 위 파이썬 도우미)로 AI 없이 다시 돌린다. 막히면 그 단계 번호와 화면 글을
# 돌려주니, 그 자리부터 다시 ARTEMIS 에 맡긴다.

SAME_SCREEN_DHASH = 4  # ARTEMIS 실측값(artemis.jsonc similarity_max_distance 주석: 같은 화면 ≤4, 다른 화면 ≥7)
DROP_ACTIONS = {"report_task_status", "discard"}  # 끝 보고·버린 동작 — 화면을 움직이지 않는다


def flows_dir(ctx):
    return os.path.join(ctx.data_dir, "flows")


def flow_path(ctx, name):
    return os.path.join(flows_dir(ctx), re.sub(r'[\\/:*?"<>|\s]+', "_", name) + ".json")


def artemis_db(ctx):
    art = ctx.cfg.get("artemis_dir") or artemis_dir_from_claude()
    p = art and os.path.join(art, "traces", "data_engine.db")
    if not p or not os.path.exists(p):
        sys.exit("ARTEMIS 실행 기록(traces/data_engine.db)을 찾지 못했습니다. `doctor` 로 ARTEMIS 위치를 보세요.")
    return p


def dhash_distance(a, b):
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (TypeError, ValueError):
        return None


def flow_db_snapshot(path):
    """원본 DB/WAL 은 바이트로만 읽고, 확정된 WAL 페이지를 RAM 에 합친다."""
    import sqlite3
    import struct
    from pathlib import Path

    path, wal_path = Path(path), Path(str(path) + "-wal")
    files = [path] + ([wal_path] if wal_path.exists() else [])
    before = [(p.stat().st_size, p.stat().st_mtime_ns) for p in files]
    data = bytearray(path.read_bytes())
    wal = wal_path.read_bytes() if wal_path in files else b""
    after = [(p.stat().st_size, p.stat().st_mtime_ns) for p in files]
    if before != after or wal_path.exists() != (wal_path in files):
        sys.exit("ARTEMIS 기록이 읽는 동안 바뀌었습니다. 잠시 뒤 다시 저장하세요.")
    if len(data) < 100 or data[:16] != b"SQLite format 3\0":
        sys.exit("ARTEMIS DB 헤더를 읽지 못했습니다.")
    page_size = int.from_bytes(data[16:18], "big")
    page_size = 65536 if page_size == 1 else page_size
    if wal:
        if len(wal) < 32:
            sys.exit("ARTEMIS WAL 헤더가 불완전합니다. 다시 저장하세요.")
        magic, version, wp, _, salt1, salt2, c1, c2 = struct.unpack(">8I", wal[:32])
        if magic not in (0x377f0682, 0x377f0683) or version != 3007000 or wp != page_size:
            sys.exit("ARTEMIS WAL 형식을 확인하지 못했습니다.")
        byteorder = "big" if magic & 1 else "little"

        def checksum(buf, a=0, b=0):
            for offset in range(0, len(buf), 8):
                x = int.from_bytes(buf[offset:offset + 4], byteorder)
                y = int.from_bytes(buf[offset + 4:offset + 8], byteorder)
                a = (a + x + b) & 0xffffffff
                b = (b + y + a) & 0xffffffff
            return a, b

        if checksum(wal[:24]) != (c1, c2):
            sys.exit("ARTEMIS WAL 체크섬이 맞지 않습니다.")
        frames, committed, dbsize = [], 0, 0
        size = 24 + page_size
        for offset in range(32, len(wal) - size + 1, size):
            pg, n, s1, s2, a, b = struct.unpack(">6I", wal[offset:offset + 24])
            body = wal[offset + 24:offset + size]
            if not pg or (s1, s2) != (salt1, salt2):
                break  # WAL 재사용 뒤 남은 옛 frame
            if checksum(wal[offset:offset + 8] + body, c1, c2) != (a, b):
                break  # 아직 확정되지 않은 꼬리
            c1, c2 = a, b
            frames.append((pg, body))
            if n:
                committed, dbsize = len(frames), n
        if committed:
            data.extend(b"\0" * max(0, dbsize * page_size - len(data)))
            for pg, body in frames[:committed]:
                if pg <= dbsize:
                    data[(pg - 1) * page_size:pg * page_size] = body
            del data[dbsize * page_size:]
    data[18:20] = b"\x01\x01"  # RAM DB 가 원본 WAL 을 다시 열지 않게 한다
    con = sqlite3.connect(":memory:")
    try:
        con.deserialize(bytes(data))
        con.execute("pragma query_only=ON")
        if con.execute("pragma integrity_check").fetchall() != [("ok",)]:
            sys.exit("ARTEMIS 기록의 일관성을 확인하지 못했습니다.")
    except BaseException:
        con.close()
        raise
    return con


def locked_app_from_log(db_path, sid):
    """앱을 잠그고 돈 ARTEMIS 실행(--locked-app)이면 그 패키지. 실행 로그의 잠금 준비 줄과 시작 전경 줄이
    같은 앱을 가리킬 때만 믿는다. 잠근 실행은 그 앱 밖으로 나가지 못하므로 키보드·오버레이가 섞인 화면에서도
    전경 근거가 된다(2026-11-10 실측: 설정 앱 실행 기록의 화면 tree 에 키보드 노드가 더 많았다)."""
    log = os.path.join(os.path.dirname(db_path), sid, "stdout.log")
    try:
        with open(log, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return ""
    lock = re.search(r"Preparing app lock for: ([\w.]+)", text)
    cur = re.search(r"Current foreground app: ([\w.]+)", text)
    return lock.group(1) if lock and cur and lock.group(1) == cur.group(1) else ""


def recorded_foreground(con, image, meta=None, locked=""):
    """이름 추측 대신 기록의 전경 값, 잠근 실행이면 화면에 있는 잠근 앱, 아니면 한 앱만 남는 UI tree 를 사용한다."""
    meta = meta or {}
    pkg = meta.get("foreground_app")
    if pkg:
        return {"package": pkg, "activity": meta.get("foreground_activity") or ""}
    row = con.execute("select ui_tree from images where image_name=?", (image,)).fetchone()
    if not row or not row[0]:
        return {}
    try:
        tree = json.loads(row[0])
    except ValueError:
        return {}
    packages = set()

    def walk(nodes):
        for node in nodes if isinstance(nodes, list) else [nodes]:
            if not isinstance(node, dict):
                continue
            p = node.get("package") or node.get("packageName")
            if p and p not in ("android", "com.android.systemui"):
                packages.add(p)
            walk(node.get("children", []))

    walk(tree)
    if locked and locked in packages:
        return {"package": locked, "activity": ""}
    return {"package": packages.pop(), "activity": ""} if len(packages) == 1 else {}


def flow_from_artemis(ctx, session):
    """ARTEMIS 실행 기록의 단계들을 대본 단계로 옮긴다. 화면이 안 바뀐 헛동작은 뺀다(--keep-all 이면 둔다)."""
    db_path = artemis_db(ctx)
    con = flow_db_snapshot(db_path)
    locked = ""
    try:
        q = ("select session_id, step_number, action_taken, summary, extra_metadata, pre_image_name, post_image_name "
             "from steps where session_id {} order by cast(step_number as integer)")
        rows = con.execute(q.format("= ?"), (session,)).fetchall() or con.execute(q.format("like ?"), (session + "%",)).fetchall()
        sids = sorted({r[0] for r in rows})
        if len(sids) == 1:
            state = con.execute("select status from sessions where session_id=?", (sids[0],)).fetchone()
            if not state or state[0] != "completed":
                sys.exit("성공 완료(completed)한 ARTEMIS 실행만 저장할 수 있습니다.")
            locked = locked_app_from_log(db_path, sids[0])
        foregrounds = [recorded_foreground(con, r[5], json.loads(r[4] or "{}"), locked) for r in rows]
        posts = [recorded_foreground(con, r[6], None, locked) for r in rows]
    finally:
        con.close()
    sids = sorted({r[0] for r in rows})
    if not rows:
        sys.exit(f"ARTEMIS 기록에 '{session}' 실행이 없습니다(mobile_run_task 가 돌려준 trace_id 를 쓰세요).")
    if len(sids) > 1:
        sys.exit(f"'{session}' 로 시작하는 실행이 여럿입니다: {sids}")
    steps, skipped = [], []
    for index, (_sid, num, act, summary, meta, _pre, _post) in enumerate(rows):
        num = int(num)
        try:
            d = json.loads(act or "{}")
            m = json.loads(meta or "{}")
        except ValueError:
            skipped.append({"step": num, "why": "기록을 읽지 못함"})
            continue
        kind, args = d.get("action"), d.get("args") or {}
        if kind in DROP_ACTIONS:
            continue
        goal = (args.get("target_description") or (summary or "").split(";")[0])[:200]
        # 지문(64비트 dHash)만으로는 헛동작을 가리지 못한다 — 흰 바탕 목록 화면끼리는 거리 0 이 나온다
        # (2026-11-10 A31 실측: 설정 메인에서 '디스플레이' 를 누른 진짜 동작이 전후·다음 단계 사진 모두 거리 0).
        # 그래서 화면이 안 바뀐 데다 바로 다음 단계가 같은 동작을 다시 할 때만(재시도) 앞의 것을 뺀다.
        nxt_meta, nxt_act = {}, {}
        if index + 1 < len(rows):
            try:
                nxt_meta = json.loads(rows[index + 1][4] or "{}")
                nxt_act = json.loads(rows[index + 1][2] or "{}")
            except ValueError:
                nxt_meta, nxt_act = {}, {}
        gaps = [g for g in (dhash_distance(m.get("pre_image_dhash"), m.get("post_image_dhash")),
                            dhash_distance(m.get("pre_image_dhash"), nxt_meta.get("pre_image_dhash"))) if g is not None]
        moved = max(gaps) if gaps else None
        same_key = lambda x: (x.get("action"), x.get("target_text") or "", x.get("target_resource_id") or "",
                              json.dumps(x.get("normalized_coordinates") or x.get("args", {}).get("key")))
        retried = bool(nxt_act) and same_key(nxt_act) == same_key(d)
        if (kind in ("click", "tap", "long_press", "long_press_on", "swipe", "swipe_direction", "press_key")
                and moved is not None and moved <= SAME_SCREEN_DHASH and retried and not ctx.a.keep_all):
            skipped.append({"step": num, "action": kind, "why": f"화면이 안 바뀌어 바로 다시 한 동작(지문 거리 {moved})"})
            continue
        norm = d.get("normalized_coordinates")
        if norm is None and d.get("coordinate_space") == "normalized":
            norm = d.get("coordinates")
        target = {"text": d.get("target_text") or "", "id": d.get("target_resource_id") or "",
                  "norm": norm[:2] if norm else None}
        base = {"from": num, "goal": goal, "expect": foregrounds[index]}
        if kind in ("click", "tap"):
            steps.append({"do": "tap", **target, **base})
        elif kind in ("long_press", "long_press_on"):
            steps.append({"do": "long_press", **target, **base})
        elif kind == "swipe":
            a_ = d.get("normalized_start_coordinates") or (norm[:2] if norm and len(norm) >= 4 else None)
            b_ = d.get("normalized_end_coordinates") or (norm[2:4] if norm and len(norm) >= 4 else None)
            if not (a_ and b_):
                skipped.append({"step": num, "action": kind, "why": "밀기 좌표가 화면 비율로 남지 않음"})
                continue
            steps.append({"do": "swipe", "norm": a_, "norm_to": b_, **base})
        elif kind == "swipe_direction":
            steps.append({"do": "swipe_dir", "direction": d.get("direction") or args.get("direction"), **base})
        elif kind == "press_key":
            steps.append({"do": "key", "key": str(args.get("key") or d.get("key") or ""), **base})
        elif kind == "wait_for_delay":
            steps.append({"do": "wait", "ms": args.get("time_in_ms", d.get("time_in_ms", 1000)), **base})
        elif kind in ("input_text", "focus_and_input_text"):
            value = d.get("text") if d.get("text") is not None else args.get("text", "")
            clear = (args.get("clear_exist", d.get("clear_exist", True)) if kind == "input_text" else
                     d.get("clear_before_input", d.get("clear_existing", args.get("clear_existing", False))))
            has_target = any((target["text"], target["id"], target["norm"]))
            if args.get("target") is not None and not has_target:
                skipped.append({"step": num, "action": kind, "why": "입력 대상을 기록에서 복원할 수 없음"})
                continue
            steps.append({"do": "input" if kind == "focus_and_input_text" or has_target else "type", **target,
                          "value": value, "clear": clear, **base})
        elif kind in ("launch_app", "launch") or (kind == "manage_app" and args.get("action", "launch") == "launch"):
            # 다음 단계 직전 화면은 이 동작 뒤의 관측이다. app_name 은 패키지로 믿지 않는다.
            after = foregrounds[index + 1] if index + 1 < len(rows) else posts[index]
            pkg = after.get("package")
            if not pkg:
                skipped.append({"step": num, "action": kind, "why": "실행 뒤 전경 패키지를 확인하지 못함"})
                continue
            steps.append({"do": "launch", "package": pkg, **base})
        else:  # execute_shell·stop_app 같은 것은 대본에 옮기지 않는다(셸 명령을 그대로 되풀이하면 위험하다)
            skipped.append({"step": num, "action": kind, "why": "대본으로 옮기지 않는 동작"})
    unsupported = [s for s in skipped if s.get("action") != "execute_shell" and "화면이 안 바뀌" not in s["why"]]
    if unsupported:
        sys.exit("미지원 단계 있음 — 부분 flow 를 저장하지 않습니다: " + json.dumps(unsupported, ensure_ascii=False))
    return {"source": {"artemis_session": sids[0]}, "start": steps[0]["expect"] if steps else {},
            "steps": steps, "skipped": skipped}


def validate_flow(flow, start, timeout, deny_packages=()):
    """대본 생성·기기 선택보다 먼저 전체 단계를 검증한다(건너뛸 단계도 포함)."""
    def reject(why):
        raise ValueError("flow 검증 실패: " + why)

    def number(value):
        return type(value) in (int, float) and math.isfinite(value) and value >= 0

    def package(value):
        return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+", value)

    steps = flow.get("steps") if isinstance(flow, dict) else None
    if not isinstance(steps, list) or not steps or type(start) is not int or not 1 <= start <= len(steps):
        reject("1 ≤ --from-step ≤ 단계 수여야 합니다.")
    if not number(timeout):
        reject("찾기 시간은 유한한 0 이상 숫자여야 합니다.")
    if not isinstance(deny_packages, (list, tuple)) or any(not package(p) for p in deny_packages):
        reject("deny_packages 는 패키지 이름 목록이어야 합니다.")
    if not isinstance(flow.get("start"), dict) or not package(flow["start"].get("package")):
        reject("시작 전경 기록이 없습니다. ARTEMIS 기록에서 다시 저장하세요.")
    for i, s in enumerate(steps, 1):
        if not isinstance(s, dict) or s.get("do") not in ("tap", "long_press", "input", "type", "swipe", "swipe_dir", "key", "wait", "launch"):
            reject(f"{i}단계의 do 를 알 수 없습니다.")
        expect = s.get("expect")
        if not isinstance(expect, dict) or not package(expect.get("package")):
            reject(f"{i}단계의 전경 패키지 기록이 없습니다.")
        if not isinstance(expect.get("activity", ""), str):
            reject(f"{i}단계 activity 가 문자열이 아닙니다.")
        for key in ("norm", "norm_to"):
            v = s.get(key)
            if v is not None and (not isinstance(v, (list, tuple)) or len(v) != 2 or
                                  any(not number(n) or n > 1000 for n in v)):
                reject(f"{i}단계 {key} 은 0~1000 좌표 두 개여야 합니다.")
        do = s["do"]
        if do in ("tap", "long_press", "input") and not (s.get("text") or s.get("id") or s.get("norm") is not None):
            reject(f"{i}단계 대상이 없습니다.")
        if any(not isinstance(s.get(k, ""), str) for k in ("text", "id")):
            reject(f"{i}단계 대상 이름은 문자열이어야 합니다.")
        if do == "swipe" and (s.get("norm") is None or s.get("norm_to") is None):
            reject(f"{i}단계 밀기 좌표가 없습니다.")
        if do == "swipe_dir" and s.get("direction") not in ("up", "down", "left", "right"):
            reject(f"{i}단계 밀기 방향이 잘못됐습니다.")
        if do == "key" and (not isinstance(s.get("key"), str) or
                            not re.fullmatch(r"[A-Za-z0-9_]+", s["key"]) or
                            not s["key"].upper().replace("KEYCODE_", "")):
            reject(f"{i}단계 key 가 비었거나 잘못됐습니다.")
        if do == "wait" and not number(s.get("ms")):
            reject(f"{i}단계 기다림은 유한한 0 이상 숫자여야 합니다.")
        if do in ("input", "type") and (not isinstance(s.get("value"), str) or type(s.get("clear", False)) is not bool):
            reject(f"{i}단계 입력 값·clear 형식이 잘못됐습니다.")
        if do == "launch" and not package(s.get("package")):
            reject(f"{i}단계 실행 패키지가 잘못됐습니다.")
    if flow["start"] != steps[0]["expect"]:
        reject("시작 전경과 첫 단계의 전경 기록이 다릅니다.")


FLOW_RUNNER = r'''
import base64, json, re, time
import xml.etree.ElementTree as ET
FLOW = json.loads(base64.b64decode("@@FLOW@@").decode("utf-8"))
START, FIND_TIMEOUT = @@START@@, @@TIMEOUT@@
DENY_PACKAGES = @@DENY@@


def _px(norm):
    return min(W - 1, int(norm[0] * W / 1000)), min(H - 1, int(norm[1] * H / 1000))


def _say(tag, **kw):
    print(tag, json.dumps(kw, ensure_ascii=False), flush=True)


def _find(step):
    want_id, want_text = step.get("id") or "", step.get("text") or ""
    deadline = time.time() + FIND_TIMEOUT
    while True:
        _guard(i, step)
        nodes = ui()
        _guard(i, step)
        by_id = [n for n in nodes if want_id and n["id"] == want_id]
        if want_text:
            # 정확히 같은 이름만 — 포함 검색은 그 글자를 문장 속에 품은 글 덩어리·다른 단추를 잡는다
            # (2026-11-10 실측: 닫힌 패널의 '사이드바 닫기' 를 찾다가 대화 글 덩어리를 눌렀다).
            # 이름이 있으면 이름이 먼저다 — 아이디는 목록 항목끼리 같을 수 있다(2026-11-10 Z 플립6 실측:
            # 설정 목록 제목이 모두 android:id/title 이라 '디스플레이' 대신 기록된 자리에 가까운 '배터리' 를 눌렀다).
            named = find_nodes(want_text, exact=True, nodes=nodes)
            hits = [n for n in named if n in by_id] or named
        else:
            hits = by_id
        if hits:
            tx, ty = _px(step["norm"]) if step.get("norm") else (0, 0)
            # 누를 수 있는 것 먼저, 그다음 기록된 자리에 가까운 것
            hits.sort(key=lambda n: (not n["clickable"], (n["x"] - tx) ** 2 + (n["y"] - ty) ** 2))
            return hits[0], nodes
        if time.time() >= deadline:
            return None, nodes
        time.sleep(0.5)


def _stuck(i, step, nodes, why):
    seen = [n["text"] or n["desc"] for n in nodes if n["text"] or n["desc"]][:20]
    _say("FLOW_STUCK", step=i, goal=step.get("goal", ""), want=step.get("text") or step.get("id") or "",
         why=why, visible=seen)
    raise SystemExit(3)


def _guard(i, step, initial=False):
    expected = step["expect"]["package"]
    now = current_app()
    if now in DENY_PACKAGES:
        _stuck(i, step, [], "금지 앱이 전경이다: " + now)
    if not now or now != expected:
        _stuck(i, step, [], ("시작 앱이 다르다" if initial else "동작 전 앱이 다르다") +
               f": 기대 {expected}, 지금 {now or '확인 안 됨'}")
    activity = step["expect"].get("activity") if initial else None
    if activity:
        out = shell("dumpsys activity activities")
        m = (re.search(r"topResumedActivity=ActivityRecord\{[^}]*?\bu\d+ ([\w.]+/[\w.$]+)", out)
             or re.search(r"mResumedActivity: ActivityRecord\{[^}]*?\bu\d+ ([\w.]+/[\w.$]+)", out))
        actual = m.group(1) if m else "확인 안 됨"
        if actual != activity:
            _stuck(i, step, [], f"시작 activity 가 다르다: 기대 {activity}, 지금 {actual}")


def _focused(i, step, point=None, previous=None):
    # ui() 는 focused/password 속성을 버린다. 같은 UIAutomator 원본에서 확인한다.
    _guard(i, step)
    raw = shell("uiautomator dump /dev/tty")
    try:
        root = ET.fromstring(raw[raw.index("<?xml"):raw.rfind(">") + 1])
    except (ValueError, ET.ParseError):
        _stuck(i, step, [], "입력 포커스·지우기 결과를 읽지 못했다")
    fields = [n for n in root.iter("node") if n.get("focused") == "true" and
              n.get("class", "").endswith(("EditText", "AutoCompleteTextView")) and
              n.get("package") == step["expect"]["package"]]
    if len(fields) != 1 or fields[0].get("password") == "true":
        _stuck(i, step, [], "읽을 수 있는 입력 칸의 포커스를 확인하지 못했다")
    field = dict(fields[0].attrib)
    bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", field.get("bounds", ""))
    if not bounds:
        _stuck(i, step, [], "입력 칸 영역을 확인하지 못했다")
    x1, y1, x2, y2 = map(int, bounds.groups())
    if ((point is not None and not (x1 <= point[0] < x2 and y1 <= point[1] < y2)) or
            (step.get("id") and field.get("resource-id") != step["id"]) or
            (previous is not None and any(field.get(k) != previous.get(k) for k in ("resource-id", "bounds")))):
        _stuck(i, step, [], "기록된 입력 칸과 포커스가 다르다")
    _guard(i, step)
    return field


def _input(i, step, point=None):
    field = _focused(i, step, point)
    before = field.get("text", "")
    if step.get("clear") and before:
        _guard(i, step)
        shell("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A")
        _guard(i, step)
        shell("input keyevent KEYCODE_DEL")
        field = _focused(i, step, point, field)
        if field.get("text", "") != "":
            _stuck(i, step, [], "입력 칸을 확실히 지우지 못했다 — 입력을 보내지 않는다")
        before = ""
    _guard(i, step)
    if type_text(step["value"]) is False:
        _stuck(i, step, [], "입력 helper 가 실패했다")
    after = _focused(i, step, point, field)
    if after.get("text", "") != before + step["value"]:
        _stuck(i, step, [], "입력 결과가 기대한 값과 다르다")


def _key(name):
    name = re.sub(r"[^A-Z0-9_]", "", (name or "").upper().replace("KEYCODE_", ""))
    if name == "BACK":
        back()
    elif name == "HOME":
        home()
    else:
        shell("input keyevent KEYCODE_" + name)


t_all = time.time()
_guard(START, FLOW["steps"][START - 1], initial=True)
_sizes = re.findall(r"(\d+)x(\d+)", shell("wm size"))
W, H = map(int, _sizes[-1])  # Override size 가 있으면 그것이 마지막 줄
final_stable, stable_error = False, ""
for i, step in enumerate(FLOW["steps"], 1):
    if i < START:
        continue
    t0, do, how, node = time.time(), step["do"], "", None
    _guard(i, step)
    if do in ("input", "type") and not step["value"].isascii():
        _stuck(i, step, [], "이 Android type_text 경로는 한글 등 비ASCII 입력을 확인할 수 없다")
    if do in ("tap", "long_press", "input"):
        if step.get("text") or step.get("id"):
            node, nodes = _find(step)
            if node is None:  # 글자가 기록돼 있는데 안 보이면 화면이 다르다 — 좌표로 엉뚱한 곳을 누르지 않는다
                _stuck(i, step, nodes, "기록된 글자가 화면에 없다")
            (x, y), how = (node["x"], node["y"]), "글자"
        elif step.get("norm"):
            (x, y), how = _px(step["norm"]), "좌표"
        else:
            _stuck(i, step, [], "누를 곳 정보가 없다")
        if do == "long_press":
            _guard(i, step)
            result = long_press(x, y)
        else:
            _guard(i, step)
            result = tap(x, y)
        if result is False:  # Android 정상 반환 None 은 실패가 아니다
            _stuck(i, step, [], "동작 helper 가 실패했다")
        if do == "input":
            _input(i, step, (x, y))
    elif do == "type":
        _input(i, step)
        how = "입력"
    elif do == "swipe":
        (x1, y1), (x2, y2) = _px(step["norm"]), _px(step["norm_to"])
        _guard(i, step)
        drag(x1, y1, x2, y2)
        how = "밀기"
    elif do == "swipe_dir":
        _guard(i, step)
        swipe(str(step.get("direction") or "up").lower())
        how = "밀기"
    elif do == "key":
        _guard(i, step)
        _key(step.get("key"))
        how = "키"
    elif do == "wait":
        wait(step.get("ms", 1000) / 1000)
        how = "기다림"
    elif do == "launch":
        if step["package"] in DENY_PACKAGES:
            _stuck(i, step, [], "실행 대상이 금지 앱이다: " + step["package"])
        _guard(i, step)
        shell("monkey -p " + re.sub(r"[^A-Za-z0-9._]", "", step["package"]) + " -c android.intent.category.LAUNCHER 1")
        how = "앱 열기"
    nxt = FLOW["steps"][i] if i < len(FLOW["steps"]) else None
    # 다음 단계가 글자로 찾는 단계면 그 글자가 뜰 때까지만 기다리면 된다(_find 가 기다린다).
    # 화면 안정 대기는 시계·경과 시간처럼 계속 바뀌는 글이 있으면 끝까지(6초) 기다리므로 그때만 쓴다.
    # 단 밀기 뒤에는 늘 기다린다 — 목록이 아직 미끄러지는 중에 찾은 자리를 누르면 옆 항목이 눌린다
    # (2026-11-10 Z 플립6 실측: 밀기 직후 '디스플레이' 를 찾아 눌렀는데 '배터리 및 디바이스 케어' 가 열렸다).
    if nxt is None or do in ("swipe", "swipe_dir") or (do != "wait" and not (nxt["do"] in ("tap", "long_press", "input") and (nxt.get("text") or nxt.get("id")))):
        try:
            stable = wait_stable() is True
        except Exception as exc:
            stable, stable_error = False, type(exc).__name__
        if nxt is None:
            final_stable = stable
    _say("FLOW_STEP", step=i, do=do, how=how, s=round(time.time() - t0, 2), goal=step.get("goal", ""),
         at=[x, y] if do in ("tap", "long_press", "input") else None)
_say("FLOW_OK", steps=len(FLOW["steps"]), start=START, s=round(time.time() - t_all, 2),
     final_stable=final_stable, warning="" if final_stable else "끝 화면 안정 확인 안 됨", stable_error=stable_error)
'''


def flow_script(flow, start, timeout, deny_packages=()):
    validate_flow(flow, start, timeout, deny_packages)
    blob = __import__("base64").b64encode(json.dumps(flow, ensure_ascii=False).encode("utf-8")).decode("ascii")
    return (FLOW_RUNNER.replace("@@FLOW@@", blob).replace("@@START@@", str(int(start)))
            .replace("@@TIMEOUT@@", repr(float(timeout))).replace("@@DENY@@", repr(list(deny_packages))))


def phone_harness_bin(ctx):
    return ctx.cfg.get("phone_harness") or shutil.which("phone-harness")


def phone_harness_env(ctx, serial=True):
    env = dict(os.environ, DO_NOT_TRACK="1", PHONE_HARNESS_NO_UPDATE_CHECK="1", PYTHONIOENCODING="utf-8",
               PHONE_HARNESS_PLATFORM="android")
    if serial:
        env["ANDROID_SERIAL"] = ctx.serial
    return env


def describe_step(i, s):
    where = s.get("text") or s.get("id") or (f"좌표 {s['norm']}" if s.get("norm") else "")
    extra = {"swipe": f"{s.get('norm')}→{s.get('norm_to')}", "swipe_dir": s.get("direction"), "key": s.get("key"),
             "wait": f"{s.get('ms')}ms", "launch": s.get("package"),
             "input": f"'{where}' 에 {len(s.get('value') or '')}자 (지우기 {s.get('clear', False)})",
             "type": f"{len(s.get('value') or '')}자 (지우기 {s.get('clear', False)})"}.get(s["do"])
    return f"{i:3} {s['do']:<10} {extra or where!s:40.40} ← ARTEMIS {s.get('from')}단계 {s.get('goal', '')[:60]}"


def cmd_flow(ctx):
    a = ctx.a
    os.makedirs(flows_dir(ctx), exist_ok=True)
    if a.arg == "list":
        names = sorted(f[:-5] for f in os.listdir(flows_dir(ctx)) if f.endswith(".json"))
        for n in names:
            fl = json.load(open(os.path.join(flows_dir(ctx), n + ".json"), encoding="utf-8"))
            print(f"{n:30} 단계 {len(fl['steps']):3} · ARTEMIS {fl['source'].get('artemis_session', '')[:8]} · {fl.get('saved', '')}")
        return print(f"(저장한 길 {len(names)}개 — {flows_dir(ctx)})")
    if a.arg not in ("save", "run", "show", "script") or not a.name:
        sys.exit("사용법: flow save <이름> --session <ARTEMIS trace_id> | flow run <이름> [--from-step N] | "
                 "flow show <이름> | flow script <이름> | flow list")
    path = flow_path(ctx, a.name)
    if a.arg == "save":
        if not a.session:
            sys.exit("--session 이 필요합니다(mobile_run_task 가 돌려준 trace_id, 앞 몇 글자만 줘도 됨).")
        if os.path.exists(path) and not a.force:
            sys.exit(f"'{a.name}' 이 이미 있습니다. 덮어쓰려면 --force")
        fl = flow_from_artemis(ctx, a.session)
        fl.update({"name": a.name, "saved": time.strftime("%Y-%m-%d %H:%M"), "package": a.package or ""})
        if not fl["steps"]:
            sys.exit("옮길 단계가 없습니다(모두 헛동작이거나 옮기지 않는 동작). " + json.dumps(fl["skipped"], ensure_ascii=False))
        try:
            validate_flow(fl, 1, a.find_timeout, ctx.cfg.get("deny_packages", []))
        except ValueError as exc:
            sys.exit(str(exc))
        if os.path.exists(path):
            backup, n = path + ".bak", 0
            while os.path.exists(backup):
                n += 1
                backup = path + f".bak.{n}"
            with open(path, "rb") as src, open(backup, "xb") as dst:
                shutil.copyfileobj(src, dst)
            print(f"기존 flow 보존: {backup} — 새 실행은 기존 전체 경로와 다를 수 있습니다.")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(fl, f, ensure_ascii=False, indent=2)
        print(f"저장: '{a.name}' · 단계 {len(fl['steps'])}개 · 뺀 단계 {len(fl['skipped'])}개 → {path}")
        for i, s in enumerate(fl["steps"], 1):
            print(describe_step(i, s))
        for s in fl["skipped"]:
            print(f"  뺌: ARTEMIS {s['step']}단계 {s.get('action', '')} — {s['why']}")
        typed = sum(len(s.get("value") or "") for s in fl["steps"] if s["do"] in ("input", "type"))
        if typed:
            print(f"⚠️ 입력 글자 {typed}자가 이 파일에 그대로 저장됐습니다 — 비밀번호·인증번호가 섞였으면 지우세요: {path}")
        return
    if not os.path.exists(path):
        sys.exit(f"'{a.name}' 이 없습니다. `flow list` 로 보세요.")
    with open(path, encoding="utf-8") as f:
        fl = json.load(f)
    if a.arg == "show":
        print(f"'{a.name}' · ARTEMIS {fl['source'].get('artemis_session')} · {fl.get('saved', '')}")
        for i, s in enumerate(fl["steps"], 1):
            print(describe_step(i, s))
        return
    start = 1 if a.from_step is None else a.from_step
    try:
        script = flow_script(fl, start, a.find_timeout, ctx.cfg.get("deny_packages", []))
    except ValueError as exc:
        sys.exit(str(exc))
    if a.arg == "script":
        return print(script)
    ph = phone_harness_bin(ctx)
    if not ph:
        sys.exit("폰 하네스가 없습니다: `uv tool install --python 3.12 phone-harness` 뒤 "
                 "`phone-harness config set telemetry false`")
    budget = 60 + sum(a.find_timeout + 15 + (s["ms"] / 1000 if s["do"] == "wait" else 0)
                      for s in fl["steps"][start - 1:])
    t0 = time.time()
    try:
        r = subprocess.run([ph], input=script, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", env=phone_harness_env(ctx), creationflags=NO_WINDOW,
                           timeout=budget)
    except subprocess.TimeoutExpired:
        sys.exit(f"폰 하네스가 {budget}초 안에 끝나지 않았습니다.")
    ok = stuck = None
    done = []
    for line in r.stdout.splitlines():
        tag, _, rest = line.partition(" ")
        if tag == "FLOW_STEP":
            s = json.loads(rest)
            done.append(s)
            if not a.json:
                print(f"  ✅ {s['step']:3} {s['do']:<10} {s['how']:<5} {s['s']:5.1f}초  {s['goal'][:70]}")
        elif tag == "FLOW_STUCK":
            stuck = json.loads(rest)
        elif tag == "FLOW_OK":
            ok = json.loads(rest)
    total = round(time.time() - t0, 1)
    if stuck:
        if a.json:
            print(json.dumps({"status": "stuck", "stuck": stuck, "steps": done, "s": total}, ensure_ascii=False))
            sys.exit(3)
        print(f"  ⛔ {stuck['step']}단계에서 막힘 — {stuck['why']}: '{stuck['want']}'")
        print(f"     이 단계가 하려던 일: {stuck['goal']}")
        print(f"     지금 화면 글: {stuck['visible']}")
        print(f"→ 이 화면에서부터 ARTEMIS 에 '{stuck['goal']}' 를 맡기고, 끝나면 `flow save {a.name} --session <새 trace_id> --force` "
              f"로 다시 굳히세요. 앞 단계를 건너뛰려면 `--from-step {stuck['step']}`. ({total}초)")
        sys.exit(3)
    if not ok or r.returncode != 0:
        if a.json:
            print(json.dumps({"status": "error", "returncode": r.returncode, "steps": done, "s": total}, ensure_ascii=False))
            sys.exit(1)
        print(r.stdout[-2000:], r.stderr[-2000:])
        sys.exit(f"폰 하네스 실행이 끝까지 가지 못했습니다(종료 코드 {r.returncode}, {total}초).")
    warning = "" if ok.get("final_stable") is True else "끝 화면 안정 확인 안 됨"
    if a.json:
        return print(json.dumps({"status": "completed" if not warning else "unverified", "steps": done, "s": total,
                                 "final_stable": not warning, "warning": warning, "result": ok}, ensure_ascii=False))
    label = "동작 종료(안정 미확인)" if warning else "완료"
    print(f"{label}: '{a.name}' {ok['steps'] - start + 1}단계 · {total}초 (폰 하네스 안 {ok['s']}초)")
    if warning:
        print(warning + " — 동작 종료만 확인했으며 목표 달성은 검증하지 않았습니다.")


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
    cfg["deny_packages"] = []
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
    ph = phone_harness_bin(ctx)
    if ph:
        try:  # 사용 기록 전송은 설정을 안 하면 켜져 있다 — off·no 는 무시되고 false·0 만 먹는다(그 저장소 이슈 #145)
            conf = subprocess.run([ph, "config"], capture_output=True, text=True, encoding="utf-8", errors="replace",
                                  timeout=30, env=phone_harness_env(ctx, serial=False), creationflags=NO_WINDOW).stdout
        except (OSError, subprocess.TimeoutExpired):
            conf = ""
        off = bool(re.search(r"^telemetry\s+false\b", conf, re.M))
        row("폰 하네스", True if off else None, f"{ph} · 사용 기록 {'꺼짐' if off else '켜짐 또는 확인 안 됨'}",
            "" if off else "`phone-harness config set telemetry false`")
    else:
        row("폰 하네스", None, "설치 안 됨 — 찾은 길 다시 돌리기(flow run)만 빠진다",
            "`uv tool install --python 3.12 phone-harness` 뒤 `phone-harness config set telemetry false`")
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
                                   "logwatch", "app", "runner", "session-start", "flow"])
    p.add_argument("arg", nargs="?")
    p.add_argument("name", nargs="?")  # flow save|run|show|script <이름>
    for o in ("--data-dir", "--serial", "--display", "--package", "--shot", "--since", "--type", "--project-dir",
              "--run-args", "--install-task", "--session"):
        p.add_argument(o)
    p.add_argument("--from-step", type=int)
    p.add_argument("--find-timeout", type=float, default=10.0)  # 폰 하네스 wait_for_text 의 기본값과 같게
    p.add_argument("--keep-all", action="store_true")
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
              "runner": cmd_runner, "session-start": cmd_session_start, "flow": cmd_flow}
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
