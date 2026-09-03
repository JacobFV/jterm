import { beforeEach, describe, expect, it, vi } from "vitest";

const { save } = vi.hoisted(() => ({
  save: vi.fn<(json: string) => Promise<void>>(),
}));

vi.mock("./ipc", () => ({
  session: { save },
}));

type Persistence = typeof import("./persist");

let persistence: Persistence;

beforeEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  save.mockReset();
  save.mockResolvedValue(undefined);
  persistence = await import("./persist");
});

describe("persistence writes", () => {
  it("retries an unchanged snapshot after a failed save", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    persistence.configurePersistence(() => "snapshot");

    await expect(persistence.flushPersistence()).rejects.toThrow("disk full");
    await expect(persistence.flushPersistence()).resolves.toBeUndefined();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, "snapshot");
    expect(save).toHaveBeenNthCalledWith(2, "snapshot");
  });

  it("serialises writes and skips a duplicate after the first succeeds", async () => {
    let finishFirst!: () => void;
    save.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    persistence.configurePersistence(() => "snapshot");

    const first = persistence.flushPersistence();
    const duplicate = persistence.flushPersistence();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    finishFirst();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("retries a queued duplicate when the preceding attempt fails", async () => {
    let rejectFirst!: (error: Error) => void;
    save.mockImplementationOnce(
      () => new Promise<void>((_, reject) => (rejectFirst = reject)),
    );
    persistence.configurePersistence(() => "snapshot");

    const first = persistence.flushPersistence();
    const firstFailure = first.catch((error: unknown) => error);
    const retry = persistence.flushPersistence();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    rejectFirst(new Error("write failed"));
    await expect(firstFailure).resolves.toEqual(new Error("write failed"));
    await expect(retry).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("writes a reverted snapshot after a different in-flight save", async () => {
    let snapshot = "A";
    persistence.configurePersistence(() => snapshot);
    await persistence.flushPersistence();

    let finishB!: () => void;
    save.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishB = resolve)),
    );
    snapshot = "B";
    const writeB = persistence.flushPersistence();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    snapshot = "A";
    const restoreA = persistence.flushPersistence();
    finishB();
    await Promise.all([writeB, restoreA]);

    expect(save.mock.calls.map(([json]) => json)).toEqual(["A", "B", "A"]);
  });

  it("contains rejected timer writes and allows an explicit retry", async () => {
    vi.useFakeTimers();
    save.mockRejectedValueOnce(new Error("temporary failure"));
    persistence.configurePersistence(() => "snapshot");

    persistence.markDirty();
    await vi.advanceTimersByTimeAsync(200);
    await expect(persistence.flushPersistence()).resolves.toBeUndefined();

    expect(save).toHaveBeenCalledTimes(2);
  });
});
