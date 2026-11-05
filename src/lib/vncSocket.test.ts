import { describe, expect, it } from "vitest";

import { TauriSocket, type IncomingMessage, type Transport } from "./vncSocket";

/** A transport whose every step the test decides the timing of. */
function fake() {
  let deliver: (message: IncomingMessage) => void = () => {};
  let connect: () => void = () => {};
  let refuse: (reason: string) => void = () => {};
  const sent: number[][] = [];
  const inFlight: (() => void)[] = [];
  let closed = false;
  const transport: Transport = {
    open: (onMessage) => {
      deliver = onMessage;
      return new Promise((resolve, reject) => {
        connect = resolve;
        refuse = reject;
      });
    },
    send: (bytes) => {
      sent.push([...bytes]);
      return new Promise((resolve) => inFlight.push(resolve));
    },
    close: () => {
      closed = true;
    },
  };
  return {
    transport,
    sent,
    deliver: (message: IncomingMessage) => deliver(message),
    connect: () => connect(),
    refuse: (reason: string) => refuse(reason),
    finishSend: () => inFlight.shift()?.(),
    get closed() {
      return closed;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TauriSocket", () => {
  it("has every property noVNC checks for", () => {
    const socket = new TauriSocket(fake().transport);
    const names = [...Object.keys(socket), ...Object.getOwnPropertyNames(TauriSocket.prototype)];
    for (const name of ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState"]) {
      expect(names).toContain(name);
    }
  });

  it("opens, then holds sends made before it was open", async () => {
    const wire = fake();
    const socket = new TauriSocket(wire.transport);
    let opened = false;
    socket.onopen = () => (opened = true);
    socket.send(new Uint8Array([1, 2]));
    expect(wire.sent).toEqual([]);
    wire.connect();
    await tick();
    expect(opened).toBe(true);
    expect(socket.readyState).toBe("open");
    expect(wire.sent).toEqual([[1, 2]]);
  });

  it("keeps one send in flight and batches the rest in order", async () => {
    const wire = fake();
    const socket = new TauriSocket(wire.transport);
    wire.connect();
    await tick();
    socket.send(new Uint8Array([1]));
    socket.send(new Uint8Array([2]));
    socket.send(new Uint8Array([3, 4]));
    expect(wire.sent).toEqual([[1]]);
    wire.finishSend();
    await tick();
    expect(wire.sent).toEqual([[1], [2, 3, 4]]);
  });

  it("copies what it is given, since noVNC reuses its buffer", async () => {
    const wire = fake();
    const socket = new TauriSocket(wire.transport);
    wire.connect();
    await tick();
    socket.send(new Uint8Array([9]));
    const buffer = new Uint8Array([5, 6, 7]);
    socket.send(new Uint8Array(buffer.buffer, 1, 1));
    buffer[1] = 0;
    wire.finishSend();
    await tick();
    expect(wire.sent[1]).toEqual([6]);
  });

  it("passes bytes up and reports the far end closing with its reason", async () => {
    const wire = fake();
    const socket = new TauriSocket(wire.transport);
    const got: number[][] = [];
    let reason = "";
    socket.onmessage = (event) => got.push([...new Uint8Array(event.data)]);
    socket.onclose = (event) => (reason = event.reason);
    wire.connect();
    await tick();
    wire.deliver(new Uint8Array([8, 9]).buffer);
    wire.deliver({ closed: "The other end closed the connection." });
    expect(got).toEqual([[8, 9]]);
    expect(reason).toBe("The other end closed the connection.");
    expect(socket.readyState).toBe("closed");
  });

  it("closes uncleanly with the reason when it cannot connect", async () => {
    const wire = fake();
    const socket = new TauriSocket(wire.transport);
    let close = { code: 0, reason: "" };
    socket.onclose = (event) => (close = event);
    wire.refuse("refused");
    await tick();
    expect(close).toEqual({ code: 1006, reason: "refused", wasClean: false });
  });

  it("closes the transport when closed from this side", () => {
    const wire = fake();
    const socket = new TauriSocket(wire.transport);
    socket.close();
    expect(wire.closed).toBe(true);
    expect(socket.readyState).toBe("closed");
  });
});
