/**
 * A socket noVNC can drive, made of jterm's IPC instead of a WebSocket.
 *
 * noVNC takes anything shaped like a WebSocket or an `RTCDataChannel`: a
 * `send`, a `close`, a `readyState` and the four `on…` handlers. This is that
 * shape over `vnc.rs`, which holds the real TCP connection. See there for why
 * the bytes travel as raw binary rather than as JSON.
 *
 * **Sends are queued and coalesced.** Each send is its own IPC request, and
 * nothing promises that two requests in flight at once are handled in the
 * order they were made. VNC is a byte stream — a key press split around
 * another message is a corrupt connection — so only one send is ever in
 * flight, and whatever noVNC hands over while it is goes out as one request
 * after it. A mouse drag produces dozens of tiny messages; batched, it is a
 * handful of requests rather than a queue of round trips.
 *
 * The transport is passed in, so the ordering — the only subtle part — can be
 * tested in node without Tauri.
 */

/** Down the wire: bytes, or the one message that says it has ended. */
export type IncomingMessage = ArrayBuffer | { closed: string };

export interface Transport {
  /** Resolves when connected, rejects with a reason when it cannot be. */
  open(onMessage: (message: IncomingMessage) => void): Promise<void>;
  send(bytes: Uint8Array): Promise<void>;
  close(): void;
}

/** Enough of a `CloseEvent` for noVNC, which reads `code` and `reason`. */
export interface SocketClose {
  code: number;
  reason: string;
  wasClean: boolean;
}

type State = "connecting" | "open" | "closing" | "closed";

export class TauriSocket {
  // The names noVNC checks for. `binaryType` and `protocol` mean nothing over
  // this transport, but are read, and must exist for the shape to pass.
  binaryType = "arraybuffer";
  protocol = "";
  readyState: State = "connecting";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: SocketClose) => void) | null = null;

  private readonly transport: Transport;
  private pending: Uint8Array[] = [];
  private sending = false;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.open((message) => this.receive(message)).then(
      () => {
        if (this.readyState !== "connecting") return;
        this.readyState = "open";
        this.onopen?.(new Event("open"));
        this.flush();
      },
      (error: unknown) => {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        this.onerror?.(new Event("error"));
        this.onclose?.({ code: 1006, reason: String(error), wasClean: false });
      },
    );
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState === "closing" || this.readyState === "closed") return;
    // Copied: noVNC hands over a view of its own send buffer, which it reuses
    // for the next message the moment this returns.
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.pending.push(view.slice());
    this.flush();
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.pending = [];
    this.transport.close();
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }

  private receive(message: IncomingMessage): void {
    if (message instanceof ArrayBuffer) {
      if (this.readyState === "open") this.onmessage?.({ data: message });
      return;
    }
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.({ code: 1000, reason: message.closed, wasClean: true });
  }

  private flush(): void {
    if (this.sending || this.readyState !== "open" || this.pending.length === 0) return;
    const batch = join(this.pending);
    this.pending = [];
    this.sending = true;
    this.transport.send(batch).then(
      () => {
        this.sending = false;
        this.flush();
      },
      () => {
        // A write that fails means the socket is gone; the reader will say so
        // with the reason, so this only stops sending into it.
        this.sending = false;
        this.pending = [];
      },
    );
  }
}

function join(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
