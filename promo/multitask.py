"""Draws the download page's "many agents at once" loop and its poster.

    python3 multitask.py [out_dir]     # default: ../docs

No jterm and no agent is involved. The film's mock of the UI is opened in
headless Chromium, multitask.js paints each frame into it, and the screenshots
are piped to ffmpeg. Writes multitask.mp4 and, from its first frame, the poster
multitask.webp: WebP because this is a wall of small text, which is several times
the size as a PNG and rings around every glyph as a JPEG.
"""
import asyncio
import glob
import io
import os
import subprocess
import sys

import imageio_ffmpeg
from PIL import Image
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]
WIDTH, HEIGHT, SCALE, FPS, FRAMES = 1920, 1200, 1.5, 30, 150


async def render(out_dir):
    ffmpeg = subprocess.Popen(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg",
         "-framerate", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "20",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", os.path.join(out_dir, "multitask.mp4")],
        stdin=subprocess.PIPE,
    )
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME, args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        page = await browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=SCALE)
        page.on("pageerror", lambda e: sys.exit(f"pageerror: {e}"))
        await page.goto("file://" + os.path.join(HERE, "index.html"))
        await page.add_script_tag(path=os.path.join(HERE, "multitask.js"))
        await page.evaluate("document.fonts.ready")
        panes = await page.evaluate(f"paintMultitask({WIDTH}, {HEIGHT})")

        poster = await page.screenshot()
        Image.open(io.BytesIO(poster)).convert("RGB").save(os.path.join(out_dir, "multitask.webp"), quality=86, method=6)
        for frame in range(FRAMES):
            await page.evaluate(f"paintFrame({frame})")
            ffmpeg.stdin.write(await page.screenshot(type="jpeg", quality=97))

        # The loop's whole claim, checked rather than assumed: one frame past the
        # end must be the first frame again, pixel for pixel.
        await page.evaluate(f"paintFrame({FRAMES})")
        if await page.screenshot() != poster:
            sys.exit("the loop does not close: the frame after the last differs from the first")
        await browser.close()
    ffmpeg.stdin.close()
    if ffmpeg.wait():
        sys.exit("ffmpeg failed")
    return panes


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "docs")
    panes = asyncio.run(render(out_dir))
    for name in ("multitask.mp4", "multitask.webp"):
        path = os.path.join(out_dir, name)
        print(f"{panes} panes -> {os.path.normpath(path)} ({os.path.getsize(path) // 1024} KB)")


if __name__ == "__main__":
    main()
