"""Renders the clip at the top of the setup dialog.

    python3 reel.py [out_dir]     # default: ../public

Like the film it is drawn, not recorded. Writes setup-reel.mp4, setup-reel.webm
and the poster setup-reel.webp. Both video formats are needed: the app runs in
each platform's own webview, and WebKitGTK often has no H.264 decoder while
older WebKit on macOS has no VP9.

Frames are drawn at twice the output size, because the wall of agents is small
type and survives being scaled down far better than being drawn small.
"""
import asyncio
import glob
import io
import os
import subprocess
import sys
import tempfile

import imageio_ffmpeg
from PIL import Image
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
WIDTH, HEIGHT, FPS = 1280, 720, 30
SCALE = ["-vf", f"scale={WIDTH}:{HEIGHT}:flags=lanczos", "-pix_fmt", "yuv420p", "-an"]


async def draw(master, out_dir):
    ffmpeg = subprocess.Popen(
        [FFMPEG, "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv444p", master],
        stdin=subprocess.PIPE,
    )
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME, args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        page = await browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=2)
        page.on("pageerror", lambda e: sys.exit(f"pageerror: {e}"))
        await page.goto("file://" + os.path.join(HERE, "index.html"))
        for script in ("multitask.js", "reel.js"):
            await page.add_script_tag(path=os.path.join(HERE, script))
        await page.evaluate("document.fonts.ready")
        frames = await page.evaluate("REEL_FRAMES")
        for frame in range(frames):
            await page.evaluate(f"reelFrame({frame})")
            shot = await page.screenshot(type="jpeg", quality=97)
            ffmpeg.stdin.write(shot)
            if frame == 0:
                poster = Image.open(io.BytesIO(shot)).convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS)
                poster.save(os.path.join(out_dir, "setup-reel.webp"), quality=78, method=6)
        await browser.close()
    ffmpeg.stdin.close()
    if ffmpeg.wait():
        sys.exit("ffmpeg failed")


def encode(master, out, *codec):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", master, *SCALE, *codec, out], check=True)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "public")
    with tempfile.TemporaryDirectory() as tmp:
        master = os.path.join(tmp, "master.mp4")
        asyncio.run(draw(master, out_dir))
        encode(master, os.path.join(out_dir, "setup-reel.mp4"), "-c:v", "libx264", "-preset", "veryslow", "-crf", "27",
               "-profile:v", "high", "-level", "3.1", "-movflags", "+faststart")
        encode(master, os.path.join(out_dir, "setup-reel.webm"), "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0",
               "-deadline", "good", "-cpu-used", "2", "-row-mt", "1")
    for name in ("setup-reel.mp4", "setup-reel.webm", "setup-reel.webp"):
        print(name, os.path.getsize(os.path.join(out_dir, name)) // 1024, "KB")


if __name__ == "__main__":
    main()
