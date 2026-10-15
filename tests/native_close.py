"""Exercise native caret placement and close events in the packaged Linux app.

Run via dbus-run-session. Requires Xvfb, WebKitWebDriver and xdotool; no
user session, application files, or installed Clean Writer instance is touched.
"""

import argparse
import base64
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
parser.add_argument("--display-scale", type=int, choices=[1, 2], default=1)
parser.add_argument("--test-dictionary-install", action="store_true", help="Download and install French in the isolated test profile")
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
    (root/'ssl-pretraining.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQiFoFAAHaAS2m8I9OAAAAAElFTkSuQmCC'))
    env = dict(os.environ)
    for key, name in [('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_CACHE_HOME','cache'),('XDG_RUNTIME_DIR','runtime')]:
        target = root / name
        target.mkdir(mode=0o700)
        env[key] = str(target)
    env['TAURI_WEBVIEW_AUTOMATION'] = 'true'
    env['WEBKIT_DISABLE_DMABUF_RENDERER'] = '1'
    env['GDK_BACKEND'] = 'x11'
    env['GDK_SCALE'] = str(options.display_scale)
    env['GIO_USE_VFS'] = 'local'
    env['GTK_USE_PORTAL'] = '0'
    env['NO_AT_BRIDGE'] = '1'
    env['GSETTINGS_BACKEND'] = 'memory'
    log = (root / 'native.log').open('w+')
    rfd, wfd = os.pipe()
    screen = f'{1280 * options.display_scale}x{900 * options.display_scale}x24'
    xvfb = subprocess.Popen([tool('Xvfb'), '-displayfd', str(wfd), '-screen', '0', screen, '-nolisten', 'tcp', '-ac'], pass_fds=[wfd], stdout=log, stderr=log)
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
        # Thumbnail DOM can refresh between WebDriver lookup and click.
        for attempt in range(10):
            try:
                element = request('POST', f'/session/{session}/element', {'using':'css selector','value':selector})
                element_id = element['element-6066-11e4-a52e-4f735466cecf']
                request('POST', f'/session/{session}/element/{element_id}/click', {})
                return
            except urllib.error.HTTPError as error:
                if error.code != 404 or attempt == 9:
                    raise
                time.sleep(.1)
    try:
        wait_for(lambda: request('GET', '/status'))
        value = request('POST', '/session', {'capabilities': {'alwaysMatch': {'webkitgtk:browserOptions':{'binary':str(root/'package/usr/bin/clean-writer'), 'args':[str(source)]}}}})
        session = value['sessionId']
        print('Native packaged app launched', flush=True)
        wait_for(lambda: script("return document.querySelector('.cm-content')?.textContent === 'Saved baseline'"))
        assert script("return document.querySelector('#autosave').checked"), 'Autosave should default to enabled'
        script("const v=document.querySelector('#document-state .cm-content').cmTile.root.view;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'Autosaved baseline'}})")
        wait_for(lambda: source.read_text() == 'Autosaved baseline')
        script("const v=document.querySelector('#document-state .cm-content').cmTile.root.view;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'Saved baseline'}})")
        wait_for(lambda: source.read_text() == 'Saved baseline')
        click('#settings')
        click('#autosave')
        click('#settings')
        wait_for(lambda: json.loads((root/'data/com.chronis10.cleanwriter/session-v2.json').read_text())['session']['preferences'].get('autosave') is False)
        print('Autosave defaults on, writes the actual Markdown file and can be disabled in Settings', flush=True)
        html = '<p align="center"> <img src="ssl-pretraining.png" alt="Raman self-supervised pretraining architecture" width="750"> </p>'
        script("const v=document.querySelector('#document-state .cm-content').cmTile.root.view;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:"+json.dumps(html)+"}})")
        click('#preview')
        wait_for(lambda: script("return document.querySelector('.preview-page img')?.complete && document.querySelector('.preview-page img')?.naturalWidth>0"))
        assert script("const img=document.querySelector('.preview-page img');return img.alt==='Raman self-supervised pretraining architecture' && img.width===465 && getComputedStyle(img.parentElement).textAlign==='center' && !document.querySelector('.preview-page .page-body').textContent.includes('<p align=')")
        print('Actual Rust preview renders the centered HTML image at its bounded width',flush=True)
        click('#preview')
        # Exercise actual mouse coordinates in the packaged webview, including
        # scaled text and a scrolled second page. The native caret must remain
        # visible and use the same selection that receives keyboard input.
        lines = [f'Line {i+1}: source content for cursor placement.' for i in range(90)]
        text = '\n'.join(line + ('\n' if (i+1)%10==0 and i<len(lines)-1 else '') for i,line in enumerate(lines))
        def recovered_text():
            recovery = root / 'data/com.chronis10.cleanwriter/session-v2.json'
            return json.loads(recovery.read_text())['session']['document']['text']
        def replace_text(text):
            # Fixture replacement targets the document coordinator; Ctrl+A in
            # a visible independent page intentionally selects only that page.
            script("const view=document.querySelector('#document-state .cm-content').cmTile.root.view;view.dispatch({changes:{from:0,to:view.state.doc.length,insert:" + json.dumps(text) + "},selection:{anchor:0}});")
            wait_for(lambda: recovered_text() == text)
        def point_for(row):
            code = "const el=[...document.querySelectorAll('.cm-line')].find(el=>el.textContent.startsWith('Line " + str(row) + ":')); if (!el) return null; el.scrollIntoView({block:'center'}); const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); const n=walker.nextNode(); const r=document.createRange(); r.setStart(n,12); r.setEnd(n,13); const rect=r.getBoundingClientRect(); return {x:rect.left+.5,y:(rect.top+rect.bottom)/2};"
            return wait_for(lambda: script(code))
        replace_text('Scrollable paragraph content. ' * 1200)
        for preview in [False, True]:
            if preview:
                click('#preview')
            selector = '.preview-page .page-body' if preview else '.source-page .cm-scroller'
            wait_for(lambda: script("const el=document.querySelector("+json.dumps(selector)+");return el && el.scrollHeight<=el.clientHeight+1"))
            script("document.querySelector("+json.dumps(selector)+").scrollTop=100")
            click('#settings')
            assert script("return getComputedStyle(document.querySelector("+json.dumps(selector)+")).scrollbarWidth==='none'"), 'Native page scrollbar must be suppressed while a menu is open'
            assert script("const panel=document.querySelector('#settings-panel'),r=panel.getBoundingClientRect(),s=document.querySelector("+json.dumps(selector)+").getBoundingClientRect(),x=Math.min(r.right-8,Math.max(r.left+8,s.right-2));return [r.top+50,r.top+110,r.top+180].every(y=>document.elementFromPoint(x,y)?.closest('#settings-panel'))"), 'Settings must stay above page scrollbars'
            if preview:
                Path('test-results').mkdir(exist_ok=True)
                # Capture the actual X11 surface, including native overlay layers.
                try:
                    from PIL import ImageGrab
                except ImportError:
                    pass
                else:
                    ImageGrab.grab(xdisplay=env['DISPLAY']).save('test-results/native-settings-scale'+str(options.display_scale)+'.png')
            click('#settings')
            assert script("const el=document.querySelector("+json.dumps(selector)+");el.scrollTop+=20;return getComputedStyle(el).scrollbarWidth==='none' && el.scrollTop===0"), 'Page scrolling must remain functional after closing Settings'
        click('#preview')
        print('Settings remains above flowing pages; page containers have no internal scrolling', flush=True)
        if options.test_dictionary_install:
            replace_text('développement dévellopement')
            wait_for(lambda: script("return [...document.querySelectorAll('.spelling-error')].some(el=>el.textContent==='développement')"))
            click('#settings')
            wait_for(lambda: script("return document.querySelectorAll('#dictionary-language option').length===14"))
            script("const el=document.querySelector('#dictionary-language');el.value='fr_FR';el.dispatchEvent(new Event('change'))")
            click('#dictionary-install')
            wait_for(lambda: script("return document.querySelector('#dictionary-status').textContent.includes('French installed')"), timeout=90)
            pack = root / 'data/com.chronis10.cleanwriter/dictionaries/fr_FR'
            assert (pack / 'fr_FR.aff').is_file() and (pack / 'fr_FR.dic').is_file()
            assert 'SET UTF-8' in (pack / 'fr_FR.aff').read_text()
            assert (pack / 'licenses/README_dict_fr.txt').is_file()
            assert (pack / 'source.json').is_file()
            click('#settings')
            wait_for(lambda: script("return ![...document.querySelectorAll('.spelling-error')].some(el=>el.textContent==='développement')"))
            wait_for(lambda: script("return [...document.querySelectorAll('.spelling-error')].some(el=>el.textContent==='dévellopement')"))
            result = request('POST', f'/session/{session}/execute/async', {'script':"const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('spelling_suggestions',{word:'dévellopement'}).then(value=>done({value}),error=>done({error:String(error)}))", 'args':[]})
            assert 'développement' in result.get('value', []), result
            assert recovered_text() == 'développement dévellopement'
            print('Settings installs the actual French .aff/.dic pair and licenses, refreshes underlines and supplies French corrections immediately', flush=True)
        for zoom in [50, 100, 150]:
            for row in [1, 45]:
                replace_text(text)
                script(f"const el=document.querySelector('#zoom'); el.value={zoom}; el.dispatchEvent(new Event('input'));")
                time.sleep(.4)
                # Page navigation materializes later lines at high zoom.
                if row == 45:
                    click('.thumbnail:nth-child(2)')
                    time.sleep(.3)
                point = point_for(row)
                request('POST', f'/session/{session}/actions', {'actions':[{'type':'pointer','id':'mouse','parameters':{'pointerType':'mouse'},'actions':[{'type':'pointerMove','x':round(point['x']),'y':round(point['y']),'duration':0},{'type':'pointerDown','button':0},{'type':'pointerUp','button':0}]}]})
                wait_for(lambda: script("return getSelection()?.anchorOffset === 12"))
                caret = script("const s=getSelection(); const r=s.getRangeAt(0).getBoundingClientRect(); return {x:r.x,y:r.y,height:r.height,color:getComputedStyle(s.anchorNode.parentElement).caretColor,overlay:!!document.querySelector('.cm-cursorLayer')};")
                assert not caret['overlay'], 'Synthetic cursor overlay is still enabled'
                assert caret['color'] not in ['transparent', 'rgba(0, 0, 0, 0)'], caret
                assert abs(caret['x'] - point['x']) < 3, (point, caret)
                assert abs(caret['y'] + caret['height']/2 - point['y']) < 3, (point, caret)
                request('POST', f'/session/{session}/actions', {'actions':[{'type':'key','id':'keyboard','actions':[{'type':'keyDown','value':'@'},{'type':'keyUp','value':'@'}]}]})
                offset = text.index(f'Line {row}:') + 12
                expected = text[:offset] + '@' + text[offset:]
                wait_for(lambda: recovered_text() == expected)
                print(f'Native caret and insertion agree: {zoom}% zoom, line {row}, display scale {options.display_scale}', flush=True)
        reading_text = 'Reading content.\n'*100
        replace_text('\f'.join([reading_text]*3))
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===document.querySelectorAll('.source-page').length && document.querySelectorAll('.source-page').length>3"))
        reading_count = script("return document.querySelectorAll('.source-page').length")
        click('.source-page:nth-child(3) .cm-content')
        position=script("const p=document.querySelectorAll('.source-page')[2],canvas=document.querySelector('#canvas');p.scrollIntoView({block:'start'});canvas.scrollTop+=60;return canvas.scrollTop")
        click('#preview')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length") == reading_count)
        wait_for(lambda: abs(script("return document.querySelector('#canvas').scrollTop")-position)<40)
        assert script("return [...document.querySelectorAll('.preview-page .page-body')].every(el=>el.scrollTop===0 && el.scrollHeight<=el.clientHeight+1)")
        reverse=script("const p=document.querySelectorAll('.preview-page')[1],canvas=document.querySelector('#canvas');p.scrollIntoView({block:'start'});canvas.scrollTop+=40;return canvas.scrollTop")
        click('#preview')
        wait_for(lambda: abs(script("return document.querySelector('#canvas').scrollTop")-reverse)<40)
        assert script("return [...document.querySelectorAll('.source-page .cm-scroller')].every(el=>el.scrollTop===0 && el.scrollHeight<=el.clientHeight+1)")
        print('Editor and preview retain the current flowing page in both directions without internal scrolling',flush=True)
        code = '\n'.join(['```bash', 'python main.py fit '+chr(92), '  --config configs/mae/mae-config-base.yaml '+chr(92), '  --trainer.strategy auto', '  --trainer.devices 1', '  --trainer.accelerator gpu', '```', ''])
        block_text = 'Intro line.\n'*33+'\n'+code+'\nAfter the block.'
        replace_text(block_text)
        wait_for(lambda: script("return document.querySelectorAll('.source-page').length===2"))
        assert script("return [...document.querySelectorAll('.source-page .cm-content')].filter(el=>el.cmTile.root.view.state.doc.toString().includes("+json.dumps(code)+")).length===1")
        click('#preview')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===2 && document.querySelectorAll('.preview-page pre code').length===1"))
        assert script("const code=document.querySelector('.preview-page pre code').textContent;return code.includes('python main.py fit') && code.includes('--config configs/mae/mae-config-base.yaml') && code.includes('--trainer.strategy auto') && code.includes('--trainer.accelerator gpu')")
        print('The complete multi-line training command renders inside one code block on one A4 page',flush=True)
        click('#preview')
        long_code = '\n'.join(f'command --line {i}' for i in range(120))+'\n'
        long_table = '| A | B |\n| - | - |\n'+'\n'.join(f'| row{i} | value{i} |' for i in range(90))
        replace_text('```bash\n'+long_code+'```\f'+long_table)
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===document.querySelectorAll('.source-page').length && document.querySelectorAll('.source-page').length>5"))
        click('#preview')
        assert script("return [...document.querySelectorAll('.preview-page pre code')].map(el=>el.textContent).join('')==="+json.dumps(long_code))
        assert script("return document.querySelectorAll('.preview-page pre code').length>1 && document.querySelectorAll('.preview-page table').length>1")
        assert script("return [...document.querySelectorAll('.preview-page td')].filter(el=>/^row[0-9]+$/.test(el.textContent)).length===90")
        assert script("return [...document.querySelectorAll('.preview-page .page-body')].every(el=>el.scrollHeight<=el.clientHeight+1 && el.scrollTop===0)")
        click('#preview')
        print('Long fenced code and tables continue across pages with semantic formatting and all content intact',flush=True)
        click('#preview')
        click('.thumbnail:first-child')
        click('#add-page')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page')[1]?.querySelector('.page-body').textContent===''") )
        assert script("return [...document.querySelectorAll('.preview-page pre code')].map(el=>el.textContent).join('')==="+json.dumps(long_code))
        assert script("return [...document.querySelectorAll('.preview-page td')].filter(el=>/^row[0-9]+$/.test(el.textContent)).length===90")
        click('#preview')
        print('Inserting a blank page inside a continued code block preserves every command and table row',flush=True)

        replace_text('First page\fSecond page\fThird page')
        wait_for(lambda: script("return document.querySelectorAll('.thumbnail').length === 3"))
        script("document.querySelectorAll('.source-page')[2].scrollIntoView({block:'start'})")
        wait_for(lambda: script("return document.querySelectorAll('.thumbnail')[2].getAttribute('aria-current')==='page'"))
        click('#bookmark-add')
        wait_for(lambda: script("return !!document.querySelectorAll('.thumbnail')[2].querySelector('.thumbnail-bookmark') && !document.querySelectorAll('.thumbnail')[0].querySelector('.thumbnail-bookmark')"))
        wait_for(lambda: json.loads((root / 'data/com.chronis10.cleanwriter/session-v2.json').read_text())['session']['document']['bookmarks'][0]['offset'] == 23)
        click('#preview')
        wait_for(lambda: script("return document.querySelectorAll('.thumbnail')[2].getAttribute('aria-current')==='page' && document.querySelector('#bookmark-add').classList.contains('bookmarked')"))
        click('#bookmark-add')
        wait_for(lambda: script("return !document.querySelector('.thumbnail-bookmark')"))
        click('#preview')
        print('Bookmark follows the visible third page with the caret on page one, and toggles correctly in preview', flush=True)
        click('.thumbnail:nth-child(2)')
        click('.source-page:nth-child(3) .cm-content')
        wait_for(lambda: script("return document.querySelectorAll('.thumbnail')[2].getAttribute('aria-current')==='page'"))
        click('#add-page')
        wait_for(lambda: recovered_text() == 'First page\fSecond page\fThird page\f')
        request('POST', f'/session/{session}/actions', {'actions':[{'type':'key','id':'keyboard','actions':[action for char in 'New page' for action in [{'type':'keyDown','value':char},{'type':'keyUp','value':char}]]}]})
        wait_for(lambda: recovered_text() == 'First page\fSecond page\fThird page\fNew page')
        def assert_page_bounds(selector, body_selector):
            assert script("return [...document.querySelectorAll("+json.dumps(selector)+")].every(paper=>{const p=paper.getBoundingClientRect(),scale=p.width/595.28,b=paper.querySelector("+json.dumps(body_selector)+"),r=b.getBoundingClientRect(),m=parseFloat(getComputedStyle(paper).paddingTop);return Math.abs(p.height/scale-841.89)<1 && r.top>=p.top+m*scale-1 && r.bottom<=p.bottom-(m+42)*scale+1 && r.left>=p.left+m*scale-1 && r.right<=p.right-m*scale+1 && getComputedStyle(paper).overflow==='hidden' && getComputedStyle(b).overflowY==='clip' && b.scrollHeight<=b.clientHeight+1});")
        assert_page_bounds('.source-page', '.cm-scroller')
        print('Add page follows the current indicator after clicking another editor page; all containers remain bounded', flush=True)
        def remove_sidebar_page(number):
            point=script("const el=document.querySelectorAll('.thumbnail')["+str(number-1)+"];el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+30}")
            request('POST', f'/session/{session}/actions', {'actions':[{'type':'pointer','id':'mouse','parameters':{'pointerType':'mouse'},'actions':[{'type':'pointerMove','x':round(point['x']),'y':round(point['y']),'duration':0},{'type':'pointerDown','button':2},{'type':'pointerUp','button':2}]}]})
            wait_for(lambda: script("return !document.querySelector('#bookmark-menu').hidden"))
            click('#bookmark-menu button:first-child')
        remove_sidebar_page(2)
        wait_for(lambda: recovered_text() == 'First page\fThird page\fNew page')
        assert_page_bounds('.source-page','.cm-scroller')
        subprocess.run([tool('xdotool'),'key','ctrl+z'],env=env,check=True)
        wait_for(lambda: recovered_text() == 'First page\fSecond page\fThird page\fNew page')
        click('#preview')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===4"))
        remove_sidebar_page(3)
        wait_for(lambda: recovered_text() == 'First page\fSecond page\fNew page')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===3"))
        assert_page_bounds('.preview-page','.page-body')
        subprocess.run([tool('xdotool'),'key','ctrl+z'],env=env,check=True)
        wait_for(lambda: recovered_text() == 'First page\fSecond page\fThird page\fNew page')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===4"))
        click('#preview')
        print('Actual right-click removes the clicked page in editor and preview; Ctrl+Z restores it',flush=True)
        replace_text('First page\fSecond page')
        click('.thumbnail:nth-child(1)')
        script("const el=document.querySelector('#source-host .cm-content');el.focus();const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('insertText',false," + json.dumps('Independent content.\n'*100) + ");")
        wait_for(lambda: recovered_text() == 'Independent content.\n'*100+'\fSecond page')
        wait_for(lambda: script("return document.querySelectorAll('.source-page').length>2 && document.querySelectorAll('.source-page .cm-content')[document.querySelectorAll('.source-page').length-1].textContent==='Second page'"))
        assert_page_bounds('.source-page','.cm-scroller')
        click('#preview')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===document.querySelectorAll('.source-page').length"))
        assert_page_bounds('.preview-page','.page-body')
        assert script("return [...document.querySelectorAll('.preview-page .page-body')].at(-1).textContent.trim()==='Second page'")
        print('Overflow continues onto new A4 pages and preserves the following explicit page',flush=True)
        count_before = script("return document.querySelectorAll('.preview-page').length")
        click('.thumbnail:last-child')
        click('#add-page')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length") == count_before+1)
        assert script("return document.querySelector('#preview').getAttribute('aria-pressed')==='true' && [...document.querySelectorAll('.preview-page .page-body')].at(-1).textContent==='' && [...document.querySelectorAll('.preview-page .page-body')].at(-2).textContent.trim()==='Second page'")
        wait_for(lambda: recovered_text() == 'Independent content.\n'*100+'\fSecond page\f')
        assert_page_bounds('.preview-page', '.page-body')
        print('Preview insertion follows the current page and preserves automatic flow',flush=True)
        click('#preview')
        script("const el=document.querySelector('#size');el.value=15;el.dispatchEvent(new Event('input'));")
        # Mixed Markdown, blank lines and wrapped paragraphs expose native
        # row measurement and soft-wrap rectangle bugs after several pages.
        paragraph = ('Use labels for repeated experiments. Repeat a command with each '
                     '`--seed_everything` value and a matching logger name such as '
                     '`seed_x` or `seed_y`. Use a separate output location for each '
                     'model size, dataset, and head/mode combination. Explicit names '
                     'make comparisons easier.')
        markdown = '\n\n'.join(f'# Section {i}\n\n{paragraph}\n\n```bash\nOUTPUT_PATH=logs-base/version_0/checkpoints/last.ckpt\n```' for i in range(40))
        replace_text(markdown)
        script("const el=document.querySelector('#zoom'); el.value=130; el.dispatchEvent(new Event('input'));")
        time.sleep(.5)
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length===document.querySelectorAll('.source-page').length"))
        count = script("return document.querySelectorAll('.thumbnail').length")
        assert count > 5, count
        def visible_thumbnail(index):
            return script("const host=document.querySelector('#thumbnails'),thumb=host.children["+str(index)+"],h=host.getBoundingClientRect(),r=thumb.getBoundingClientRect();return r.top>=h.top-1 && r.bottom<=h.bottom+1")
        script("document.querySelectorAll('.source-page')[9].scrollIntoView({block:'start'})")
        wait_for(lambda: visible_thumbnail(9))
        wait_for(lambda: script("return document.querySelectorAll('.thumbnail')[9].getAttribute('aria-current')==='page'"))
        click('#preview')
        wait_for(lambda: script("return document.querySelectorAll('.preview-page').length") == count)
        script("document.querySelectorAll('.preview-page')[9].scrollIntoView({block:'start'})")
        wait_for(lambda: visible_thumbnail(9))
        script("document.querySelectorAll('.preview-page')[0].scrollIntoView({block:'start'})")
        wait_for(lambda: visible_thumbnail(0))
        click('#preview')
        print('Sidebar scrolls and updates its current indicator for the visible editor and preview pages',flush=True)
        for index in range(count):
            click(f'.thumbnail:nth-child({index+1})')
            time.sleep(.2)
            bad = script("return [...document.querySelectorAll('#source-host .source-page')].flatMap(paper=>{const box=paper.getBoundingClientRect(),scale=box.width/595.28,margin=parseFloat(getComputedStyle(paper).paddingTop);const scroller=paper.querySelector('.cm-scroller'),r=scroller.getBoundingClientRect();return r.left<box.left+margin*scale-1||r.right>box.right-margin*scale+1||r.top<box.top+margin*scale-1||r.bottom>box.bottom-(margin+42)*scale+1||getComputedStyle(paper).overflow!=='hidden'||getComputedStyle(scroller).overflowY!=='clip'||scroller.scrollHeight>scroller.clientHeight+1||paper.querySelectorAll('.cm-editor').length!==1?[paper.dataset.pageIndex]:[];});")
            assert not bad, (index+1, bad)
        print(f'All {count} A4 pages contain their source text at 130% zoom, display scale {options.display_scale}', flush=True)
        replace_text('Saved baseline')
        script("const el=document.querySelector('#zoom'); el.value=100; el.dispatchEvent(new Event('input'));")
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

