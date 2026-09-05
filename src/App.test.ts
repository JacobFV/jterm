import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Snapshot } from "@/state/snapshot";
import type { PaneState, Tab, Workspace } from "@/state/workspace";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  flushPersistence: vi.fn(),
  ptyKill: vi.fn(),
  scrollbackDrop: vi.fn(),
  historyDrop: vi.fn(),
  disposeSession: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...original,
    dialog: { ...original.dialog, confirm: mocks.confirm },
    pty: { ...original.pty, kill: mocks.ptyKill },
    scrollback: { ...original.scrollback, drop: mocks.scrollbackDrop },
    history: { ...original.history, drop: mocks.historyDrop },
  };
});

vi.mock("@/lib/persist", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/persist")>();
  return { ...original, flushPersistence: mocks.flushPersistence };
});

vi.mock("@/lib/tmux", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tmux")>();
  return { ...original, disposeSession: mocks.disposeSession };
});

import {
  applySessionImport,
  createCloseRequestHandler,
  createImportQueue,
  planSessionImport,
} from "./App";
import { disposePane } from "@/panes/registry";

function tab(id: string, pane: PaneState): Tab {
  return {
    id,
    root: { kind: "leaf", id: `leaf-${id}`, paneId: pane.id },
    panes: { [pane.id]: pane },
    focusedPaneId: pane.id,
    zoomedPaneId: null,
  };
}

function workspace(...tabs: Tab[]): Workspace {
  return {
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    sidebarOpen: false,
    popups: [],
    focusedPopupId: null,
  };
}

