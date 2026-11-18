"""Exercise the real extension with synthetic history in an isolated browser."""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BROWSER = os.environ.get('CHROME_TEST_EXECUTABLE')
if not BROWSER:
    candidates = sorted((Path.home() / 'Library/Caches/ms-playwright').glob('chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
    BROWSER = str(candidates[-1]) if candidates else None


def check_redirect_source(context, page, request):
    class RedirectHandler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            redirect = self.path == '/source'
            self.send_response(302 if redirect else 200)
            if redirect:
                self.send_header('Location', '/destination')
            else:
                self.send_header('Content-Type', 'text/html')
            self.end_headers()
            if not redirect:
                self.wfile.write(b'<title>Redirect destination</title>')

    with ThreadingHTTPServer(('127.0.0.1', 0), RedirectHandler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f'http://127.0.0.1:{server.server_port}'
            source, destination = origin + '/source', origin + '/destination'
            tab = context.new_page()
            tab.goto(source)
            assert tab.url == destination
            tab.close()
            visible = page.evaluate("async () => (await chrome.history.search({text:'', startTime:0, maxResults:100})).map(item => item.url)")
            assert source not in visible and destination in visible
            rules = [dict(field='both', action='remove', enabled=True, caseSensitive=False, value=source)]
            request({'type': 'save', 'settings': dict(version=1, automatic=False, interval=60, rules=rules)})
            preview = request({'type': 'preview'})
            assert [match['url'] for match in preview['items']] == [source]
            assert request({'type': 'clean', 'token': preview['token']})['deleted'] == 1
            assert page.evaluate("""async urls => Promise.all(urls.map(async url =>
                (await chrome.history.getVisits({url})).length))""", [source, destination]) == [0, 1]
        finally:
            server.shutdown()
            thread.join()

def main():
    with TemporaryDirectory(prefix='browser-test-', dir=ROOT / 'tests') as profile, sync_playwright() as p:
        context = p.chromium.launch_persistent_context(profile, executable_path=BROWSER, headless=True,
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'])
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options.html')
        page.wait_for_load_state('networkidle')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        def request(message):
            if message['type'] == 'save':
                message['revision'] = request({'type':'state'})['revision']
            response = page.evaluate('(message) => chrome.runtime.sendMessage(message)', message)
            assert response['ok'], response
            return response['result']
        state = request({'type': 'state'})
        assert state['settings']['automatic'] is False
        rules = [dict(field='both', action='remove', enabled=True, caseSensitive=False, value='discard'),
                 dict(field='domain', action='keep', enabled=True, caseSensitive=False, value='protected.example')]
        config = dict(version=1, automatic=False, interval=1, rules=rules)
        request({'type': 'save', 'settings': config})
        urls = ['http://discard.test.example/', 'https://test.example/keep', 'https://protected.example/discard']
        page.evaluate('async urls => { for (const url of urls) await chrome.history.addUrl({url}); }', urls)
        cutoff = page.evaluate("""async url => {
            const entries = await chrome.history.search({text: '', startTime: 0, maxResults: 100});
            return Math.floor(entries.find(entry => entry.url === url).lastVisitTime);
        }""", urls[0])
        # Recreate the wall clock boundary of an immediate preview using the real Chrome API.
        worker.evaluate('cutoff => { globalThis.originalNow = Date.now; Date.now = () => cutoff; }', cutoff)
        try:
            preview = request({'type': 'preview'})
            assert preview['count'] == 1, preview
            assert preview['items'][0]['url'] == urls[0]
            rules[0]['value'] = urls[0]
            request({'type': 'save', 'settings': config})
            preview = request({'type': 'preview'})
            assert preview['count'] == 1, preview
            assert preview['items'][0]['url'] == urls[0]
        finally:
            worker.evaluate('() => { Date.now = globalThis.originalNow; delete globalThis.originalNow; }')
        result = request({'type': 'clean', 'token': preview['token']})
        assert result['deleted'] == 1 and result['failed'] == 0, result
        remaining = page.evaluate('async () => (await chrome.history.search({text:"",startTime:0,maxResults:100})).map(x=>x.url)')
        assert urls[0] not in remaining and all(url in remaining for url in urls[1:]), remaining
        rules[0]['value'] = 'discard'
        config['automatic'] = True
        request({'type': 'save', 'settings': config})
        alarm = page.evaluate('() => chrome.alarms.get("history-cleanup")')
        assert alarm['periodInMinutes'] == 1, alarm
        page.evaluate('() => chrome.history.addUrl({url: \"https://timer.example/discard\"})')
        page.evaluate('async () => { const {timings} = await chrome.storage.local.get("timings"); await chrome.storage.local.set({timings: timings.map(t => ({...t, due: Date.now()-1000}))}); }')
        previous_run = request({'type':'state'})['lastRun']['time']
        page.evaluate('() => chrome.alarms.create(\"history-cleanup\", {when: Date.now()+300})')
        deadline = time.monotonic() + 15
        while request({'type':'state'})['lastRun']['time'] <= previous_run:
            assert time.monotonic() < deadline, 'Scheduled cleanup did not run'
            time.sleep(0.1)
        assert not page.evaluate('() => chrome.history.search({text: "timer.example", startTime:0, endTime:Date.now()+1000})'), (previous_run, request({'type':'state'}), page.evaluate('() => ({now:Date.now()})'), page.evaluate('() => chrome.history.search({text: "timer.example", startTime:0, endTime:Date.now()+1000})'))
        config['automatic'] = False
        request({'type': 'save', 'settings': config})
        assert page.evaluate('() => chrome.alarms.get("history-cleanup")') is None
        page.reload()
        page.wait_for_load_state('networkidle')
        page.locator('#add').click()
        rule = page.locator('.rule').last
        match_field = rule.get_by_label('Match in')
        value_field = rule.locator('input[type=text]')
        hint = rule.locator('.rule-hint')
        for field, placeholder, condition in [
            ('domain', 'e.g. example.com', 'one of its subdomains'),
            ('title', 'e.g. Summer Sale', 'the page title contains'),
            ('url', 'e.g. /flash-sale', 'the URL contains'),
            ('both', 'e.g. flash sale', 'the URL or page title contains'),
        ]:
            match_field.select_option(field)
            assert value_field.get_attribute('placeholder') == placeholder
            assert condition in hint.inner_text()
        rule.get_by_label('Action').select_option('keep')
        assert hint.inner_text().startswith('Keep the page in history')
        rule.get_by_label('Action').select_option('remove')
        assert not rule.get_by_label('Minutes', exact=True).is_visible()
        rule.get_by_label('Automatic cleanup', exact=True).select_option('custom')
        assert rule.get_by_label('Minutes', exact=True).is_visible()
        rule.get_by_label('Minutes', exact=True).fill('120')
        assert 'every 120 minutes' in hint.inner_text()
        value_field.fill('ui-check')
        page.locator('#save').click()
        page.wait_for_function('() => document.querySelector("#status").textContent === "Changes saved."')
        page.evaluate('() => chrome.history.addUrl({url:"https://test.example/ui-check"})')
        page.locator('#preview').click()
        page.wait_for_function('() => document.querySelector("#status").textContent === "Preview ready. Nothing has been removed."')
        assert '1 matching page' in page.locator('#previewSummary').inner_text(), (page.locator('#previewSummary').inner_text(), request({'type':'state'}), page.evaluate('() => chrome.history.search({text:"",startTime:0})'))
        page.locator('#clean').click()
        page.locator('button[value=remove]').click()
        page.wait_for_function('() => document.querySelector("#status").textContent.includes("Removed: 1.")')
        page.locator('#add').click()  # An unfinished rule must not prevent a backup.
        with page.expect_download(timeout=3000) as download:
            page.locator('#export').click()
        assert download.value.suggested_filename == 'chrome-history-cleaner-rules.json'
        exported = json.loads(Path(download.value.path()).read_text())
        assert exported == request({'type': 'state'})['settings']
        assert len(exported['rules']) == 3
        assert exported['rules'][2]['interval'] == 120
        exported['automatic'] = True
        page.locator('#import').set_input_files({'name':'rules.json','mimeType':'application/json','buffer':json.dumps(exported).encode()})
        page.wait_for_function('() => document.querySelector("#status").textContent.startsWith("Rules imported.")')
        assert request({'type':'state'})['settings']['automatic'] is False
        page.locator('#import').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"version":0}'})
        page.wait_for_function('() => document.querySelector("#status").textContent.startsWith("Invalid settings")')
        assert len(request({'type':'state'})['settings']['rules']) == 3
        page.locator('#preview').click()
        page.wait_for_function('() => document.querySelector("#status").textContent === "Preview ready. Nothing has been removed."')
        other = context.new_page()
        other.goto(f'chrome-extension://{extension_id}/options.html')
        other.wait_for_load_state('networkidle')
        page.locator('#stop').click()
        page.wait_for_function('() => document.querySelector("#status").textContent.startsWith("Cleanup stopped.")')
        other.locator('#interval').fill('5')
        other.locator('#save').click()
        other.wait_for_function('() => document.querySelector("#status").textContent.includes("Settings changed in another tab")')
        assert request({'type':'state'})['settings']['automatic'] is False
        assert request({'type':'state'})['settings']['interval'] == 1
        blocked = page.evaluate("async () => { try { await fetch('https://example.com'); return false; } catch { return true; } }")
        assert blocked, 'Outbound fetch must be blocked'
        for link in page.locator('footer a').all():
            assert link.get_attribute('target') == '_blank'
            assert 'noreferrer' in link.get_attribute('rel')
        other.close()
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(ROOT / 'tests' / 'browser-desktop.png'), full_page=True)
        page.set_viewport_size({'width':390, 'height':844})
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(ROOT / 'tests' / 'browser-mobile.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Horizontal overflow'
        assert not errors, errors
        check_redirect_source(context, page, request)
        context.close()
        print(json.dumps({'passed': True, 'checks': ['safe defaults','real history preview','targeted deletion','exclusion preservation','alarm create/fire/disable','responsive layout','UI add/save/preview/confirm','export/import','invalid import preserves rules','no page errors','redirect source lookup and targeted deletion']}))

if __name__ == '__main__':
    main()
