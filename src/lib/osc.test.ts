import { describe, expect, it } from "vitest";

import { scanOsc } from "./osc";

const BEL = "\x07";
const ST = "\x1b\\";

describe("OSC 7 and the title", () => {
  it("reads the directory out of a file URL", () => {
    const scan = scanOsc(`hello\x1b]7;file://host/home/me/src${BEL}world`);
    expect(scan.cwd).toBe("/home/me/src");
  });

  it("decodes a path with a space in it", () => {
    const scan = scanOsc(`\x1b]7;file://host/home/me/my%20code${BEL}`);
    expect(scan.cwd).toBe("/home/me/my code");
  });

  it("keeps only the newest of several", () => {
    const scan = scanOsc(`\x1b]7;file://h/one${BEL}\x1b]7;file://h/two${BEL}`);
    expect(scan.cwd).toBe("/two");
  });
});

describe("OSC 133 prompt marks", () => {
  it("reports each marker in the order the shell sent it", () => {
    const scan = scanOsc(`\x1b]133;A${BEL}prompt$ \x1b]133;B${BEL}ls\x1b]133;C${BEL}out`);
    expect(scan.marks.map((mark) => mark.kind)).toEqual(["prompt", "input", "running"]);
  });

  it("takes the exit status off a D, and coincidentally not off a C", () => {
    const scan = scanOsc(`\x1b]133;C${BEL}output\x1b]133;D;1${BEL}`);
    expect(scan.marks).toEqual([{ kind: "running" }, { kind: "done", code: 1 }]);
  });

  it("treats a D with no status as unknown rather than as success", () => {
    // A shell that does not report the code is not the same as one reporting
    // zero, and a terminal that guesses would mark failures as successes.
    const scan = scanOsc(`\x1b]133;D${BEL}`);
    expect(scan.marks).toEqual([{ kind: "done" }]);
    expect(scan.marks[0].code).toBeUndefined();
  });

  it("accepts the string terminator as well as BEL", () => {
    const scan = scanOsc(`\x1b]133;D;0${ST}`);
    expect(scan.marks).toEqual([{ kind: "done", code: 0 }]);
  });

  it("ignores the extra parameters other shells hang off a marker", () => {
    const scan = scanOsc(`\x1b]133;A;special_key=value${BEL}\x1b]133;D;130;more${BEL}`);
    expect(scan.marks).toEqual([{ kind: "prompt" }, { kind: "done", code: 130 }]);
  });

  it("sees a marker split across two reads, exactly once", () => {
    // The half-written sequence cannot be reported on the first read, and must
    // not be missed on the second — this is what the carry is for.
    const first = scanOsc("output\x1b]133;D;");
    expect(first.marks).toEqual([]);

    const second = scanOsc(`7${BEL}next`, first.carry);
    expect(second.marks).toEqual([{ kind: "done", code: 7 }]);
  });

  it("does not report a marker twice because the carry was rescanned", () => {
    // The bug this guards against records one command as two: the carry is the
    // tail of the previous chunk, so every marker in it comes back round.
    const first = scanOsc(`\x1b]133;C${BEL}some output\x1b]133;D;0${BEL}`);
    expect(first.marks.map((mark) => mark.kind)).toEqual(["running", "done"]);

    const second = scanOsc("more output with no markers at all", first.carry);
    expect(second.marks).toEqual([]);
  });

  it("has no marks at all for a shell that says nothing", () => {
    expect(scanOsc("just some ordinary output\r\n").marks).toEqual([]);
  });
});
