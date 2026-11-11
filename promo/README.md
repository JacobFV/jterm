# The 1.0 intro film

A 52-second intro for jterm, drawn rather than recorded: `index.html` is a
hand-built mock of the UI whose `renderAt(t)` paints the frame for second `t`
as a pure function of time, so headless Chromium can screenshot it frame by
frame and every render comes out identical.

```
python3 audio.py track.wav     # the music, synthesized with numpy (~5 s)
python3 render.py film         # 3,120 frames -> jterm-1.0.mp4 (~2 min)
python3 render.py stills 12.5  # one frame as a PNG, into stills/
python3 sheet.py out.png 1 2 3 # a contact sheet of those seconds
```

Needs `numpy`, `Pillow`, `playwright` (with its Chromium) and `imageio-ffmpeg`.

- `content.js` — what the fake terminals, editors and sidebar say
- `ui.js` — themes, the layout engine, pane bodies and the window chrome
- `timeline.js` — the scenes, cut to a 150 BPM grid (one beat = 24 frames)

The track, the frames and the encoded film are build products and are ignored.
