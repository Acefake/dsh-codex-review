"""UI regression checks against the local mock preview (requires Python Playwright).

Start: node plugin/dev/serve.mjs --port 4317
Run: python plugin/dev/check-ui.py
Screenshots: verify/out/ui-refactor/ (ignored by git).
"""
import os
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get('PREVIEW_BASE', 'http://127.0.0.1:4317')
OUTPUT = Path(__file__).resolve().parents[2] / 'verify' / 'out' / 'ui-refactor'
OUTPUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
        args=['--no-sandbox'],
    )
    for scene, theme, width in [
        ('default', 'dark', 1600),
        ('review', 'dark', 1600),
        ('review', 'light', 1440),
        ('changes', 'light', 1024),
        ('default', 'light', 920),
        ('default', 'dark', 952),
        ('running', 'dark', 1440),
        ('error', 'light', 1440),
        ('empty', 'dark', 1440),
        ('v11-existing-comments', 'dark', 1600),
        ('default', 'light', 430),
        ('review', 'dark', 390),
    ]:
        page = browser.new_page(viewport={'width': width, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'{BASE}/?scene={scene}&theme={theme}')
        page.locator('.cr-root').wait_for()
        if scene == 'empty':
            page.locator('.cr-list-state').wait_for()
        else:
            page.locator('.cr-pr-title').wait_for()
        if scene == 'review':
            page.locator('.cr-finding').first.wait_for()
        page.wait_for_timeout(200)
        # Only intentional horizontal scrollers (PR navigation and diffs) overflow.
        for selector in ['.cr-root', '.cr-main', '.cr-toolbar', '.cr-doc']:
            assert page.locator(selector).evaluate(
                'e => e.scrollWidth <= e.clientWidth + 1'
            ), (scene, width, selector)
        container_width = page.locator('.cr-root').evaluate('e => e.clientWidth')
        if container_width > 900 and scene != 'empty':
            rows = page.locator('.cr-row').all()
            for first, second in zip(rows, rows[1:]):
                a, b = first.bounding_box(), second.bounding_box()
                assert a['y'] + a['height'] <= b['y'] + 1, 'PR rows overlap'
        if container_width <= 900:
            assert page.locator('.cr-side').is_visible()
            rows = page.locator('.cr-row')
            second_number = rows.nth(1).get_attribute('data-pr-number')
            rows.nth(1).click()
            page.wait_for_function(
                '(number) => document.querySelector(".cr-pr-repo")?.textContent.includes("#" + number)',
                arg=second_number,
            )
            assert rows.nth(1).get_attribute('aria-current') == 'true'
        if scene != 'empty':
            # Stress real layout with long repository/PR names.
            page.locator('.cr-pr-title-text').evaluate(
                'e => e.textContent = e.textContent + " / " + "long-title-".repeat(20)'
            )
            assert page.locator('.cr-doc').evaluate('e => e.scrollWidth <= e.clientWidth + 1')
            page.reload()
            page.locator('.cr-pr-title').wait_for()
            if scene == 'review':
                page.locator('.cr-finding').first.wait_for()
        page.screenshot(path=str(OUTPUT / f'{scene}-{theme}-{width}.png'))
        assert not errors, errors
        print(f'PASS {scene} {theme} {width}px')
        page.close()
    # A desktop host can embed the workbench in a narrow panel.
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.goto(f'{BASE}/?scene=default')
    page.locator('.cr-pr-title').wait_for()
    page.locator('.cr-root').evaluate("e => e.style.width = '800px'")
    assert page.locator('.cr-side').is_visible()
    assert page.locator('.cr-layout').evaluate("e => getComputedStyle(e).flexDirection") == 'column'
    second = page.locator('.cr-row').nth(1)
    number = second.get_attribute('data-pr-number')
    second.click()
    page.wait_for_function(
        '(number) => document.querySelector(".cr-pr-repo")?.textContent.includes("#" + number)', arg=number,
    )
    page.screenshot(path=str(OUTPUT / 'embedded-800.png'))
    print('PASS embedded 800px container in 1440px viewport')
    page.close()
    # Review completed in another tab/background after this tab cached "none".
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    completed = [False]
    saved_review = json.loads((Path(__file__).parent / 'mock' / 'review-done.json').read_text())

    def detail_response(route):
        response = route.fetch()
        envelope = response.json()
        number = route.request.post_data_json.get('number')
        if number == 129 and envelope.get('ok'):
            envelope['value']['review'] = saved_review if completed[0] else {'state': 'none'}
        route.fulfill(response=response, json=envelope)

    page.route('**/codex-review/pr', detail_response)
    page.goto(f'{BASE}/?scene=default')
    page.locator('.cr-pr-title').wait_for()
    assert page.locator('.cr-review-card').count() == 0
    page.locator('.cr-row').nth(1).click()
    page.wait_for_function('() => document.querySelector(".cr-pr-repo")?.textContent.includes("#132")')
    completed[0] = True
    page.locator('.cr-row').first.click()
    page.locator('.cr-finding').first.wait_for()
    assert page.locator('.cr-root').get_attribute('data-cr-review-state') == 'done'
    page.reload()
    page.locator('.cr-finding').first.wait_for()
    page.screenshot(path=str(OUTPUT / 'restored-review.png'))
    print('PASS background result restored after PR switch and page reload')
    page.close()
    browser.close()
