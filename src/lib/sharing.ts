/**
 * The Sharing page's judgements, in words: how far an address reaches, who may
 * sign in, and what each kind of sharing actually hands over.
 *
 * Everything the page says about exposure is decided here, apart from the
 * drawing, because these are the sentences that must not be wrong. A page that
 * says "your network only" about a public address is worse than no page.
 */

export type Service = "ssh" | "vnc" | "rdp";

export interface ServiceStatus {
  service: Service;
  port: number;
  listening: boolean;
  allowedUsers: string[] | null;
  allowedGroups: string[];
}

export interface SharingStatus {
  hostName: string | null;
  user: string | null;
  addresses: string[];
  services: ServiceStatus[];
}

/**
 * How far an address reaches, without a firewall in the way.
 *
 * - `lan`: a private range, reachable from this network only — unless the
 *   router forwards a port to it, which is the user's doing and worth one line.
 * - `overlay`: 100.64.0.0/10 and Tailscale's IPv6 range. Tailscale, ZeroTier
 *   and carrier NAT all live here; for all of them it means "machines on that
 *   private network", which is how it is worded.
 * - `internet`: anything public. For IPv6 that is ordinary — most home
 *   connections hand out global IPv6 addresses — and reachability then rests
 *   on the router's firewall, which is exactly what the page has to say.
 * - `local`: link-local, reachable from the same cable or Wi-Fi only.
 */
export type Reach = "lan" | "overlay" | "internet" | "local";

export function reachOf(address: string): Reach {
  if (address.includes(":")) return reachOfV6(address.toLowerCase());
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return "internet";
  const [a, b] = parts;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 100 && b >= 64 && b <= 127) return "overlay";
  if (a === 169 && b === 254) return "local";
  return "internet";
}

function reachOfV6(address: string): Reach {
  if (address.startsWith("fd7a:115c:a1e0")) return "overlay";
  if (address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")) {
    return "local";
  }
  if (address.startsWith("fc") || address.startsWith("fd")) return "lan";
  return "internet";
}

export const REACH_LABEL: Record<Reach, string> = {
  lan: "this network",
  overlay: "private network (e.g. Tailscale)",
  internet: "public — the internet, unless a firewall stops it",
  local: "this link only",
};

/** The furthest any address reaches — what the warning is about. */
export function widestReach(addresses: readonly string[]): Reach | null {
  const order: Reach[] = ["internet", "overlay", "lan", "local"];
  const found = new Set(addresses.map(reachOf));
  return order.find((reach) => found.has(reach)) ?? null;
}

/** Group short names a person would not recognise, as they would say them. */
const GROUP_NAMES: Record<string, string> = {
  admin: "administrators",
  staff: "every standard account",
};

/**
 * Who may sign in, as a sentence fragment.
 *
 * `null` users mean different things by platform: on a Mac it is "the allow
 * list is off", so every account; elsewhere jterm cannot read the list, and
 * says what it does know — that an account is needed.
 */
export function describeAllowed(
  status: Pick<ServiceStatus, "allowedUsers" | "allowedGroups">,
  mac: boolean,
): string {
  if (status.allowedUsers === null) {
    return mac ? "every account on this Mac" : "accounts allowed to sign in remotely";
  }
  const names = [
    ...status.allowedUsers,
    ...status.allowedGroups.map((group) => GROUP_NAMES[group] ?? `members of ${group}`),
  ];
  if (names.length === 0) return "no one";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The same, standing alone at the start of a line. */
export function whoMaySignIn(
  status: Pick<ServiceStatus, "allowedUsers" | "allowedGroups">,
  mac: boolean,
): string {
  const phrase = describeAllowed(status, mac);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export const SERVICE_NAME: Record<Service, string> = {
  ssh: "Terminal access (ssh)",
  vnc: "Screen sharing (VNC)",
  rdp: "Remote Desktop (RDP)",
};

/** What turning a service on hands to whoever can sign in. Said plainly. */
export const SERVICE_GIVES: Record<Service, string> = {
  ssh: "A shell as the account that signs in, with that account's files and everything it may run. This is how another jterm opens your tmux sessions as its own panes.",
  vnc: "Your screen as it is, live — and your keyboard and mouse, unless the viewer chooses view only. Not encrypted unless the server encrypts it.",
  rdp: "A desktop session as the account that signs in, with its files and apps.",
};

/**
 * How another machine would connect, when a service is on — the line to copy.
 * The local-network name is preferred over an address: it survives the
 * router handing out a different one tomorrow.
 */
export function connectLine(status: SharingStatus, service: Service): string | null {
  const host = status.hostName ?? status.addresses.find((a) => reachOf(a) === "lan") ?? status.addresses[0];
  if (!host) return null;
  const shown = host.includes(":") ? `[${host}]` : host;
  switch (service) {
    case "ssh":
      return status.user ? `ssh ${status.user}@${shown}` : `ssh ${shown}`;
    case "vnc":
      return `vnc://${shown}`;
    case "rdp":
      return `${shown}:3389`;
  }
}

/**
 * The services this platform has a server for at all. A Mac has no RDP server
 * and Windows no VNC server; the page says so once rather than offering a
 * switch that does not exist.
 */
export function nativeServices(platform: "macos" | "windows" | "linux"): Service[] {
  if (platform === "macos") return ["ssh", "vnc"];
  if (platform === "windows") return ["ssh", "rdp"];
  return ["ssh", "vnc", "rdp"];
}

/** The same names, as they read mid-sentence. */
const SERVICE_PHRASE: Record<Service, string> = {
  ssh: "terminal access (ssh)",
  vnc: "its screen (VNC)",
  rdp: "Remote Desktop (RDP)",
};

/** The banner: what is on, in one sentence. */
export function summary(status: SharingStatus): string {
  const on = status.services.filter((s) => s.listening).map((s) => SERVICE_PHRASE[s.service]);
  if (on.length === 0) return "Nothing on this computer is shared with other machines.";
  const list = on.length === 1 ? on[0] : `${on.slice(0, -1).join(", ")} and ${on[on.length - 1]}`;
  return `This computer is sharing ${list}.`;
}
