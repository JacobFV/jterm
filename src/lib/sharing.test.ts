import { describe, expect, it } from "vitest";

import {
  connectLine,
  describeAllowed,
  nativeServices,
  reachOf,
  summary,
  whoMaySignIn,
  widestReach,
  type SharingStatus,
} from "./sharing";

describe("reachOf", () => {
  it("knows the private ranges", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.20", "fd12::1"]) {
      expect(reachOf(address)).toBe("lan");
    }
  });

  it("does not mistake the neighbours of private ranges for private", () => {
    expect(reachOf("172.32.0.1")).toBe("internet");
    expect(reachOf("192.169.0.1")).toBe("internet");
    expect(reachOf("11.0.0.1")).toBe("internet");
  });

  it("calls Tailscale-style addresses a private network, not the internet", () => {
    expect(reachOf("100.101.102.103")).toBe("overlay");
    expect(reachOf("fd7a:115c:a1e0::1")).toBe("overlay");
    expect(reachOf("100.128.0.1")).toBe("internet");
  });

  it("treats a global IPv6 address as public", () => {
    expect(reachOf("2601:646:8f00::1a")).toBe("internet");
  });

  it("knows link-local", () => {
    expect(reachOf("169.254.10.1")).toBe("local");
    expect(reachOf("fe80::1")).toBe("local");
  });
});

describe("widestReach", () => {
  it("reports the furthest, since that is what the warning is about", () => {
    expect(widestReach(["192.168.1.2", "2601::1"])).toBe("internet");
    expect(widestReach(["192.168.1.2", "100.64.0.1"])).toBe("overlay");
    expect(widestReach([])).toBeNull();
  });
});

describe("describeAllowed", () => {
  it("says every account when a Mac has no allow-list", () => {
    expect(describeAllowed({ allowedUsers: null, allowedGroups: [] }, true)).toBe(
      "every account on this Mac",
    );
  });

  it("names administrators as people would", () => {
    expect(describeAllowed({ allowedUsers: [], allowedGroups: ["admin"] }, true)).toBe(
      "administrators",
    );
    expect(describeAllowed({ allowedUsers: ["jacob"], allowedGroups: ["admin"] }, true)).toBe(
      "jacob and administrators",
    );
  });

  it("starts a line with a capital when it stands alone", () => {
    expect(whoMaySignIn({ allowedUsers: [], allowedGroups: ["admin"] }, true)).toBe("Administrators");
  });

  it("says no one for an empty list, rather than nothing", () => {
    expect(describeAllowed({ allowedUsers: [], allowedGroups: [] }, true)).toBe("no one");
  });
});

const status: SharingStatus = {
  hostName: "studio.local",
  user: "jacob",
  addresses: ["192.168.1.20", "100.70.1.2"],
  services: [
    { service: "ssh", port: 22, listening: true, allowedUsers: null, allowedGroups: [] },
    { service: "vnc", port: 5900, listening: true, allowedUsers: null, allowedGroups: [] },
    { service: "rdp", port: 3389, listening: false, allowedUsers: null, allowedGroups: [] },
  ],
};

describe("connectLine", () => {
  it("uses the network name, and the user for ssh", () => {
    expect(connectLine(status, "ssh")).toBe("ssh jacob@studio.local");
    expect(connectLine(status, "vnc")).toBe("vnc://studio.local");
  });

  it("falls back to a LAN address, bracketing IPv6", () => {
    expect(connectLine({ ...status, hostName: null }, "vnc")).toBe("vnc://192.168.1.20");
    expect(connectLine({ ...status, hostName: null, addresses: ["fd12::5"] }, "rdp")).toBe(
      "[fd12::5]:3389",
    );
  });
});

describe("summary", () => {
  it("lists what is on", () => {
    expect(summary(status)).toBe(
      "This computer is sharing terminal access (ssh) and its screen (VNC).",
    );
  });

  it("says plainly when nothing is", () => {
    const off = { ...status, services: status.services.map((s) => ({ ...s, listening: false })) };
    expect(summary(off)).toBe("Nothing on this computer is shared with other machines.");
  });
});

describe("nativeServices", () => {
  it("offers only the servers each platform has", () => {
    expect(nativeServices("macos")).toEqual(["ssh", "vnc"]);
    expect(nativeServices("windows")).toEqual(["ssh", "rdp"]);
  });
});
