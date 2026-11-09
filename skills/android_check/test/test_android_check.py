"""기기 없이 도는 단위 시험 — python -m unittest discover -s test"""

import contextlib
import copy
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import android_check as ac  # noqa: E402

FLUTTER_XML = """<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.example.app" content-desc="" clickable="false" bounds="[0,0][1080,2640]">
<node index="1" text="" resource-id="" class="android.widget.ImageView" package="com.example.app" content-desc="메뉴" clickable="true" bounds="[16,117][130,230]"/>
<node index="2" text="" resource-id="" class="android.view.View" package="com.example.app" content-desc="검색반경&#10;50Km" clickable="true" bounds="[0,250][532,360]"/>
<node index="3" text="" resource-id="" class="android.view.View" package="com.example.app" content-desc="" clickable="false" bounds="[0,0][0,0]"/>
</node></hierarchy>"""

NATIVE_XML = """<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="계산2동" resource-id="com.example.weather:id/address" class="android.widget.TextView" package="com.example.weather" content-desc="" clickable="false" bounds="[200,320][454,380]"/>
<node index="1" text="" resource-id="com.example.launcher:id/icon_container" class="android.widget.FrameLayout" package="com.example.launcher" content-desc="시계" clickable="true" bounds="[600,330][732,474]"/>
</hierarchy>"""


class ParseElements(unittest.TestCase):
    def test_flutter_content_desc(self):
        els = ac.parse_elements(FLUTTER_XML)
        labels = [e["label"] for e in els]
        self.assertIn("메뉴", labels)
        self.assertIn("검색반경\n50Km", labels)
        menu = next(e for e in els if e["label"] == "메뉴")
        self.assertTrue(menu["clickable"])
        self.assertEqual(menu["center"], [73, 173])

    def test_native_text_and_resource_id(self):
        els = ac.parse_elements(NATIVE_XML)
        addr = next(e for e in els if e["label"] == "계산2동")
        self.assertEqual(addr["id"], "com.example.weather:id/address")
        self.assertEqual(addr["cls"], "TextView")

    def test_nameless_nodes_dropped(self):
        self.assertEqual(len(ac.parse_elements(FLUTTER_XML)), 3)  # 이름도 id 도 없는 노드는 뺀다

    def test_garbage_prefix(self):
        self.assertEqual(len(ac.parse_elements("UI hierchary dumped to: /x\n" + NATIVE_XML)), 2)


class Patterns(unittest.TestCase):
    def test_errors(self):
        for line in ["I/flutter ( 5836): ══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞══",
                     "I/flutter ( 5836): A RenderFlex overflowed by 42 pixels on the bottom.",
                     "E/AndroidRuntime( 9999): FATAL EXCEPTION: main",
                     "E/ActivityManager( 1000): ANR in com.example.app"]:
            self.assertTrue(ac.ERROR_PATTERN.search(line), line)

    def test_warnings_are_not_errors(self):
        line = "I/Choreographer( 5308): Skipped 67 frames!  The application may be doing too much work on its main thread."
        self.assertTrue(ac.WARN_PATTERN.search(line))
        self.assertFalse(ac.ERROR_PATTERN.search(line))

    def test_filter_app(self):
        lines = ["10-04 03:01:30.235 I/VRI( 5308): ViewPostIme pointer 0",
                 "10-04 03:01:30.239 I/InputDispatcher( 2718): Delivering touch to (5308)",
                 "10-04 03:01:31.000 I/Other(15308): not the app"]
        self.assertEqual(ac.filter_app(lines, {"5308"}), lines[:1])  # 본문에 번호가 있는 시스템 줄은 빠진다
        self.assertEqual(ac.filter_app(lines, set()), lines)  # PID 를 모르면 거르지 않는다

    def test_touch_report(self):
        to_app = ("10-04 03:01:30.227 I/InputDispatcher( 2718): Delivering touch to (5308): action: 0x0, f=0x0, d=0, '17b7e2c', t=1\n"
                  "10-04 03:01:30.239 I/InputDispatcher( 2718): Delivering touch to (5308): action: 0x1, f=0x0, d=0, '17b7e2c', t=1")
        self.assertEqual(ac.touch_report(to_app, {"5308"}), "앱에 닿음")
        stolen = "10-04 02:03:48.133 I/InputDispatcher( 2718): Delivering touch to (8701): action: 0x1, f=0x0, d=0, '1b51a28', t=1"
        self.assertIn("앱에 안 닿음 — 받은 창: PID 8701 창 1b51a28", ac.touch_report(stolen, {"5308"}))
        self.assertIsNone(ac.touch_report("no touch here", {"5308"}))
        # 시스템 감시 창 줄만 남고 앱 전달 줄이 빠져도, 앱 창의 포인터 수신 표시가 있으면 닿은 것이다
        sys_only = "10-04 03:04:54.505 I/InputDispatcher( 2718): Delivering touch to (3976): action: 0x0, f=0x0, d=0, '9a7f65f', t=1"
        app_line = ["10-04 03:04:54.505 I/VRI[MainActivity]@6e6b6ad( 5308): ViewPostIme pointer 0"]
        self.assertEqual(ac.touch_report(sys_only, {"5308"}, app_line), "앱에 닿음")


