import { describe, expect, it } from "vitest";

import {
  frameDocument,
  isArtifactFormat,
  isDarkColour,
  LINK_MESSAGE,
  suggestedFileName,
  type FramePalette,
} from "./artifacts";

const DARK: FramePalette = {
  background: "rgb(16, 16, 16)",
  foreground: "rgb(237, 237, 237)",
  link: "rgb(90, 155, 213)",
  dark: true,
};

describe("artifact formats", () => {
  it("are the four the pane can draw, and nothing else", () => {
    for (const format of ["html", "markdown", "svg", "mermaid"]) {
      expect(isArtifactFormat(format)).toBe(true);
    }
    for (const junk of ["HTML", "pdf", "", null, 3, {}]) expect(isArtifactFormat(junk)).toBe(false);
  });
});

describe("the frame around an HTML artifact", () => {
  it("puts the defaults inside the head, after the doctype, so the page is not in quirks mode", () => {
    const page = "<!DOCTYPE html><html lang=en><head><title>x</title></head><body>hi</body></html>";
    const framed = frameDocument("html", page, DARK);
    expect(framed.startsWith("<!DOCTYPE html><html lang=en><head><style>")).toBe(true);
    expect(framed).toContain("<title>x</title>");
    expect(framed).toContain(LINK_MESSAGE);
  });

  it("finds somewhere to put them in a page with no head, or no markup at all", () => {
    expect(frameDocument("html", "<html><body>hi</body></html>", DARK)).toMatch(/^<html><style>/);
    expect(frameDocument("html", "<!doctype html><p>hi", DARK)).toMatch(/^<!doctype html><style>/);
    expect(frameDocument("html", "<p>hi</p>", DARK)).toMatch(/^<style>.*<p>hi<\/p>$/s);
  });

  it("does not take <header> for <head>", () => {
    const framed = frameDocument("html", "<!doctype html><header>top</header>", DARK);
    expect(framed.startsWith("<!doctype html><style>")).toBe(true);
  });

  it("wears the theme with no specificity, so the page's own styles win", () => {
    const framed = frameDocument("html", "<p>hi</p>", DARK);
    expect(framed).toContain(":where(:root){color-scheme:dark;background:rgb(16, 16, 16)");
    expect(framed).toContain(":where(a){color:rgb(90, 155, 213)}");
  });

  it("refuses a theme colour that could close the style element", () => {
    const framed = frameDocument(
      "html",
      "<p>hi</p>",
      { ...DARK, background: "red}</style><script>alert(1)</script>" },
    );
    expect(framed).not.toContain("alert(1)");
    expect(framed).toContain("background:Canvas");
  });
});

describe("the frame around an SVG artifact", () => {
  it("drops the XML prolog and centres the drawing in a page of its own", () => {
    const svg = '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "x" "y">\n<svg viewBox="0 0 1 1"></svg>';
    const framed = frameDocument("svg", svg, DARK);
    expect(framed).not.toContain("<?xml");
    expect(framed).not.toContain("DOCTYPE svg");
    expect(framed).toMatch(/^<!doctype html>.*<body><svg viewBox="0 0 1 1"><\/svg><\/body><\/html>$/s);
  });
});

describe("isDarkColour", () => {
  it("reads what getComputedStyle hands back", () => {
    expect(isDarkColour("rgb(0, 0, 0)")).toBe(true);
    expect(isDarkColour("rgba(16, 16, 16, 0.9)")).toBe(true);
    expect(isDarkColour("rgb(255, 255, 255)")).toBe(false);
    expect(isDarkColour("rgb(253 246 227)")).toBe(false);
    expect(isDarkColour("nonsense")).toBe(true);
  });
});

describe("suggestedFileName", () => {
  it("makes a file name of the title, with the format's extension", () => {
    expect(suggestedFileName("Build times: Q3 / Q4", "html")).toBe("build-times-q3-q4.html");
    expect(suggestedFileName("Architecture", "mermaid")).toBe("architecture.mmd");
    expect(suggestedFileName("../../etc/passwd", "markdown")).toBe("etcpasswd.md");
    expect(suggestedFileName(undefined, "svg")).toBe("artifact.svg");
    expect(suggestedFileName("///", "svg")).toBe("artifact.svg");
  });
});
