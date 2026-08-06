import { describe, expect, it } from "vitest";
import { scanOsc } from "./osc";

describe("scanOsc", () => {
  it("reads a working directory report", () => {
    expect(scanOsc("\x1b]7;file://host/home/me/code\x07").cwd).toBe("/home/me/code");
  });

  it("accepts a string terminator as well as a bell", () => {
    expect(scanOsc("\x1b]7;file://host/tmp\x1b\\").cwd).toBe("/tmp");
  });

  it("accepts an empty host", () => {
    expect(scanOsc("\x1b]7;file:///var/log\x07").cwd).toBe("/var/log");
  });

  it("decodes a path with a space in it", () => {
    expect(scanOsc("\x1b]7;file://h/home/me/My%20Notes\x07").cwd).toBe("/home/me/My Notes");
  });

  it("survives a path that is not valid percent-encoding", () => {
    expect(scanOsc("\x1b]7;file://h/odd%zz\x07").cwd).toBe("/odd%zz");
  });

  it("reads titles from OSC 0 and OSC 2", () => {
    expect(scanOsc("\x1b]0;me@box: ~\x07").title).toBe("me@box: ~");
    expect(scanOsc("\x1b]2;vim README\x07").title).toBe("vim README");
  });

  it("keeps the newest of several reports in one chunk", () => {
    const text = "\x1b]7;file://h/first\x07 out \x1b]7;file://h/second\x07";
    expect(scanOsc(text).cwd).toBe("/second");
  });

  it("finds a sequence split across two chunks", () => {
    const first = scanOsc("output\x1b]7;file://host/ho");
    expect(first.cwd).toBeUndefined();
    expect(scanOsc("me/me\x07", first.carry).cwd).toBe("/home/me");
  });

  it("does not re-report an old value as if it were new", () => {
    const first = scanOsc("\x1b]7;file://h/one\x07");
    expect(first.cwd).toBe("/one");
    // The carry still holds the old sequence, but a chunk with a newer one
    // must resolve to the newer one.
    expect(scanOsc("\x1b]7;file://h/two\x07", first.carry).cwd).toBe("/two");
  });

  it("reports nothing for ordinary output", () => {
    const scan = scanOsc("total 24\r\ndrwxr-xr-x  3 me me 4096 Jan  1 00:00 .\r\n");
    expect(scan.cwd).toBeUndefined();
    expect(scan.title).toBeUndefined();
  });

  it("keeps the carry bounded", () => {
    expect(scanOsc("x".repeat(50_000)).carry.length).toBeLessThanOrEqual(1024);
  });
});
