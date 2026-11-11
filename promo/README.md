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

## Where it is posted

Published 2026-11-11, the day v1.0.0 went out, as "jterm 1.0 — the terminal
that remembers". Both are the same 58-second 16:9 cut, public.

| Where | Link | Cover |
| --- | --- | --- |
| YouTube | https://youtu.be/RZH5tHWiZVA | the logo frame at 7.1 s (`render.py stills 7.1`), 1280×720 |
| TikTok | https://www.tiktok.com/@jvboid/video/7707033743298514189 | the same frame, cropped to the lockup and centred on a black 1080×1920 |

The description on both is a one-line pitch and `jacobfv.github.io/jterm`.
YouTube will not make that link clickable until the channel has done its
one-time verification. TikTok letterboxes the film; there is no 9:16 cut yet.

## How it has been promoted

Keep this list current — one line per promotion, with what it cost and what it
was aimed at, so the next one can be judged against it.

- 2026-11-11 — YouTube Studio promotion of the YouTube upload, submitted by the
  channel owner: https://studio.youtube.com/promotion/24462669520/edit
  - goal "Video views"; Finland and the United States (YouTube's defaults)
  - $2.50 in total, 2026-11-11 to 2026-11-25, postpaid through the channel's
    linked Google Ads account
  - headline "Introducing jterm 1.0: The Terminal That Remembers"
  - status when submitted: Pending (YouTube's policy check, about a business
    day); cost $0.00, 0 impressions, 0 views. Fill in the result when it ends.

Nothing has been paid for on TikTok.
