import { describe, expect, it } from "vitest";

import { directoryOf, hasScheme, isMarkdownPath, resolveRelative } from "./markdown";

describe("isMarkdownPath", () => {
  it("knows the extensions a preview is offered for", () => {
    expect(isMarkdownPath("/tmp/README.md")).toBe(true);
    expect(isMarkdownPath("/tmp/notes.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/tmp/notes.txt")).toBe(false);
    expect(isMarkdownPath("/tmp/.md")).toBe(false);
    expect(isMarkdownPath(undefined)).toBe(false);
  });
});

describe("directoryOf", () => {
  it("keeps the separator the path already uses", () => {
    expect(directoryOf("/home/x/docs/README.md")).toBe("/home/x/docs");
    expect(directoryOf("C:\\notes\\README.md")).toBe("C:\\notes");
    expect(directoryOf("README.md")).toBe("");
  });
});

describe("resolveRelative", () => {
  const dir = "/home/x/docs";

  it("resolves a path beside the document", () => {
    expect(resolveRelative(dir, "diagram.svg")).toBe("/home/x/docs/diagram.svg");
    expect(resolveRelative(dir, "./img/a.png")).toBe("/home/x/docs/img/a.png");
  });

  it("climbs, because documentation does", () => {
    expect(resolveRelative(dir, "../images/a.png")).toBe("/home/x/images/a.png");
    expect(resolveRelative(dir, "../../a.png")).toBe("/home/a.png");
  });

  it("leaves an absolute path where it is", () => {
    expect(resolveRelative(dir, "/etc/logo.png")).toBe("/etc/logo.png");
  });

  it("refuses anything that is not a file path, so it is left untouched", () => {
    expect(resolveRelative(dir, "https://example.com/a.png")).toBeNull();
    expect(resolveRelative(dir, "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveRelative(dir, "#section")).toBeNull();
    expect(resolveRelative(dir, "")).toBeNull();
  });

  it("works on Windows paths", () => {
    expect(resolveRelative("C:\\notes\\docs", "img\\a.png")).toBe("C:\\notes\\docs\\img\\a.png");
    expect(resolveRelative("C:\\notes\\docs", "..\\a.png")).toBe("C:\\notes\\a.png");
  });
});

describe("hasScheme", () => {
  it("tells a URL from a file name that merely has a colon in it", () => {
    expect(hasScheme("https://example.com")).toBe(true);
    expect(hasScheme("mailto:someone@example.com")).toBe(true);
    expect(hasScheme("notes/a:b.png")).toBe(false);
  });
});