class Secrets(unittest.TestCase):
    def test_env_secret_values_never_kept(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8") as f:
            f.write("GEMINI_API_KEY=AQ.secret-value\nOPENAI_API_KEY=\nARTEMIS_ADB_PATH=C:/sdk/adb.exe\n")
        try:
            env = ac.read_env_names(f.name)
        finally:
            os.unlink(f.name)
        self.assertIs(env["GEMINI_API_KEY"], True)
        self.assertIs(env["OPENAI_API_KEY"], False)
        self.assertEqual(env["ARTEMIS_ADB_PATH"], "C:/sdk/adb.exe")
        self.assertNotIn("AQ.secret-value", repr(env))


class FlowFromArtemis(unittest.TestCase):
    """ARTEMIS 실행 기록(traces/data_engine.db 의 steps) → 대본 단계 변환. 기기 없이 가짜 기록으로."""

    SID = "a0ab3d45-143f-4aaf-a7a6-354388969b0d"

    def setUp(self):
        import json
        import sqlite3
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        os.makedirs(os.path.join(self.tmp, "traces"))
        con = sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))
        con.execute("create table steps (session_id, step_number, action_taken, summary, extra_metadata, pre_image_name, post_image_name)")
        con.execute("create table sessions (session_id, status)")
        con.execute("insert into sessions values (?, 'completed')", (self.SID,))
        con.execute("create table images (image_name, ui_tree)")
        con.execute("insert into images values ('screen', ?)", (json.dumps([{"package": "com.example.app"}]),))

        def step(n, action, same_screen=False):
            meta = {"pre_image_dhash": "69630c8e1713cc33", "post_image_dhash": "69630c8e1713cc33" if same_screen else "1e2d3c4b5a697887"}
            con.execute("insert into steps values (?,?,?,?,?,?,?)",
                        (self.SID, str(n), json.dumps(action, ensure_ascii=False), f"In Step {n}, did a thing; then", json.dumps(meta), "screen", "screen"))
        step(1, {"action": "click", "coordinate_space": "normalized", "normalized_coordinates": [72, 74], "target_text": "메뉴 열기"}, same_screen=True)
        step(2, {"action": "click", "coordinate_space": "normalized", "normalized_coordinates": [72, 74], "target_text": "메뉴 열기"})
        step(3, {"action": "focus_and_input_text", "normalized_coordinates": [500, 900], "target_text": "검색", "text": "강남역", "clear_before_input": True})
        step(4, {"action": "execute_shell", "args": {"command": "pm clear com.example"}})
        step(5, {"action": "press_key", "args": {"key": "BACK"}})
        step(6, {"action": "report_task_status", "args": {"explanation": "done"}})
        con.commit()
        con.close()

    def ctx(self, keep_all=False):
        c = type("C", (), {})()
        c.cfg = {"artemis_dir": self.tmp}
        c.a = type("A", (), {"keep_all": keep_all})()
        return c

    def test_dead_taps_dropped_and_shell_never_copied(self):
        fl = ac.flow_from_artemis(self.ctx(), self.SID[:8])
        self.assertEqual([s["do"] for s in fl["steps"]], ["tap", "input", "key"])
        self.assertEqual(fl["steps"][0]["text"], "메뉴 열기")
        self.assertEqual(fl["steps"][0]["norm"], [72, 74])
        self.assertEqual((fl["steps"][1]["value"], fl["steps"][1]["clear"]), ("강남역", True))
        why = {s["step"]: s["why"] for s in fl["skipped"]}
        self.assertIn("화면이 안 바뀌", why[1])
        self.assertIn("옮기지 않는", why[4])
        self.assertNotIn(6, why)  # 끝 보고는 조용히 뺀다
        self.assertEqual(fl["source"]["artemis_session"], self.SID)

    def test_keep_all_keeps_dead_taps(self):
        fl = ac.flow_from_artemis(self.ctx(keep_all=True), self.SID)
        self.assertEqual([s["do"] for s in fl["steps"]], ["tap", "tap", "input", "key"])

    def test_runner_script_compiles(self):
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        compile(ac.flow_script(fl, 2, 10.0), "<flow>", "exec")

    def test_dhash_distance(self):
        self.assertEqual(ac.dhash_distance("ff", "ff"), 0)
        self.assertEqual(ac.dhash_distance("ff", "fe"), 1)
        self.assertIsNone(ac.dhash_distance(None, "ff"))

    def replace_actions(self, actions, status="completed"):
        with contextlib.closing(sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))) as con, con:
            con.execute("delete from steps")
            con.execute("update sessions set status=?", (status,))
            for n, action in enumerate(actions, 1):
                con.execute("insert into steps values (?,?,?,?,?,?,?)",
                            (self.SID, str(n), json.dumps(action), "fixture", "{}", "screen", "screen"))

    def test_manage_launch_uses_observed_package_not_app_name(self):
        self.replace_actions([{"action": "manage_app", "args": {"action": "launch", "app_name": "Human App Name"}}])
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        self.assertEqual(fl["steps"][0]["do"], "launch")
        self.assertEqual(fl["steps"][0]["package"], "com.example.app")
        self.assertEqual(fl["start"]["package"], "com.example.app")

    def test_launch_without_observation_is_unsupported(self):
        self.replace_actions([{"action": "manage_app", "args": {"action": "launch", "app_name": "com.example.guess"}}])
        with contextlib.closing(sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))) as con, con:
            con.execute("update steps set post_image_name=null")
        with self.assertRaisesRegex(SystemExit, "미지원 단계"):
            ac.flow_from_artemis(self.ctx(), self.SID)

    def test_manage_destructive_actions_are_not_silently_skipped(self):
        for action in ("stop", "clear", "delete"):
            with self.subTest(action=action):
                self.replace_actions([{"action": "manage_app", "args": {"action": action, "app_name": "com.example.app"}}])
                with self.assertRaisesRegex(SystemExit, "미지원 단계"):
                    ac.flow_from_artemis(self.ctx(), self.SID)

    def test_input_text_target_and_default_clear_preserved(self):
        for clear in (None, False, True):
            with self.subTest(clear=clear):
                args = {"target": 40, "text": "query"}
                if clear is not None:
                    args["clear_exist"] = clear
                self.replace_actions([{"action": "input_text", "args": args, "normalized_coordinates": [500, 100],
                                       "target_text": "검색", "target_resource_id": "com.example.app:id/query"}])
                s = ac.flow_from_artemis(self.ctx(), self.SID)["steps"][0]
                self.assertEqual((s["do"], s["norm"], s["text"], s["value"]), ("input", [500, 100], "검색", "query"))
                self.assertIs(s["clear"], True if clear is None else clear)

    def test_unresolved_input_target_is_rejected(self):
        self.replace_actions([{"action": "input_text", "args": {"target": 40, "text": "query"}}])
        with self.assertRaisesRegex(SystemExit, "미지원 단계"):
            ac.flow_from_artemis(self.ctx(), self.SID)

    def test_failed_running_missing_session_status_rejected(self):
        for status in ("failed", "running", "paused", None):
            with self.subTest(status=status):
                self.replace_actions([{"action": "press_key", "args": {"key": "BACK"}}], status)
                with self.assertRaisesRegex(SystemExit, "성공 완료"):
                    ac.flow_from_artemis(self.ctx(), self.SID)

    def test_unknown_action_rejected_but_shell_reported(self):
        self.replace_actions([{"action": "future_action"}])
        with self.assertRaisesRegex(SystemExit, "미지원 단계"):
            ac.flow_from_artemis(self.ctx(), self.SID)
        self.replace_actions([{"action": "execute_shell"}, {"action": "press_key", "args": {"key": "BACK"}}])
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        self.assertEqual(fl["skipped"][0]["action"], "execute_shell")

    def test_start_and_each_step_foreground_recorded(self):
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        self.assertEqual(fl["start"], {"package": "com.example.app", "activity": ""})
        self.assertTrue(all(s["expect"] == fl["start"] for s in fl["steps"]))

    def test_multiple_app_tree_does_not_guess_foreground(self):
        with contextlib.closing(sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))) as con, con:
            con.execute("update images set ui_tree=?", (json.dumps([{"package": "com.example.app"},
                                                                   {"package": "com.example.keyboard"}]),))
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        with self.assertRaisesRegex(ValueError, "시작 전경"):
            ac.validate_flow(fl, 1, 10)

    def test_explicit_foreground_and_activity_take_precedence(self):
        with contextlib.closing(sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))) as con, con:
            con.execute("update steps set extra_metadata=?", (json.dumps({"foreground_app": "com.example.real",
                                                                        "foreground_activity": "com.example.real/.Main"}),))
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        self.assertEqual(fl["start"], {"package": "com.example.real", "activity": "com.example.real/.Main"})
        ac.validate_flow(fl, 1, 10)

    def test_slow_screen_tap_kept_when_next_step_screen_changed(self):
        # 느린 폰: 누른 직후 사진은 그대로(거리 0)지만 다음 단계 직전 사진은 바뀌었다 → 진짜 동작으로 남긴다
        same, other = "69630c8e1713cc33", "1e2d3c4b5a697887"
        with contextlib.closing(sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))) as con, con:
            con.execute("delete from steps")
            rows = [(1, {"action": "click", "coordinate_space": "normalized", "normalized_coordinates": [500, 300], "target_text": "디스플레이"},
                     {"pre_image_dhash": same, "post_image_dhash": same}),
                    (2, {"action": "press_key", "args": {"key": "HOME"}}, {"pre_image_dhash": other, "post_image_dhash": same})]
            for n, act, meta in rows:
                con.execute("insert into steps values (?,?,?,?,?,?,?)",
                            (self.SID, str(n), json.dumps(act, ensure_ascii=False), "fixture", json.dumps(meta), "screen", "screen"))
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        self.assertEqual([s["do"] for s in fl["steps"]], ["tap", "key"])
        self.assertEqual(fl["steps"][0]["text"], "디스플레이")

    def write_run_log(self, lock, current):
        d = os.path.join(self.tmp, "traces", self.SID)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "stdout.log"), "w", encoding="utf-8") as f:
            f.write(f"ℹ [web_1_{self.SID[:8]}] Preparing app lock for: {lock}\nℹ Current foreground app: {current}\n")

    def keyboard_mixed_tree(self, packages=("com.example.app", "com.example.keyboard")):
        with contextlib.closing(sqlite3.connect(os.path.join(self.tmp, "traces", "data_engine.db"))) as con, con:
            con.execute("update images set ui_tree=?", (json.dumps([{"package": p} for p in packages]),))

    def test_locked_run_names_foreground_even_with_keyboard_nodes(self):
        self.keyboard_mixed_tree()
        self.write_run_log("com.example.app", "com.example.app")
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        self.assertEqual(fl["start"], {"package": "com.example.app", "activity": ""})
        ac.validate_flow(fl, 1, 10)

    def test_locked_app_absent_from_screen_is_not_used(self):
        self.keyboard_mixed_tree()
        self.write_run_log("com.example.other", "com.example.other")
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        with self.assertRaisesRegex(ValueError, "시작 전경"):
            ac.validate_flow(fl, 1, 10)

    def test_lock_and_start_lines_must_agree(self):
        self.keyboard_mixed_tree()
        self.write_run_log("com.example.app", "com.example.keyboard")
        self.assertEqual(ac.locked_app_from_log(os.path.join(self.tmp, "traces", "data_engine.db"), self.SID), "")
        fl = ac.flow_from_artemis(self.ctx(), self.SID)
        with self.assertRaisesRegex(ValueError, "시작 전경"):
            ac.validate_flow(fl, 1, 10)

    def test_wal_snapshot_contains_committed_rows_without_source_write(self):
        path = os.path.join(self.tmp, "traces", "data_engine.db")
        con = sqlite3.connect(path)
        try:
            con.execute("pragma journal_mode=wal")
            con.execute("update sessions set status='failed'")
            con.commit()
            paths = [path, path + "-wal", path + "-shm"]
            before = {p: (os.stat(p).st_mtime_ns, open_bytes(p)) for p in paths}
            with self.assertRaisesRegex(SystemExit, "성공 완료"):
                ac.flow_from_artemis(self.ctx(), self.SID)
            self.assertEqual(before, {p: (os.stat(p).st_mtime_ns, open_bytes(p)) for p in paths})
        finally:
            con.close()


