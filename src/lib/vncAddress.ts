/**
 * What people type to name a VNC server, turned into a host and a port.
 *
 * VNC has its own convention, older than most of the software that still uses
 * it: `host:1` is not port 1 but *display* 1, which listens on 5901. A double
 * colon, `host::5901`, is the way to say a port outright. Both are in every
 * VNC client's muscle memory, so both are honoured — along with a plain
 * `host:5901`, since nobody runs a server on port 99 and a number that large
 * can only mean a port, and `vnc://` links as macOS's Screen Sharing writes
 * them.
 */

export const VNC_PORT = 5900;

export interface VncAddress {
  host: string;
  port: number;
}

/** Below this, a number after one colon is a display; at or above, a port. */
const DISPLAY_LIMIT = 100;

export function parseVncAddress(raw: string): VncAddress | null {
  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/^vnc:\/\//i, "").replace(/\/+$/, "");
  // `vnc://me@host` names a user; the server will ask for credentials anyway.
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  if (!text) return null;

  let host: string;
  let port = VNC_PORT;

  const bracketed = /^\[([^\]]+)\](?::(:)?(\d+))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[3] !== undefined) port = portFrom(bracketed[3], bracketed[2] === ":");
  } else if (text.includes("::") && !/^[0-9a-f:]+$/i.test(text.split("::")[0] + ":")) {
    // `host::5901`, where the part before is a name rather than more IPv6.
    const [name, number] = text.split("::");
    host = name;
    if (!/^\d+$/.test(number ?? "")) return null;
    port = Number(number);
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const [name, number] = text.split(":");
    host = name;
    if (!/^\d+$/.test(number)) return null;
    port = portFrom(number, false);
  } else {
    // No colon, or a bare IPv6 address, which cannot carry a port unbracketed.
    host = text;
  }

  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function portFrom(number: string, literal: boolean): number {
  const value = Number(number);
  return literal || value >= DISPLAY_LIMIT ? value : VNC_PORT + value;
}

/** The address as someone would write it back: the port only when unusual. */
export function formatVncAddress({ host, port }: VncAddress): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return port === VNC_PORT ? shown : `${shown}:${port}`;
}
