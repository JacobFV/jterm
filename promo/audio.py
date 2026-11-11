"""Synthesizes the techno bed for the jterm 1.0 intro. numpy only.

150 BPM so that a beat is exactly 0.4 s = 24 frames at 60 fps; the visuals in
timeline.js cut on the same grid.
"""
import sys
import wave

import numpy as np

SR = 44100
BEAT = int(SR * 0.4)
STEP = BEAT // 4  # a 16th
BARS = 32
TAIL = int(SR * 1.2)
N = BARS * 4 * BEAT + TAIL
rng = np.random.default_rng(7)


def t_of(n):
    return np.arange(n) / SR


def fft_filter(x, lo=0.0, hi=1e9, slope=4):
    """Zero-phase band shaping in the frequency domain."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    g = np.ones_like(f)
    if lo > 0:
        g *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-6)) ** (2 * slope))
    if hi < SR / 2:
        g *= 1 / np.sqrt(1 + (f / hi) ** (2 * slope))
    return np.fft.irfft(X * g, len(x))


def add(buf, sig, at, gain=1.0, pan=0.0):
    """Mix a mono signal into a stereo bus at a sample offset."""
    at = int(at)
    if at >= N or at < 0:
        return
    sig = sig[: N - at]
    left = np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
    right = np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
    buf[0, at : at + len(sig)] += sig * gain * left
    buf[1, at : at + len(sig)] += sig * gain * right


def bus():
    return np.zeros((2, N))


# ── voices ────────────────────────────────────────────────────────────────


def make_kick(soft=False):
    t = t_of(int(SR * 0.36))
    f = 46 + (130 if soft else 190) * np.exp(-t * 34)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t * (9 if soft else 7))
    click = rng.standard_normal(len(t)) * np.exp(-t * 900) * (0.1 if soft else 0.35)
    out = np.tanh((body + click) * (1.4 if soft else 2.6))
    out[-200:] *= np.linspace(1, 0, 200)
    return fft_filter(out, hi=900) if soft else out


def make_hat(decay, lo=7000):
    t = t_of(int(SR * min(0.4, 6 / decay)))
    noise = rng.standard_normal(len(t))
    # A little metal under the noise: six inharmonic squares, the 808 trick.
    metal = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (3214, 4150, 5407, 6211, 7933, 9127)) / 6
    return fft_filter((noise * 0.7 + metal * 0.6) * np.exp(-t * decay), lo=lo)


def make_clap():
    t = t_of(int(SR * 0.3))
    env = np.zeros_like(t)
    for d in (0.0, 0.011, 0.022, 0.034):
        m = t >= d
        env[m] += np.exp(-(t[m] - d) * 160) * 0.7
    m = t >= 0.034
    env[m] += np.exp(-(t[m] - 0.034) * 22)
    return fft_filter(rng.standard_normal(len(t)) * env, lo=900, hi=5200, slope=2)


def make_snare():
    t = t_of(int(SR * 0.16))
    tone = np.sin(2 * np.pi * (185 + 60 * np.exp(-t * 60)) * t) * np.exp(-t * 32)
    noise = fft_filter(rng.standard_normal(len(t)) * np.exp(-t * 30), lo=1500)
    return np.tanh((tone * 0.7 + noise * 0.9) * 1.6)


def make_bass(freq, length=STEP):
    t = t_of(int(length * 1.05))
    env = np.minimum(t * 400, 1) * np.exp(-t * 11)
    x = np.sin(2 * np.pi * freq * t) * 2.4 + np.sin(4 * np.pi * freq * t) * 0.7
    out = np.tanh(x) * env
    out[-120:] *= np.linspace(1, 0, 120)
    return out


def saw_filtered(freq, t, cutoff, res=1.6, harmonics=48):
    """An additive saw through a 'filter' applied as per-harmonic gain, so the
    cutoff can move every sample without a per-sample loop."""
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        fk = freq * k
        if fk > SR / 2.2:
            break
        x = fk / cutoff
        gain = 1 / np.sqrt(1 + x**8) + res * np.exp(-(((x - 1) / 0.16) ** 2))
        out += np.sin(2 * np.pi * fk * t) * gain / k
    return out


def make_acid(freq, accent, openness, length):
    t = t_of(int(length))
    cutoff = 260 + openness * 900 + (900 + openness * 2600) * (1.6 if accent else 1.0) * np.exp(-t * 26)
    env = np.minimum(t * 600, 1) * np.exp(-t * (7 if accent else 12))
    out = np.tanh(saw_filtered(freq, t, cutoff, res=1.3 + openness) * (2.4 if accent else 1.7)) * env
    out[-150:] *= np.linspace(1, 0, 150)
    return out


def make_stab(freqs, length=0.45):
    t = t_of(int(SR * length))
    out = np.zeros_like(t)
    cutoff = 700 + 3600 * np.exp(-t * 9)
    for f in freqs:
        for det in (0.994, 1.0, 1.007):
            out += saw_filtered(f * det, t, cutoff, res=0.3, harmonics=24)
    return out * np.exp(-t * 8) * np.minimum(t * 800, 1) / 6


def make_pluck(freq, length=0.3):
    t = t_of(int(SR * length))
    x = np.sin(2 * np.pi * freq * t + 1.8 * np.exp(-t * 30) * np.sin(4 * np.pi * freq * t))
    return x * np.exp(-t * 13) * np.minimum(t * 900, 1)


def make_pad(freqs, length):
    t = t_of(int(length))
    out = np.zeros_like(t)
    for i, f in enumerate(freqs):
        for det in (0.996, 1.004):
            out += saw_filtered(f * det, t, 900 + 500 * np.sin(2 * np.pi * 0.31 * t + i), res=0.1, harmonics=12)
    env = np.minimum(t / 0.5, 1) * np.minimum((t[-1] - t) / 0.5, 1)
    return out * env / (len(freqs) * 2)


def make_riser(length):
    t = t_of(int(length))
    p = t / t[-1]
    noise = fft_filter(rng.standard_normal(len(t)), lo=2500)
    sweep = np.sin(2 * np.pi * np.cumsum(180 * (2 ** (p * 4.5))) / SR)
    trem = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * np.cumsum(4 + 28 * p**2) / SR))
    return (noise * 0.5 * p**2 + sweep * 0.25 * p * trem) * p


def make_impact():
    t = t_of(int(SR * 1.6))
    crash = fft_filter(rng.standard_normal(len(t)) * np.exp(-t * 3.2), lo=3500)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t * 9)) / SR) * np.exp(-t * 3.5)
    return crash * 0.55 + np.tanh(boom * 2.2) * 0.9


def hz(semi, base=110.0):
    return base * 2 ** (semi / 12)


# ── arrangement ───────────────────────────────────────────────────────────

drums, music, wet = bus(), bus(), bus()
KICK, KICK_SOFT = make_kick(), make_kick(soft=True)
HAT, OHAT, CLAP, SNARE = make_hat(95), make_hat(17, lo=6000), make_clap(), make_snare()
RIDE = make_hat(28, lo=9000)
IMPACT = make_impact()
kick_times = []


def at(bar, beat=0, step=0):
    return (bar * 4 + beat) * BEAT + step * STEP


def kick(pos, gain=1.0, soft=False):
    add(drums, KICK_SOFT if soft else KICK, pos, gain)
    kick_times.append((pos, gain * (0.5 if soft else 1)))


GROOVE = set(range(4, 16)) | set(range(20, 31))
ROOTS = [0, 0, -4, -2]  # A A F G, as semitones from A1
ACID_NOTES = [0, 0, 12, 0, 3, 0, 12, 10, 0, 0, 7, 0, 12, 3, 0, 10]
ACID_GATE = [1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1]
ACID_ACC = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0]
ARP = [24, 27, 31, 36, 34, 31, 27, 31, 24, 27, 31, 36, 39, 36, 34, 31]
CHORDS = [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 2, 5]]  # Am Am F G

for bar in range(BARS):
    phrase = bar % 4
    root = ROOTS[phrase]

    # Kick.
    if bar in GROOVE:
        for beat in range(4):
            if bar == 15 and beat == 3:
                continue  # a hole before the breakdown
            kick(at(bar, beat))
        if bar in (11, 27):
            for s in (1, 2, 3):
                kick(at(bar, 3, s), 0.75)
    elif bar in (2, 3):
        for beat in range(4):
            kick(at(bar, beat), 0.8 + 0.1 * bar / 3, soft=bar == 2)
    elif bar == 18:
        kick(at(bar, 0), 0.8, soft=True)
        kick(at(bar, 2), 0.8, soft=True)
    elif bar == 19:
        for beat in range(4):
            kick(at(bar, beat), 0.9)
    elif bar == 31:
        kick(at(bar, 0), 1.1)

    # Hats.
    if bar in GROOVE:
        for s in range(16):
            if bar == 15 and s >= 12:
                break
            vel = (0.5, 0.22, 0.42, 0.26)[s % 4]
            add(drums, HAT, at(bar, 0, s), vel * 0.5, pan=0.25 if s % 2 else -0.15)
        if bar != 30:
            for beat in range(4):
                if not (bar == 15 and beat == 3):
                    add(drums, OHAT, at(bar, beat, 2), 0.42, pan=-0.2)
    elif bar in (0, 1, 2, 3):
        for s in range(0, 16, 2 if bar < 2 else 1):
            add(drums, HAT, at(bar, 0, s), 0.1 + 0.07 * bar, pan=0.3 if s % 4 else -0.3)

    # Clap on two and four.
    if bar in GROOVE and bar != 30:
        for beat in (1, 3):
            if not (bar == 15 and beat == 3):
                add(drums, CLAP, at(bar, beat), 0.62)
                add(wet, CLAP, at(bar, beat), 0.25)

    # Ride through the back half of the second drop.
    if 24 <= bar <= 27:
        for s in range(0, 16, 2):
            add(drums, RIDE, at(bar, 0, s), 0.2, pan=0.35)

    # Rolling bass: the three 16ths the kick leaves empty.
    if bar in GROOVE:
        for beat in range(4):
            if bar == 15 and beat == 3:
                continue
            for s in (1, 2, 3):
                add(music, make_bass(hz(root, 55.0)), at(bar, beat, s), 0.62 if s != 2 else 0.74)

    # Acid.
    if 8 <= bar <= 15 or 20 <= bar <= 27:
        if bar < 16:
            openness = 0.1 + 0.5 * (bar - 8) / 8
        else:
            openness = 0.35 + 0.65 * (bar - 20) / 8
        for s in range(16):
            if not ACID_GATE[s] or (bar == 15 and s >= 12):
                continue
            note = hz(ACID_NOTES[s] + root)
            sig = make_acid(note, ACID_ACC[s], openness, STEP * (1.7 if ACID_ACC[s] else 1.0))
            g = 0.3 if bar < 16 else 0.36
            add(music, sig, at(bar, 0, s), g, pan=0.15 * np.sin(s))
            add(wet, sig, at(bar, 0, s), g * 0.18)

    # Stabs, with a dotted echo.
    if bar in (4, 5, 6, 7, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29):
        chord = [hz(c + 12) for c in CHORDS[phrase]]
        stab = make_stab(chord)
        for s in (3, 10):
            if bar == 15 and s >= 12:
                continue
            for echo in range(4):
                add(music, stab, at(bar, 0, s + 3 * echo), 0.5 * 0.5**echo, pan=(-0.6, 0.6)[echo % 2] if echo else 0)
            add(wet, stab, at(bar, 0, s), 0.3)

    # Arp.
    if 12 <= bar <= 15 or 24 <= bar <= 29:
        for s in range(16):
            if bar == 15 and s >= 12:
                break
            sig = make_pluck(hz(ARP[s] + root if phrase >= 2 else ARP[s]))
            add(music, sig, at(bar, 0, s), 0.16, pan=0.5 * np.sin(s * 1.7))
            add(wet, sig, at(bar, 0, s), 0.12)

    # Intro: a drone and a few blips.
    if bar < 4:
        t = t_of(4 * BEAT)
        drone = np.tanh(np.sin(2 * np.pi * 55 * t) * 1.5) * (0.5 + 0.5 * np.sin(2 * np.pi * 2.5 * t) ** 2)
        drone *= np.minimum(t / 0.3, 1) * np.minimum((t[-1] - t) / 0.05, 1)
        add(music, drone, at(bar), 0.22 + 0.06 * bar)
        for s in (0, 3, 6, 8, 11, 14) if bar < 2 else range(0, 16, 2):
            sig = make_pluck(hz(ARP[(s * 3 + bar) % 16]))
            add(music, sig, at(bar, 0, s), 0.12 + 0.03 * bar, pan=np.sin(s))
            add(wet, sig, at(bar, 0, s), 0.2)

    # Breakdown: pad, half-time arp.
    if 16 <= bar <= 19:
        chord = [hz(c + 12) for c in CHORDS[(0, 2, 0, 3)[bar - 16]]] + [hz(CHORDS[(0, 2, 0, 3)[bar - 16]][0])]
        pad = make_pad(chord, 4 * BEAT)
        add(music, pad, at(bar), 0.5)
        add(wet, pad, at(bar), 0.5)
        for s in range(0, 16, 2):
            sig = make_pluck(hz(ARP[s]), 0.4)
            add(music, sig, at(bar, 0, s), 0.16, pan=0.6 * np.sin(s))
            add(wet, sig, at(bar, 0, s), 0.25)


def roll(bar, pattern):
    """A snare roll: (beat, subdivisions) pairs, getting louder."""
    total = sum(n for _, n in pattern)
    i = 0
    for beat, n in pattern:
        for k in range(n):
            add(drums, SNARE, at(bar, beat) + k * BEAT // n, 0.25 + 0.5 * i / total)
            i += 1


roll(3, [(0, 2), (1, 2), (2, 4), (3, 8)])
roll(19, [(0, 2), (1, 4), (2, 4), (3, 8)])
roll(27, [(3, 4)])
roll(11, [(3, 4)])

for bar, beats in ((3, 4), (19, 4), (15, 2), (27, 2), (30, 4)):
    length = beats * BEAT
    add(music, make_riser(length), at(bar + 1) - length, 0.5)
for beat, gain in ((16, 1.0), (48, 0.6), (64, 0.8), (80, 1.0), (96, 0.6), (112, 1.0), (124, 1.1)):
    add(drums, IMPACT, beat * BEAT, gain * 0.6)
    add(wet, IMPACT, beat * BEAT, gain * 0.25)

# ── sidechain, reverb, master ─────────────────────────────────────────────

duck = np.ones(N)
t = t_of(int(SR * 0.4))
shape = 1 - np.exp(-t * 11)
for pos, gain in kick_times:
    seg = duck[pos : pos + len(shape)]
    seg[:] = np.minimum(seg, 1 - gain * 0.8 * (1 - shape[: len(seg)]))
music *= duck
wet *= 0.4 + 0.6 * duck

ir_t = t_of(int(SR * 1.1))
size = 1 << int(np.ceil(np.log2(N + len(ir_t))))
for ch in range(2):
    ir = fft_filter(rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 5.5), lo=400, hi=7000, slope=1)
    ir /= np.sqrt(np.sum(ir**2))
    music[ch] += np.fft.irfft(np.fft.rfft(wet[ch], size) * np.fft.rfft(ir, size), size)[:N] * 0.5

mix = drums * 0.95 + music

# The power cut at beat 70: the tape slows to a stop, then nothing until 72.
cut, n = 70 * BEAT, int(BEAT * 1.1)
src = mix[:, cut - BEAT // 2 : cut - BEAT // 2 + n].copy()
rate = np.linspace(1, 0, n) ** 1.3
pos = np.cumsum(rate)
for ch in range(2):
    mix[ch, cut - BEAT // 2 : cut - BEAT // 2 + n] = np.interp(pos, np.arange(n), src[ch]) * np.linspace(1, 0.2, n)
mix[:, cut - BEAT // 2 + n : 72 * BEAT] = 0
fade = int(SR * 0.004)
mix[:, 72 * BEAT : 72 * BEAT + fade] *= np.linspace(0, 1, fade)

# Fade the tail out.
mix[:, -TAIL:] *= np.linspace(1, 0, TAIL) ** 1.5

mix = np.tanh(mix * 0.9)
mix /= np.max(np.abs(mix)) / 0.94

out = sys.argv[1] if len(sys.argv) > 1 else "track.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype("<i2").tobytes())

rms = np.sqrt(np.mean(mix**2))
print(f"{out}: {N / SR:.2f}s peak {np.max(np.abs(mix)):.2f} rms {20 * np.log10(rms):.1f} dBFS")
for bar in range(BARS):
    seg = mix[:, at(bar) : at(bar + 1)]
    print(f"bar {bar:2d} rms {20 * np.log10(np.sqrt(np.mean(seg**2)) + 1e-9):6.1f}", end="   " if bar % 4 != 3 else "\n")