def open_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def sample_flow(*steps):
    expect = {"package": "com.example.app", "activity": ""}
    return {"source": {"artemis_session": "fixture"}, "start": expect,
            "steps": [{"from": i, "goal": "fixture", "expect": dict(expect), **s} for i, s in enumerate(steps, 1)]}


class FlowValidation(unittest.TestCase):
    def test_invalid_data_rejected_before_device_selection(self):
        cases = [({"do": "future"}, 1, 10), ({"do": "key", "key": ""}, 1, 10),
                 ({"do": "key", "key": "KEYCODE_"}, 1, 10),
                 ({"do": "tap", "norm": [-1, 50]}, 1, 10), ({"do": "tap", "norm": [1001, 50]}, 1, 10),
                 ({"do": "tap", "norm": [float("nan"), 50]}, 1, 10),
                 ({"do": "tap", "norm": [50]}, 1, 10), ({"do": "wait", "ms": -1}, 1, 10),
                 ({"do": "wait", "ms": float("nan")}, 1, 10), ({"do": "wait", "ms": 0}, 0, 10),
                 ({"do": "wait", "ms": 0}, 2, 10), ({"do": "wait", "ms": 0}, 1, -1),
                 ({"do": "wait", "ms": 0}, 1, float("nan")), ({"do": "wait", "ms": 0}, 1, float("inf"))]
        with tempfile.TemporaryDirectory() as tmp:
            for step, start, timeout in cases:
                with self.subTest(step=step, start=start, timeout=timeout):
                    fl = sample_flow(step)
                    with self.assertRaises(ValueError):
                        ac.flow_script(fl, start, timeout)
                    ctx = fake_ctx(tmp, "run", from_step=start, find_timeout=timeout)
                    write_flow(ctx, fl)
                    with patch.object(ac, "phone_harness_bin", side_effect=AssertionError("기기 선택 금지")), \
                            patch.object(ac, "phone_harness_env", side_effect=AssertionError("기기 접촉 금지")), \
                            self.assertRaises(SystemExit):
                        ac.cmd_flow(ctx)

    def test_skipped_steps_are_also_validated(self):
        with self.assertRaises(ValueError):
            ac.flow_script(sample_flow({"do": "unknown"}, {"do": "key", "key": "BACK"}), 2, 10)

    def test_old_flow_without_start_is_rejected(self):
        fl = sample_flow({"do": "key", "key": "BACK"})
        del fl["start"]
        with self.assertRaisesRegex(ValueError, "시작 전경"):
            ac.flow_script(fl, 1, 10)

    def test_invalid_deny_configuration_rejected(self):
        for denied in ("com.example.app", [None], ["bad;command"]):
            with self.subTest(denied=denied), self.assertRaises(ValueError):
                ac.flow_script(sample_flow({"do": "key", "key": "BACK"}), 1, 10, denied)

    def test_conflicting_start_record_is_rejected(self):
        fl = sample_flow({"do": "key", "key": "BACK"})
        fl["start"] = {"package": "com.example.other", "activity": ""}
        with self.assertRaisesRegex(ValueError, "시작 전경과"):
            ac.flow_script(fl, 1, 10)


