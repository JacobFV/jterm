"""Draws the download page's "many agents at once" picture.

    python3 multitask.py [out.webp]     # default: ../docs/multitask.webp

No jterm and no agent is involved. The film's mock of the UI is opened in
headless Chromium, multitask.js paints one still into it, and the screenshot is
the picture. WebP because this is a wall of small text: as a PNG it is several
times the size, and JPEG rings around every glyph on the black.
"""
import asyncio
import glob
import io
import os
import sys

from PIL import Image
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]
WIDTH, HEIGHT, SCALE = 1920, 1200, 1.5


async def shoot():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME, args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        page = await browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=SCALE)
        page.on("pageerror", lambda e: sys.exit(f"pageerror: {e}"))
        await page.goto("file://" + os.path.join(HERE, "index.html"))
        await page.add_script_tag(path=os.path.join(HERE, "multitask.js"))
        await page.evaluate("document.fonts.ready")
        panes = await page.evaluate(f"paintMultitask({WIDTH}, {HEIGHT})")
        png = await page.screenshot()
        await browser.close()
        return png, panes


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "docs", "multitask.webp")
    png, panes = asyncio.run(shoot())
    Image.open(io.BytesIO(png)).convert("RGB").save(out, quality=86, method=6)
    print(f"{panes} panes -> {os.path.normpath(out)} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
