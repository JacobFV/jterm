import { describe, expect, it } from "vitest";
import { extensionOf, fileName, isAudio, kindForPath } from "./filetypes";

describe("extensionOf", () => {
  it("reads an ordinary extension", () => {
    expect(extensionOf("/home/me/photo.PNG")).toBe("png");
  });

  it("treats a dotfile as having none", () => {
    expect(extensionOf("/home/me/.gitignore")).toBe("");
    expect(extensionOf(".env")).toBe("");
  });

  it("returns nothing for a file without one", () => {
    expect(extensionOf("/usr/bin/Makefile")).toBe("");
  });

  it("handles Windows separators", () => {
    expect(extensionOf("C:\\Users\\me\\notes.md")).toBe("md");
  });

  it("takes only the last extension", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });
});

describe("fileName", () => {
  it("takes the last segment on either separator", () => {
    expect(fileName("/a/b/c.txt")).toBe("c.txt");
    expect(fileName("C:\\a\\b.txt")).toBe("b.txt");
  });
});

describe("kindForPath", () => {
  it("routes pictures to the image pane", () => {
    expect(kindForPath("shot.png")).toBe("image");
    expect(kindForPath("diagram.SVG")).toBe("image");
  });

  it("routes video and audio to the media pane", () => {
    expect(kindForPath("clip.mp4")).toBe("media");
    expect(kindForPath("song.flac")).toBe("media");
  });

  it("routes meshes to the model pane", () => {
    expect(kindForPath("bracket.stl")).toBe("model");
  });

  it("falls back to the editor for anything else", () => {
    expect(kindForPath("main.rs")).toBe("notepad");
    expect(kindForPath("Dockerfile")).toBe("notepad");
    expect(kindForPath(".bashrc")).toBe("notepad");
    expect(kindForPath("mystery.qqq")).toBe("notepad");
  });
});

describe("isAudio", () => {
  it("distinguishes sound from video", () => {
    expect(isAudio("a.mp3")).toBe(true);
    expect(isAudio("a.mp4")).toBe(false);
  });
});
