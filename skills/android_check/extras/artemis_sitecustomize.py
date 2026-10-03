# 로컬 추가 파일 (ARTEMIS 원본 아님) — 2026-10-04
#
# Windows 에서 ARTEMIS 가 adb · ffmpeg 같은 콘솔 프로그램을 실행할 때마다
# 새 CMD 창이 잠깐 떴다 사라졌다. Claude Code 가 띄운 MCP 서버·데몬에는 콘솔이
# 없어서, 창 숨김 옵션 없이 콘솔 프로그램을 실행하면 Windows 가 새 콘솔 창을
# 만든다. ARTEMIS 의 subprocess 호출 66곳 대부분이 그 옵션을 쓰지 않는다.
#
# 이 파일은 파이썬 시작 시 자동으로 읽혀(site 모듈의 sitecustomize),
# subprocess.Popen 에 CREATE_NO_WINDOW 를 기본으로 붙인다.
# - DETACHED_PROCESS 는 CREATE_NO_WINDOW 로 바꾼다. 이 환경의 venv python.exe 는
#   런처가 진짜 python 을 한 번 더 띄우는 이중 구조라, 런처를 DETACHED(콘솔 없음)로
#   띄우면 그 자식 python 에 Windows 가 **보이는 콘솔 창을 새로 만든다** —
#   ARTEMIS 데몬(daemon_client.py:142)이 이렇게 떠서 창이 남았다.
#   CREATE_NO_WINDOW 는 창 없는 콘솔을 만들어 자식이 그것을 물려받는다. 부모와
#   분리돼 계속 사는 성질은 같다(CREATE_NEW_PROCESS_GROUP 은 그대로 둔다).
# - CREATE_NEW_CONSOLE 을 지정한 호출은 일부러 창을 여는 것이라 건드리지 않는다
# - 창이 있는 프로그램(scrcpy 미러 창 등)에는 영향이 없다 — 콘솔 창만 숨긴다
# - asyncio 의 서브프로세스도 subprocess.Popen 을 거치므로 함께 적용된다
#
# ⚠️ .venv 를 지우고 다시 만들면(uv venv 재생성) 이 파일도 사라진다. 다시 넣어야 한다.
import subprocess
import sys

if sys.platform == "win32":
    _NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    _NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x00000010)
    _DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    _original_init = subprocess.Popen.__init__

    def _init_without_console_window(self, *args, **kwargs):
        flags = kwargs.get("creationflags") or 0
        if not flags & _NEW_CONSOLE:
            kwargs["creationflags"] = (flags & ~_DETACHED) | _NO_WINDOW
        _original_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _init_without_console_window
