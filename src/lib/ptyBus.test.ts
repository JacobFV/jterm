import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The listener the bus attaches, captured so a payload can be delivered to it
 * the way the backend would.
 *
 * `listen` is mocked rather than the whole of `ipc`, because the event *names*
 * are the contract between this module and the backend and a test that
 * invented its own would pass while the app was wired to nothing.
 */
const attached = new Map<string, (payload: unknown) => void>();

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    listen: (event: string, handler: (payload: unknown) => void) => {
      attached.set(event, handler);
      return Promise.resolve(() => attached.delete(event));
    },
  };
});

const { PTY_DATA_EVENT, PTY_EXIT_EVENT } = await import("./ipc");
const { ready, subscribePty } = await import("./ptyBus");

function deliver(event: string, payload: unknown): void {
  const handler = attached.get(event);
  if (handler === undefined) throw new Error(`nothing is listening for ${event}`);
  handler(payload);
}

describe("the pty bus", () => {
  beforeEach(async () => {
    await ready();
    // The console line is the intended outcome of a throwing handler, not a
    // surprise; silenced so a passing run is quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("delivers a chunk to the pane it belongs to and to nobody else", () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    subscribePty("a", (chunk) => mine.push(chunk), () => {});
    subscribePty("b", (chunk) => theirs.push(chunk), () => {});

    deliver(PTY_DATA_EVENT, { id: "a", chunk: "hello" });

    expect(mine).toEqual(["hello"]);
    expect(theirs).toEqual([]);
  });

  it("keeps one pane's throwing handler away from the next pane's output", () => {
    const survivor: string[] = [];
    subscribePty(
      "bad",
      () => {
        throw new Error("this pane is broken");
      },
      () => {},
    );
    subscribePty("good", (chunk) => survivor.push(chunk), () => {});

    // The throw must not escape into the shared listener: an exception here
    // is one that reaches Tauri's event dispatch, and every other pane's
    // output is delivered through the same callback.
    expect(() => deliver(PTY_DATA_EVENT, { id: "bad", chunk: "boom" })).not.toThrow();

    deliver(PTY_DATA_EVENT, { id: "good", chunk: "still here" });
    expect(survivor).toEqual(["still here"]);
  });

  it("does the same for an exit, which is the handler that repaints the tab", () => {
    const codes: (number | null)[] = [];
    subscribePty(
      "bad",
      () => {},
      () => {
        throw new Error("this pane is broken");
      },
    );
    subscribePty("good", () => {}, (code) => codes.push(code));

    expect(() => deliver(PTY_EXIT_EVENT, { id: "bad", code: 1 })).not.toThrow();

    deliver(PTY_EXIT_EVENT, { id: "good", code: 0 });
    expect(codes).toEqual([0]);
  });

  it("shrugs at output for a pane that has already gone", () => {
    const stop = subscribePty("gone", () => {
      throw new Error("unsubscribed handlers must not run");
    }, () => {});
    stop();

    expect(() => deliver(PTY_DATA_EVENT, { id: "gone", chunk: "late" })).not.toThrow();
  });
});
