"""기기 없이 도는 단위 시험 — python -m unittest discover -s test"""

import os
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
