import { beforeEach, describe, expect, it } from "vitest";

import { activityLevel, recordOutput, resetActivity } from "./activity";

/** A second of wall clock, in the timestamps a frame loop would hand over. */
const SECOND = 1000;

describe("the activity signal", () => {
  beforeEach(() => {
    resetActivity();
  });

  it("starts at rest and stays there while nothing is printing", () => {
    expect(activityLevel(0)).toBe(0);
    expect(activityLevel(SECOND)).toBe(0);
    expect(activityLevel(2 * SECOND)).toBe(0);
  });

  it("rises when a shell floods and saturates rather than running away", () => {
    activityLevel(0);
    recordOutput(1024 * 1024);
    const first = activityLevel(SECOND);
    expect(first).toBeGreaterThan(0);

    // A megabyte a second is far past full scale; the level must not exceed 1,
    // or every multiplier downstream is unbounded.
    for (let i = 2; i < 20; i++) {
      recordOutput(1024 * 1024);
      expect(activityLevel(i * SECOND)).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to rest once the output stops", () => {
    activityLevel(0);
    recordOutput(512 * 1024);
    const busy = activityLevel(SECOND);

    let level = busy;
    for (let i = 2; i < 30; i++) level = activityLevel(i * SECOND);

    expect(level).toBeLessThan(busy);
    expect(level).toBeLessThan(0.01);
  });

  it("rises faster than it falls, so a burst does not flicker", () => {
    // The asymmetry is the whole design: output arrives in bursts with gaps,
    // and a signal that decayed as fast as it climbed would strobe through a
    // build rather than staying up for it.
    activityLevel(0);
    recordOutput(512 * 1024);
    const afterOneBusySecond = activityLevel(SECOND);

    resetActivity();
    activityLevel(0);
    recordOutput(512 * 1024);
    const peak = activityLevel(SECOND);
    const afterOneQuietSecond = activityLevel(2 * SECOND);

    const rise = afterOneBusySecond - 0;
    const fall = peak - afterOneQuietSecond;
    expect(rise).toBeGreaterThan(fall);
  });

  it("forgets everything on reset, so one pane's burst is not another's", () => {
    activityLevel(0);
    recordOutput(1024 * 1024);
    expect(activityLevel(SECOND)).toBeGreaterThan(0);

    resetActivity();
    expect(activityLevel(0)).toBe(0);
  });
});
