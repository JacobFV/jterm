/**
 * The page's side of a Remote Desktop session — see `rdp.rs` for the other —
 * kept free of React so it can be tested: the address people type, the
 * screen updates the backend sends, and the certificate fingerprint a pane
 * remembers.
 */

export const RDP_PORT = 3389;

export interface RdpAddress {
  host: string;
  port: number;
}

/** `host`, `host:port`, `[v6]:port`, and `rdp://` links. */
export function parseRdpAddress(raw: string): RdpAddress | null {
  let text = raw.trim().replace(/^rdp:\/\//i, "").replace(/\/+$/, "");
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  if (!text) return null;

  let host = text;
  let port = RDP_PORT;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const [name, number] = text.split(":");
    if (!/^\d+$/.test(number)) return null;
    host = name;
    port = Number(number);
  }
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function formatRdpAddress({ host, port }: RdpAddress): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return port === RDP_PORT ? shown : `${shown}:${port}`;
}

/** A piece of the screen: where it goes, and its RGBA pixels. */
export interface RectUpdate {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * The binary message `rdp.rs` sends for each change: eight bytes of x, y,
 * width and height as little-endian u16, then the pixels. `null` for anything
 * whose length does not add up, which is dropped rather than drawn wrong.
 */
export function decodeRect(buffer: ArrayBuffer): RectUpdate | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const x = view.getUint16(0, true);
  const y = view.getUint16(2, true);
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  if (width === 0 || height === 0 || buffer.byteLength !== 8 + width * height * 4) return null;
  return { x, y, width, height, pixels: new Uint8ClampedArray(buffer, 8) };
}

/** SHA-256 as `rdp.rs` writes it: 32 bytes of upper-case hex, colon-separated. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value);
}

/** Events, as the backend sends them alongside the screen. */
export type RdpEvent =
  | { connected: { width: number; height: number } }
  | { untrusted: { fingerprint: string; changed: boolean } }
  | { closed: string };

/** What the page sends back. Coordinates are the remote desktop's. */
export type RdpInput =
  | { kind: "move"; x: number; y: number }
  | { kind: "button"; button: number; down: boolean }
  | { kind: "wheel"; vertical: boolean; units: number }
  | { kind: "key"; scancode: number; down: boolean }
  | { kind: "releaseAll" };

/**
 * A run of input, trimmed: consecutive pointer moves collapse to the last one,
 * since only where the pointer ended up matters and a fast drag produces
 * dozens of them per frame. Nothing else is touched — every key and button
 * edge has to arrive, in order.
 */
export function coalesce(events: readonly RdpInput[]): RdpInput[] {
  const out: RdpInput[] = [];
  for (const event of events) {
    const previous = out[out.length - 1];
    if (event.kind === "move" && previous?.kind === "move") out[out.length - 1] = event;
    else out.push(event);
  }
  return out;
}
