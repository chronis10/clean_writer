"""Exercise the packaged Linux app's real close event in a private X11 session.

Run via dbus-run-session. Requires Xvfb, WebKitWebDriver and xdotool; no
user session, application files, or installed Clean Writer instance is touched.
"""

import argparse
import ctypes as C
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", type=Path, required=True)
parser.add_argument("--tools-dir", type=Path)
options = parser.parse_args()
PACKAGE = options.package.resolve()

def tool(name):
    path = str(options.tools_dir / name) if options.tools_dir else shutil.which(name)
    if not path or not Path(path).is_file():
        raise RuntimeError(f"Missing native test dependency: {name}")
    return path


def wait_for(fn, timeout=15):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            result = fn()
            if result:
                return result
        except Exception as error:
            last = error
        time.sleep(.1)
    raise AssertionError(f'Condition timed out: {last}')

def send_close(window, env):
    class Data(C.Union):
        _fields_ = [('l', C.c_long * 5), ('b', C.c_char * 20)]
    class Message(C.Structure):
        _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p), ('window', C.c_ulong), ('message_type', C.c_ulong), ('format', C.c_int), ('data', Data)]
    class Event(C.Union):
        _fields_ = [('client', Message), ('pad', C.c_long * 24)]
    x11 = C.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [C.c_char_p]
    x11.XOpenDisplay.restype = C.c_void_p
    x11.XInternAtom.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
    x11.XInternAtom.restype = C.c_ulong
    x11.XSendEvent.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(Event)]
    x11.XFlush.argtypes = [C.c_void_p]
    x11.XCloseDisplay.argtypes = [C.c_void_p]
    display = x11.XOpenDisplay(env['DISPLAY'].encode())
    assert display
    try:
        event = Event()
        event.client.type = 33
        event.client.send_event = 1
        event.client.display = display
        event.client.window = window
        event.client.message_type = x11.XInternAtom(display, b'WM_PROTOCOLS', 0)
        event.client.format = 32
        event.client.data.l[0] = x11.XInternAtom(display, b'WM_DELETE_WINDOW', 0)
        assert x11.XSendEvent(display, window, 0, 0, C.byref(event))
        x11.XFlush(display)
    finally:
        x11.XCloseDisplay(display)

with tempfile.TemporaryDirectory(prefix='clean-writer-native-close-', ignore_cleanup_errors=True) as folder:
    root = Path(folder)
    subprocess.run(['dpkg-deb', '-x', str(PACKAGE), str(root / 'package')], check=True)
    source = root / 'saved.md'
    source.write_text('Saved baseline')
    env = dict(os.environ)
    for key, name in [('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_CACHE_HOME','cache'),('XDG_RUNTIME_DIR','runtime')]:
        target = root / name
        target.mkdir(mode=0o700)
        env[key] = str(target)
    env['TAURI_WEBVIEW_AUTOMATION'] = 'true'
    env['WEBKIT_DISABLE_DMABUF_RENDERER'] = '1'
    env['GDK_BACKEND'] = 'x11'
    env['GIO_USE_VFS'] = 'local'
    env['GTK_USE_PORTAL'] = '0'
    env['NO_AT_BRIDGE'] = '1'
    env['GSETTINGS_BACKEND'] = 'memory'
    log = (root / 'native.log').open('w+')
    rfd, wfd = os.pipe()
    xvfb = subprocess.Popen([tool('Xvfb'), '-displayfd', str(wfd), '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'], pass_fds=[wfd], stdout=log, stderr=log)
    os.close(wfd)
    assert select.select([rfd], [], [], 10)[0], 'Xvfb did not start'
    env['DISPLAY'] = ':' + os.read(rfd, 100).decode().strip()
    os.close(rfd)
    # Update only this private D-Bus session; never the user's systemd session.
    subprocess.run([
        "dbus-update-activation-environment", "DISPLAY", "XDG_CONFIG_HOME",
        "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "GDK_BACKEND",
        "GIO_USE_VFS", "GTK_USE_PORTAL", "NO_AT_BRIDGE", "GSETTINGS_BACKEND",
    ], env=env, check=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    driver = subprocess.Popen([tool('WebKitWebDriver'), '--host=127.0.0.1', f'--port={port}'], env=env, stdout=log, stderr=log, start_new_session=True)
    session = None
    def request(method, path, data=None):
        payload = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(base + path, data=payload, method=method, headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=45) as response:
            result = json.load(response)['value']
        if isinstance(result, dict) and 'error' in result:
            raise RuntimeError(result)
        return result
    def script(code):
        return request('POST', f'/session/{session}/execute/sync', {'script':code, 'args':[]})
    def click(selector):
        element = request('POST', f'/session/{session}/element', {'using':'css selector','value':selector})
        element_id = element['element-6066-11e4-a52e-4f735466cecf']
        request('POST', f'/session/{session}/element/{element_id}/click', {})
    try:
        wait_for(lambda: request('GET', '/status'))
        value = request('POST', '/session', {'capabilities': {'alwaysMatch': {'webkitgtk:browserOptions':{'binary':str(root/'package/usr/bin/clean-writer'), 'args':[str(source)]}}}})
        session = value['sessionId']
        print('Native packaged app launched', flush=True)
        wait_for(lambda: script("return document.querySelector('.cm-content')?.textContent === 'Saved baseline'"))
        script("const el=document.querySelector('.cm-content'); el.focus(); const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, ' changed');")
        wait_for(lambda: script("return document.querySelector('.cm-content').textContent === 'Saved baseline changed'"))
        time.sleep(1.6)
        assert source.read_text() == 'Saved baseline', 'Edits were silently written to disk'
        windows = subprocess.check_output([tool('xdotool'), 'search', '--onlyvisible', '--name', 'Clean Writer'], env=env, text=True).split()
        assert windows, 'No native app window found'
        window = int(windows[0])
        send_close(window, env)
        wait_for(lambda: script("return document.querySelector('#confirm-dialog').open"))
        print('Actual WM_DELETE_WINDOW request shows Save / Discard / Cancel after typing pause', flush=True)
        click('#confirm-dialog button[value=cancel]')
        wait_for(lambda: script("return !document.querySelector('#confirm-dialog').open"))
        assert script("return document.querySelector('.cm-content').textContent") == 'Saved baseline changed'
        assert source.read_text() == 'Saved baseline'
        print('Cancel retains native window and unsaved edits', flush=True)
        send_close(window, env)
        wait_for(lambda: script("return document.querySelector('#confirm-dialog').open"))
        click('#confirm-dialog button[value=save]')
        wait_for(lambda: source.read_text() == 'Saved baseline changed')
        def no_windows():
            try:
                return not request('GET', f'/session/{session}/window/handles')
            except Exception:
                return True
        wait_for(no_windows)
        print('Save writes the file and closes the native window', flush=True)
    except Exception:
        log.flush()
        print((root/'native.log').read_text()[-7000:], flush=True)
        raise
    finally:
        if session:
            try: request('DELETE', f'/session/{session}')
            except Exception: pass
        try: os.killpg(driver.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        driver.wait(timeout=10)
        xvfb.terminate()
        xvfb.wait(timeout=10)
        log.close()
        # The private desktop portal may mount a FUSE document directory. Only
        # unmount paths created for this test before TemporaryDirectory cleanup.
        fusermount = shutil.which("fusermount3") or shutil.which("fusermount")
        if fusermount:
            for name in ["doc", "gvfs"]:
                mount = root / "runtime" / name
                if mount.is_mount():
                    subprocess.run([fusermount, "-u", str(mount)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