class FlowRunner(unittest.TestCase):
    """생성 대본을 가짜 helper namespace 에서만 실행한다. 하네스를 import 하지 않는다."""

    def run_flow(self, fl, packages=None, xml=None, stable=True, start=1, deny=(), after_ui=None, nodes=None):
        self.mutations, self.events, self.reads = [], [], []
        self.stable_calls = 0
        packages = iter(packages) if packages is not None else None
        self.package = "com.example.app"
        xml = iter(xml or [])
        node = {"text": "Query", "desc": "", "id": "com.example.app:id/query", "class": "android.widget.EditText",
                "clickable": True, "x": 500, "y": 100, "w": 200, "h": 100}

        def current():
            self.reads.append("current")
            if packages is not None:
                self.package = next(packages, self.package)
            return self.package

        def shell(cmd):
            self.reads.append(cmd)
            if cmd == "wm size":
                return "Physical size: 1000x1000"
            if cmd == "uiautomator dump /dev/tty":
                return next(xml, "<hierarchy/>")
            if cmd == "dumpsys activity activities":
                return "topResumedActivity=ActivityRecord{abc u0 com.example.app/.Main t1}"
            self.mutations.append(("shell", cmd))
            return ""

        def tree():
            if after_ui:
                self.package = after_ui
            return nodes if nodes is not None else [node]

        def wait_stable():
            self.stable_calls += 1
            if isinstance(stable, Exception):
                raise stable
            return stable

        def record(name):
            return lambda *a, **k: self.mutations.append((name, a))

        ns = {"shell": shell, "current_app": current, "ui": tree,
              "find_nodes": lambda q, **kw: [n for n in (kw.get("nodes") or [node]) if q in (n["text"], n["desc"])],
              "tap": record("tap"), "long_press": record("long_press"), "type_text": record("type_text"),
              "back": record("back"), "home": record("home"), "drag": record("drag"), "swipe": record("swipe"),
              "wait": lambda s: None, "wait_stable": wait_stable}
        out = io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out):
            try:
                exec(ac.flow_script(fl, start, 0, deny), ns)
            except SystemExit as exc:
                code = exc.code
        for line in out.getvalue().splitlines():
            tag, _, payload = line.partition(" ")
            self.events.append((tag, json.loads(payload)))
        return code

    def field(self, text, focused=True, ident="com.example.app:id/query"):
        return ('<?xml version="1.0"?><hierarchy><node focused="%s" class="android.widget.EditText" '
                'package="com.example.app" resource-id="%s" text="%s" bounds="[400,50][600,150]"/></hierarchy>' %
                (str(focused).lower(), ident, text))

    def test_shared_id_does_not_override_recorded_name(self):
        # 설정 목록 제목은 모두 android:id/title — 이름이 맞는 항목을 눌러야 한다(기록된 자리에 더 가까운 다른 항목이 아니라)
        def row(text, y):
            return {"text": text, "desc": "", "id": "android:id/title", "class": "android.widget.TextView",
                    "clickable": False, "x": 300, "y": y, "w": 200, "h": 70}
        fl = sample_flow({"do": "tap", "text": "디스플레이", "id": "android:id/title", "norm": [300, 700]})
        self.assertEqual(self.run_flow(fl, nodes=[row("배터리", 700), row("디스플레이", 300)]), 0)
        self.assertEqual([m for m in self.mutations if m[0] == "tap"], [("tap", (300, 300))])

    def test_waits_for_screen_after_swipe_even_before_named_tap(self):
        # 밀기 직후 목록이 미끄러지는 중에 이름을 찾아 누르면 옆 항목이 눌린다(2026-11-10 Z 플립6 실측)
        fl = sample_flow({"do": "swipe", "norm": [500, 700], "norm_to": [500, 300]}, {"do": "tap", "text": "Query", "norm": [500, 100]})
        self.assertEqual(self.run_flow(fl), 0)
        self.assertEqual(self.stable_calls, 2)  # 밀기 뒤 한 번 + 끝 한 번

    def test_wrong_start_package_has_zero_mutations(self):
        self.assertEqual(self.run_flow(sample_flow({"do": "key", "key": "BACK"}), ["com.example.other"]), 3)
        self.assertEqual(self.mutations, [])
        self.assertIn("시작 앱이 다르다: 기대 com.example.app, 지금 com.example.other", self.events[-1][1]["why"])
        self.assertNotIn("wm size", self.reads)

    def test_deny_foreground_sends_no_home_or_back(self):
        for key in ("BACK", "HOME"):
            with self.subTest(key=key):
                self.assertEqual(self.run_flow(sample_flow({"do": "key", "key": key}), deny=["com.example.app"]), 3)
                self.assertEqual(self.mutations, [])

    def test_package_switch_after_lookup_blocks_tap(self):
        self.assertEqual(self.run_flow(sample_flow({"do": "tap", "text": "Query"}), after_ui="com.example.other"), 3)
        self.assertEqual(self.mutations, [])

    def test_package_switch_between_steps_blocks_next_action(self):
        self.assertEqual(self.run_flow(sample_flow({"do": "key", "key": "BACK"}, {"do": "key", "key": "HOME"}),
                                       ["com.example.app"] * 3 + ["com.example.other"]), 3)
        self.assertEqual([a[0] for a in self.mutations], ["back"])

    def test_resume_uses_selected_steps_foreground(self):
        fl = sample_flow({"do": "key", "key": "BACK"}, {"do": "key", "key": "HOME"})
        fl["steps"][1]["expect"]["package"] = "com.example.second"
        self.assertEqual(self.run_flow(fl, ["com.example.second"], start=2), 0)
        self.assertEqual([a[0] for a in self.mutations], ["home"])

    def test_start_activity_mismatch_blocks_input(self):
        fl = sample_flow({"do": "key", "key": "BACK"})
        fl["steps"][0]["expect"]["activity"] = "com.example.app/.Other"
        fl["start"] = dict(fl["steps"][0]["expect"])
        self.assertEqual(self.run_flow(fl), 3)
        self.assertEqual(self.mutations, [])

    def test_denied_launch_destination_is_blocked(self):
        self.assertEqual(self.run_flow(sample_flow({"do": "launch", "package": "com.example.denied"}),
                                       deny=["com.example.denied"]), 3)
        self.assertEqual(self.mutations, [])

    def test_input_focus_clear_then_type_readback(self):
        fl = sample_flow({"do": "input", "text": "Query", "id": "com.example.app:id/query", "value": "NEW", "clear": True})
        self.assertEqual(self.run_flow(fl, xml=[self.field("OLD"), self.field(""), self.field("NEW")]), 0)
        self.assertEqual([a[0] for a in self.mutations], ["tap", "shell", "shell", "type_text"])
        self.assertIn("keycombination", self.mutations[1][1])

    def test_failed_clear_stops_before_typing(self):
        fl = sample_flow({"do": "input", "norm": [500, 100], "value": "NEW", "clear": True})
        self.assertEqual(self.run_flow(fl, xml=[self.field("OLD"), self.field("OLD")]), 3)
        self.assertNotIn("type_text", [a[0] for a in self.mutations])

    def test_type_only_clear_not_ignored(self):
        fl = sample_flow({"do": "type", "value": "NEW", "clear": True})
        self.assertEqual(self.run_flow(fl, xml=[self.field("OLD"), self.field(""), self.field("NEW")]), 0)
        self.assertEqual([a[0] for a in self.mutations], ["shell", "shell", "type_text"])

    def test_append_with_clear_false(self):
        fl = sample_flow({"do": "type", "value": "NEW", "clear": False})
        self.assertEqual(self.run_flow(fl, xml=[self.field("OLD"), self.field("OLDNEW")]), 0)
        self.assertEqual([a[0] for a in self.mutations], ["type_text"])

    def test_autocomplete_input_field_is_supported(self):
        fl = sample_flow({"do": "type", "value": "NEW", "clear": True})
        xml = [self.field("").replace("android.widget.EditText", "android.widget.AutoCompleteTextView"),
               self.field("NEW").replace("android.widget.EditText", "android.widget.AutoCompleteTextView")]
        self.assertEqual(self.run_flow(fl, xml=xml), 0)
        self.assertEqual([a[0] for a in self.mutations], ["type_text"])

    def test_unverifiable_focus_stops_before_clear_and_type(self):
        fl = sample_flow({"do": "input", "norm": [500, 100], "value": "NEW", "clear": True})
        self.assertEqual(self.run_flow(fl, xml=[self.field("OLD", focused=False)]), 3)
        self.assertEqual([a[0] for a in self.mutations], ["tap"])

    def test_korean_is_explicitly_blocked_before_input(self):
        fl = sample_flow({"do": "input", "norm": [500, 100], "value": "화면", "clear": True})
        self.assertEqual(self.run_flow(fl), 3)
        self.assertEqual(self.mutations, [])
        self.assertIn("비ASCII", self.events[-1][1]["why"])

    def test_input_readback_mismatch_is_not_success(self):
        fl = sample_flow({"do": "type", "value": "NEW", "clear": False})
        self.assertEqual(self.run_flow(fl, xml=[self.field(""), self.field("WRONG")]), 3)
        self.assertNotIn("FLOW_OK", [tag for tag, _ in self.events])

    def test_final_stability_false_and_timeout_are_visible_with_exit_unchanged(self):
        for stable in (False, TimeoutError("fixture")):
            with self.subTest(stable=stable):
                self.assertEqual(self.run_flow(sample_flow({"do": "wait", "ms": 0}), stable=stable), 0)
                self.assertIs(self.events[-1][1]["final_stable"], False)
                self.assertEqual(self.events[-1][1]["warning"], "끝 화면 안정 확인 안 됨")

    def test_final_stability_true_is_recorded(self):
        self.assertEqual(self.run_flow(sample_flow({"do": "key", "key": "BACK"})), 0)
        self.assertIs(self.events[-1][1]["final_stable"], True)


