"""Renders the film frame by frame with headless Chromium, then muxes it.

    python3 render.py stills 3.2 8.0 12.5     # PNGs of those seconds, into stills/
    python3 render.py film [start end]        # frames/ -> jterm-1.0.mp4
"""
import asyncio
import glob
import os
import subprocess
import sys

import imageio_ffmpeg
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "file://" + os.path.join(HERE, "index.html")
FPS, TOTAL, WORKERS = 60, 58.4, 10
CHROME = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]


async def open_page(pw):
    browser = await pw.chromium.launch(executable_path=CHROME, args=["--force-color-profile=srgb", "--font-render-hinting=none"])
    page = await browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=1.5)
    page.on("console", lambda m: print("console:", m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: print("pageerror:", e))
    await page.goto(URL)
    await page.evaluate("document.fonts.ready")
    return browser, page


async def stills(times):
    os.makedirs(os.path.join(HERE, "stills"), exist_ok=True)
    async with async_playwright() as pw:
        browser, page = await open_page(pw)
        for t in times:
            await page.evaluate(f"renderAt({t})")
            await page.screenshot(path=os.path.join(HERE, "stills", f"{t:07.3f}.png"))
        await browser.close()


async def worker(pw, frames, out):
    browser, page = await open_page(pw)
    for i in frames:
        await page.evaluate(f"renderAt({i / FPS})")
        await page.screenshot(path=os.path.join(out, f"{i:05d}.jpg"), type="jpeg", quality=95)
    await browser.close()


async def film(start, end):
    out = os.path.join(HERE, "frames")
    os.makedirs(out, exist_ok=True)
    frames = list(range(int(start * FPS), int(end * FPS)))
    async with async_playwright() as pw:
        await asyncio.gather(*[worker(pw, frames[k::WORKERS], out) for k in range(WORKERS)])
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    name = "jterm-1.0.mp4" if (start, end) == (0, TOTAL) else f"part-{start:g}-{end:g}.mp4"
    subprocess.run([
        ff, "-y", "-loglevel", "error", "-framerate", str(FPS), "-start_number", str(frames[0]), "-i", os.path.join(out, "%05d.jpg"),
        "-ss", str(start), "-i", os.path.join(HERE, "track.wav"), "-frames:v", str(len(frames)), "-t", str(end - start),
        "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", os.path.join(HERE, name),
    ], check=True)
    print(name)


if sys.argv[1] == "stills":
    asyncio.run(stills([float(x) for x in sys.argv[2:]]))
else:
    a, b = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else (0, TOTAL)
    asyncio.run(film(a, b))
