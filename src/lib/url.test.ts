import { describe, expect, it } from "vitest";
import { displayHost, normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  it("keeps a full URL", () => {
    expect(normalizeUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
  });

  it("adds a scheme to a bare hostname", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });

  it("recognises localhost with a port, which is the whole point", () => {
    expect(normalizeUrl("localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizeUrl("http://localhost:3000/app")).toBe("http://localhost:3000/app");
  });

  it("searches for a phrase", () => {
    expect(normalizeUrl("how to exit vim")).toBe(
      "https://duckduckgo.com/?q=how%20to%20exit%20vim",
    );
  });

  it("searches for a single word rather than guessing a hostname", () => {
    expect(normalizeUrl("tauri")).toContain("duckduckgo.com/?q=tauri");
  });

  it("refuses to follow a javascript: URL and searches instead", () => {
    expect(normalizeUrl("javascript:alert(1)")).toContain("duckduckgo.com/?q=");
  });

  it("refuses to follow a file: URL", () => {
    expect(normalizeUrl("file:///etc/passwd")).toContain("duckduckgo.com/?q=");
  });

  it("treats an empty box as going nowhere", () => {
    expect(normalizeUrl("   ")).toBe("about:blank");
  });

  it("does not mistake a path with a port-like colon for a host", () => {
    expect(normalizeUrl("notes:today")).toContain("duckduckgo.com/?q=");
  });
});

describe("displayHost", () => {
  it("drops a leading www", () => {
    expect(displayHost("https://www.example.com/x")).toBe("example.com");
  });

  it("returns nothing for a non-URL", () => {
    expect(displayHost("about:blank")).toBeNull();
  });
});