describe("session import lifecycle", () => {
  beforeEach(() => {
    mocks.ptyKill.mockReset().mockResolvedValue(undefined);
    mocks.scrollbackDrop.mockReset().mockResolvedValue(undefined);
    mocks.historyDrop.mockReset().mockResolvedValue(undefined);
    mocks.disposeSession.mockReset().mockResolvedValue(undefined);
  });

  it("disposes ordinary panes while retaining only requested live control tabs", () => {
    const ordinary: PaneState = { id: "ordinary", kind: "terminal", tmux: "jterm-ordinary" };
    const keptControl: PaneState = {
      id: "control-kept",
      kind: "terminal",
      tmux: "work",
      tmuxPane: "%1",
    };
    const droppedControl: PaneState = {
      id: "control-dropped",
      kind: "terminal",
      tmux: "old",
      tmuxPane: "%2",
    };
    const imported: PaneState = { id: "imported", kind: "notepad" };
    const restored: Snapshot = {
      workspace: workspace(tab("imported-tab", imported)),
      content: {},
      controlSessions: ["work", "new"],
    };

    const plan = planSessionImport(
      workspace(
        tab("ordinary-tab", ordinary),
        tab("kept-control-tab", keptControl),
        tab("dropped-control-tab", droppedControl),
      ),
      restored,
    );

    expect(plan.panesToDispose).toEqual([ordinary]);
    expect(plan.workspace.tabs).toEqual([
      restored.workspace.tabs[0],
      tab("kept-control-tab", keptControl),
    ]);
    expect(plan.controlSessionsToAttach).toEqual(["new"]);
    expect(plan.controlSessionsToDetach).toEqual(["old"]);
  });

  it("waits for pane and control teardown before installing the imported workspace", async () => {
    const oldPane: PaneState = {
      id: "reused",
      kind: "terminal",
      tmux: "jterm-reused",
    };
    const importedPane: PaneState = { id: "reused", kind: "terminal" };
    const restored: Snapshot = {
      workspace: workspace(tab("imported", importedPane)),
      content: {},
      controlSessions: [],
    };
    const plan = planSessionImport(workspace(tab("old", oldPane)), restored);
    plan.controlSessionsToDetach.push("old-control");

    let finishPane!: () => void;
    let finishControl!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve) => (finishPane = resolve)));
    const detachControl = vi.fn(
      () => new Promise<void>((resolve) => (finishControl = resolve)),
    );
    const order: string[] = [];

    const applying = applySessionImport(plan, restored, {
      dispose,
      detachControl,
      load: () => order.push("load"),
      remount: () => order.push("remount"),
      restore: () => order.push("restore"),
      attachControl: () => order.push("attach"),
    });

    expect(dispose).toHaveBeenCalledWith(oldPane, true);
    expect(detachControl).toHaveBeenCalledWith("old-control");
    expect(order).toEqual([]);
    finishPane();
    await Promise.resolve();
    expect(order).toEqual([]);
    finishControl();
    await applying;
    expect(order).toEqual(["load", "remount", "restore", "attach"]);
  });

  it("observes pty and tmux teardown while preserving newly imported pane data", async () => {
    let finishPty!: () => void;
    let finishTmux!: () => void;
    mocks.ptyKill.mockReturnValue(new Promise<void>((resolve) => (finishPty = resolve)));
    mocks.disposeSession.mockReturnValue(new Promise<void>((resolve) => (finishTmux = resolve)));
    const pane: PaneState = {
      id: "reused",
      kind: "terminal",
      tmux: "jterm-reused",
    };
    let finished = false;

    const disposing = disposePane(pane, { preservePersistedData: true }).then(() => {
      finished = true;
    });

    expect(mocks.ptyKill).toHaveBeenCalledWith("reused");
    expect(mocks.disposeSession).toHaveBeenCalledWith("reused", "jterm-reused");
    expect(mocks.scrollbackDrop).not.toHaveBeenCalled();
    expect(mocks.historyDrop).not.toHaveBeenCalled();
    finishPty();
    await Promise.resolve();
    expect(finished).toBe(false);
    finishTmux();
    await disposing;
    expect(finished).toBe(true);
  });

  it("propagates terminal disposal failure after the remaining releases settle", async () => {
    const failure = new Error("pty kill failed");
    let finishTmux!: () => void;
    mocks.ptyKill.mockRejectedValue(failure);
    mocks.disposeSession.mockReturnValue(new Promise<void>((resolve) => (finishTmux = resolve)));
    const pane: PaneState = {
      id: "tmux-pane",
      kind: "terminal",
      tmux: "jterm-tmux-pan",
    };
    let rejection: unknown;

    const disposing = disposePane(pane).catch((error: unknown) => {
      rejection = error;
      throw error;
    });

    await Promise.resolve();
    expect(rejection).toBeUndefined();
    finishTmux();
    await expect(disposing).rejects.toBe(failure);
    expect(mocks.scrollbackDrop).toHaveBeenCalledWith("tmux-pane");
    expect(mocks.historyDrop).toHaveBeenCalledWith("tmux-pane");
  });

  it("propagates teardown failure only after every teardown has settled", async () => {
    const pane: PaneState = { id: "old", kind: "terminal" };
    const restored: Snapshot = {
      workspace: workspace(tab("imported", { id: "new", kind: "terminal" })),
      content: {},
      controlSessions: [],
    };
    const plan = planSessionImport(workspace(tab("old", pane)), restored);
    plan.controlSessionsToDetach.push("control");
    let finishControl!: () => void;
    const failure = new Error("pty teardown failed");
    const order: string[] = [];

    const applying = applySessionImport(plan, restored, {
      dispose: () => Promise.reject(failure),
      detachControl: () => new Promise<void>((resolve) => (finishControl = resolve)),
      load: () => order.push("load"),
      remount: () => order.push("remount"),
      restore: () => order.push("restore"),
      attachControl: () => order.push("attach"),
    });
    let rejection: unknown;
    void applying.catch((error: unknown) => {
      rejection = error;
    });

    await Promise.resolve();
    expect(rejection).toBeUndefined();
    expect(order).toEqual([]);
    finishControl();
    await expect(applying).rejects.toBe(failure);
    expect(order).toEqual([]);
  });

  it("reports a rejected import and still runs the next queued import", async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const queue = createImportQueue(report);
    const failure = new Error("could not kill old shell");
    const order: string[] = [];

    const first = queue(async () => {
      order.push("first");
      throw failure;
    });
    const second = queue(async () => {
      order.push("second");
    });

    await Promise.all([first, second]);
    expect(report).toHaveBeenCalledWith(failure);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("window close lifecycle", () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.flushPersistence.mockReset();
    mocks.flushPersistence.mockResolvedValue(undefined);
  });

  it("prevents an ordinary close until the final snapshot has flushed", async () => {
    let releaseFlush!: () => void;
    mocks.flushPersistence.mockReturnValue(new Promise<void>((resolve) => (releaseFlush = resolve)));
    const destroy = vi.fn().mockResolvedValue(undefined);
    const preventDefault = vi.fn();
    const closing = createCloseRequestHandler({ destroy }, () => workspace());

    const result = closing({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.flushPersistence).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();

    releaseFlush();
    await result;
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("keeps the window open when an unsaved-notepad prompt is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const preventDefault = vi.fn();
    const note: PaneState = { id: "note", kind: "notepad", dirty: true };
    const closing = createCloseRequestHandler({ destroy }, () => workspace(tab("note-tab", note)));

    await closing({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.flushPersistence).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("flushes and destroys after an unsaved-notepad prompt is accepted", async () => {
    mocks.confirm.mockResolvedValue(true);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const note: PaneState = { id: "note", kind: "notepad", dirty: true };
    const closing = createCloseRequestHandler({ destroy }, () => workspace(tab("note-tab", note)));

    await closing({ preventDefault: vi.fn() });

    expect(mocks.flushPersistence).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
