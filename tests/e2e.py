"""브라우저 자동 시험(Playwright). 항목 3종(정기·수시·게시판) × 기관 1곳을 ZIP(메모리 방식)으로 받아 내용물을 확인한다.

    python3 tests/e2e.py [주소] [화면 갈무리 저장 폴더]
"""
import asyncio
import sys
import zipfile
from pathlib import Path

from playwright.async_api import async_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787').rstrip('/')
SHOT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else None


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(accept_downloads=True, locale='ko-KR', viewport={'width': 1280, 'height': 900})
        page = await ctx.new_page()
        problems: list[str] = []
        page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
        page.on('console', lambda m: problems.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)

        await page.goto(f'{BASE}/?blob=1')
        await page.wait_for_function("document.querySelector('#status').textContent.startsWith('준비됨')", timeout=90000)
        print('status:', await page.text_content('#status'))

        async def pick_item(query: str, root: str) -> None:
            await page.fill('#itemSearch', query)
            await page.check(f'input[data-root="{root}"]')

        await pick_item('임직원 수', '20201')            # 정기: PDF
        await pick_item('감사원 지적사항', 'B1220-P2200')  # 게시판: 첨부 + 본문 텍스트
        await pick_item('내부·외부 감사결과', '43006')     # 수시: 최신 1건 PDF + 첨부
        await page.fill('#itemSearch', '')
        await page.fill('#organSearch', '한국산업단지공단')
        await page.check('input[data-id="C0208"]')
        print('summary:', (await page.text_content('#summary')).strip())
        if SHOT_DIR:
            SHOT_DIR.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(SHOT_DIR / 'e2e_before.png'), full_page=True)

        async with page.expect_download(timeout=240000) as dl_info:
            await page.click('#btnRun')
            await page.wait_for_function("document.querySelector('#log').textContent.includes('■ 끝')", timeout=240000)
        dl = await dl_info.value
        path = await dl.path()
        print('download:', dl.suggested_filename)
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            print(f'zip entries: {len(names)}')
            for n in names:
                print(f'  {z.getinfo(n).file_size:>10,d}  {n}')
            bad = z.testzip()
            print('zip integrity:', 'OK' if bad is None else f'BAD {bad}')
            csv = z.read('_수집목록.csv').decode('utf-8-sig')
            print('manifest lines:', csv.count('\n'))
            ok = bad is None and any(n.endswith('.pdf') for n in names) and any(n.endswith('.txt') for n in names) and '_수집목록.csv' in names
        log = await page.text_content('#log')
        print('log tail:\n' + '\n'.join(log.strip().splitlines()[-12:]))
        if SHOT_DIR:
            await page.screenshot(path=str(SHOT_DIR / 'e2e_after.png'), full_page=True)
        print('problems:', problems or 'none')
        await browser.close()
        return 0 if ok and not problems else 1


sys.exit(asyncio.run(main()))