def fake_ctx(tmp, arg, **options):
    args = dict(arg=arg, name="fixture", session="fixture", force=False, package=None, from_step=None,
                find_timeout=10.0, json=False, keep_all=False)
    args.update(options)
    return SimpleNamespace(data_dir=tmp, cfg={"deny_packages": []}, a=SimpleNamespace(**args))


def write_flow(ctx, fl):
    os.makedirs(ac.flows_dir(ctx), exist_ok=True)
    with open(ac.flow_path(ctx, ctx.a.name), "w", encoding="utf-8") as f:
        json.dump(fl, f)


class FlowCLI(unittest.TestCase):
    def test_force_backup_preserves_both_prior_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = fake_ctx(tmp, "save", force=True)
            fl = sample_flow({"do": "key", "key": "BACK"})
            fl["skipped"] = []
            write_flow(ctx, {"old": 1})
            path = ac.flow_path(ctx, "fixture")
            original = open_bytes(path)
            out = io.StringIO()
            with patch.object(ac, "flow_from_artemis", return_value=copy.deepcopy(fl)), contextlib.redirect_stdout(out):
                ac.cmd_flow(ctx)
                first_saved = open_bytes(path)
                ac.cmd_flow(ctx)
            self.assertEqual(open_bytes(path + ".bak"), original)
            self.assertEqual(open_bytes(path + ".bak.1"), first_saved)
            self.assertIn("기존 flow 보존:", out.getvalue())

    def test_validation_failure_preserves_existing_flow_without_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = fake_ctx(tmp, "save", force=True)
            write_flow(ctx, {"old": 1})
            path = ac.flow_path(ctx, "fixture")
            original = open_bytes(path)
            fl = sample_flow({"do": "unknown"})
            fl["skipped"] = []
            with patch.object(ac, "flow_from_artemis", return_value=fl), self.assertRaises(SystemExit):
                ac.cmd_flow(ctx)
            self.assertEqual(open_bytes(path), original)
            self.assertFalse(os.path.exists(path + ".bak"))

    def cli_run(self, tmp, json_output=False, stable=False, returncode=0):
        ctx = fake_ctx(tmp, "run", json=json_output)
        write_flow(ctx, sample_flow({"do": "key", "key": "BACK"}))
        output = "FLOW_OK " + json.dumps({"steps": 1, "s": 0.1, "final_stable": stable})
        proc = SimpleNamespace(stdout=output, stderr="", returncode=returncode)
        out = io.StringIO()
        with patch.object(ac, "phone_harness_bin", return_value="fake-harness"), \
                patch.object(ac, "phone_harness_env", return_value={}), \
                patch.object(ac.subprocess, "run", return_value=proc), contextlib.redirect_stdout(out):
            ac.cmd_flow(ctx)
        return out.getvalue()

    def test_unstable_human_and_json_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn("끝 화면 안정 확인 안 됨", self.cli_run(tmp))
            result = json.loads(self.cli_run(tmp, json_output=True))
            self.assertEqual(result["status"], "unverified")
            self.assertIs(result["final_stable"], False)
            self.assertEqual(result["warning"], "끝 화면 안정 확인 안 됨")

    def test_nonzero_process_cannot_report_success_even_with_ok_event(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(SystemExit):
            self.cli_run(tmp, returncode=1, stable=True)


if __name__ == "__main__":
    unittest.main()
