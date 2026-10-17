"""AI 圆桌 v3: starts the local engine and opens it in its own app window (Edge/Chrome --app mode).

    pythonw app.py            start (or re-open the running instance)
    python app.py --no-window print the local address instead of opening a window (development)
"""
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'vendor'))
sys.path.insert(0, str(ROOT))
import core
import engine
from controller import Controller
from server import Server

BROWSERS = [
    r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe',
    r'%ProgramFiles%\Microsoft\Edge\Application\msedge.exe',
    r'%LocalAppData%\Microsoft\Edge\Application\msedge.exe',
    r'%ProgramFiles%\Google\Chrome\Application\chrome.exe',
    r'%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe',
    r'%LocalAppData%\Google\Chrome\Application\chrome.exe',
]


def find_browser():
    for pattern in BROWSERS:
        path = Path(os.path.expandvars(pattern))
        if path.is_file():
            return path


def open_window(url):
    """A chrome-less window of its own (no tabs, no address bar) with a private profile kept in data/browser."""
    browser = find_browser()
    if not browser:
        webbrowser.open(url)
        return
    width, height = 1280, 860
    try:
        ctypes.windll.user32.SetProcessDPIAware()
        screen_w, screen_h = ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1)
        scale = ctypes.windll.shcore.GetScaleFactorForDevice(0) / 100 or 1
        width, height = min(width, int(screen_w / scale) - 80), min(height, int(screen_h / scale) - 100)
        x, y = int((screen_w / scale - width) / 2), int((screen_h / scale - height) / 2) - 10
    except Exception:
        x, y = 80, 40
    profile = core.DATA / 'browser'
    profile.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([str(browser), f'--app={url}', f'--user-data-dir={profile}', f'--window-size={width},{height}',
                      f'--window-position={max(x, 0)},{max(y, 0)}', '--no-first-run', '--no-default-browser-check',
                      '--disable-features=Translate,msEdgeFirstRunExperience', '--lang=zh-CN'],
                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def running_instance():
    """If another copy is already serving, return its URL so we can just open another window onto it."""
    info = core.DATA / 'server.json'
    try:
        data = json.loads(info.read_text(encoding='utf-8'))
        request = urllib.request.Request(f"http://127.0.0.1:{data['port']}/api/bootstrap",
                                         headers={'Cookie': 'rt=' + data['token']})
        with urllib.request.urlopen(request, timeout=1.5) as response:
            if response.status == 200:
                return f"http://127.0.0.1:{data['port']}/?t={data['token']}"
    except Exception:
        pass
    return None


def silence_output():
    """pythonw has no console; keep a small log instead of crashing on print()."""
    core.DATA.mkdir(parents=True, exist_ok=True)
    log = open(core.DATA / 'app.log', 'a', encoding='utf-8', buffering=1)
    if log.tell() > 512 * 1024:
        log.truncate(0)
    sys.stdout = sys.stderr = log


def main():
    core.DATA.mkdir(parents=True, exist_ok=True)
    headless = '--no-window' in sys.argv
    if not headless:
        silence_output()
        existing = running_instance()
        if existing:
            open_window(existing)
            return
    controller = Controller(core.DATA)
    server = Server(controller)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=engine.refresh_prices, daemon=True).start()
    info = core.DATA / 'server.json'
    info.write_text(json.dumps(dict(port=server.server_port, token=server.token, pid=os.getpid())), encoding='utf-8')
    try:
        if headless:
            print(server.url(), flush=True)
        else:
            open_window(server.url())
        # Exit once the window is gone (no event stream for ~10 s) and nothing is still being generated.
        # Counting ticks instead of wall-clock time keeps a laptop's sleep/resume from ending the session.
        gone = waited = 0
        last = time.monotonic()
        while True:
            time.sleep(1)
            now = time.monotonic()
            slept, last = now - last > 3, now
            if controller.busy or headless or slept:
                gone = 0
                continue
            if server.ever_connected:
                gone = gone + 1 if server.clients == 0 else 0
                if gone >= 10:
                    break
            else:
                waited += 1
                if waited > 90:
                    break
    except KeyboardInterrupt:
        pass
    finally:
        controller.shutdown()
        server.shutdown()
        try:
            info.unlink()
        except OSError:
            pass


if __name__ == '__main__':
    main()
