/**
 * How busy the shells are, as one number between 0 and 1.
 *
 * The only consumer is the backdrop, and the point of it is that a long build
 * should be visible out of the corner of your eye without occupying a single
 * pixel of chrome. A terminal that is printing hard makes the weather move;
 * one sitting at a prompt lets it settle.
 *
 * **Bytes, not events.** The signal is how much output arrived, because that is
 * what "busy" looks like from here — a compile floods, a prompt does not. It is
 * measured across *all* panes rather than per pane: there is one backdrop
 * behind all of them, so asking it to represent one pane's state would be
 * asking it to lie about the others.
 *
 * **Asymmetric smoothing.** It rises quickly and falls slowly, which is the
 * shape that matches what is actually happening: output arrives in bursts with
 * gaps between them, and a signal that fell as fast as it rose would flicker
 * all the way through a build. Rising fast means the picture reacts the moment
 * something starts; falling slow means it stays reacted until the thing is
 * really finished.
 *
 * Nothing here subscribes or schedules. The tap is called from `ptyBus`, which
 * is already on the path of every chunk, and the value is read by whoever wants
 * it on the frame they want it — so an idle app does no work at all.
 */

/** Output per second that counts as "as busy as this needs to measure". */
const FULL_SCALE = 24 * 1024;
/** Seconds for the level to fall by roughly two thirds with nothing arriving. */
const DECAY_SECONDS = 2.2;
/** How much of a rise is taken immediately. */
const ATTACK = 0.55;

let level = 0;
let bytes = 0;
/**
 * The last timestamp read, or `null` before the first read.
 *
 * `null` rather than `0`, because `0` is a timestamp a caller can genuinely
 * hand over — `performance.now()` starts near zero, and a test starts exactly
 * there — and a sentinel that collides with a real value would leave the very
 * first frames permanently stuck in the "no previous reading" branch.
 */
let last: number | null = null;

/** Called for every chunk that arrives, from the one listener that sees them. */
export function recordOutput(length: number): void {
  bytes += length;
}

/**
 * The current level, folding in everything since the last call.
 *
 * Reading advances the smoothing, which is why it takes the timestamp rather
 * than asking the clock: the caller is a frame loop that already has one, and
 * two readers on the same frame should get the same answer.
 */
export function activityLevel(now: number): number {
  if (last === null) {
    last = now;
    return level;
  }
  const dt = Math.max(0.001, (now - last) / 1000);
  last = now;

  const rate = bytes / dt;
  bytes = 0;

  const target = Math.min(1, rate / FULL_SCALE);
  if (target > level) {
    level += (target - level) * ATTACK;
  } else {
    // Exponential, framed in seconds so the fall is the same on a 60 Hz screen
    // and a 144 Hz one.
    level *= Math.exp(-dt / DECAY_SECONDS);
  }
  return level;
}

/** Test seam: forget everything measured so far. */
export function resetActivity(): void {
  level = 0;
  bytes = 0;
  last = null;
}
