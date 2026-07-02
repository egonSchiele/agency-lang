import { describe, it, expect } from "vitest";
import * as os from "os";
import { _scanMediaPaths } from "./mediaPathScan.js";

function paths(msg: string): string[] {
  return _scanMediaPaths(msg).map((candidate) => candidate.path);
}

describe("_scanMediaPaths", () => {
  it("finds a plain path token with its MIME type", () => {
    expect(_scanMediaPaths("look at /tmp/pic.png please")).toEqual([
      { path: "/tmp/pic.png", mime: "image/png" },
    ]);
  });

  it("returns [] for text-only messages (cheap bail-out)", () => {
    expect(_scanMediaPaths("please draw me a diagram")).toEqual([]);
    expect(_scanMediaPaths("")).toEqual([]);
  });

  it("an apostrophe in prose does not defeat detection", () => {
    // Regression (PR #395 review, finding 1): a stateful quote scanner
    // treated the apostrophe in "here's" as opening a quote and swallowed
    // the rest of the message into one garbage token.
    expect(paths("here's /tmp/pic.png")).toEqual(["/tmp/pic.png"]);
    expect(paths("it's Bob's file /tmp/pic.png ok")).toEqual(["/tmp/pic.png"]);
  });

  it("an apostrophe in prose does not defeat a LATER quoted path", () => {
    expect(paths("here's '/tmp/my pic.png'")).toEqual(["/tmp/my pic.png"]);
  });

  it("lifts single- and double-quoted paths with spaces", () => {
    expect(paths("see '/tmp/da b.png' now")).toEqual(["/tmp/da b.png"]);
    expect(paths('see "/tmp/da b.png" now')).toEqual(["/tmp/da b.png"]);
  });

  it("ignores quoted spans that are not media paths", () => {
    expect(paths("he said 'hello there' about /tmp/pic.png")).toEqual(["/tmp/pic.png"]);
  });

  it("a quote glued to a word does not open a span", () => {
    expect(paths("dogs' /tmp/a.png cats' /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });

  it("unescapes backslash-escaped spaces in unquoted tokens", () => {
    expect(paths("see /tmp/da\\ b.png now")).toEqual(["/tmp/da b.png"]);
  });

  it("trims trailing punctuation and stray quotes", () => {
    expect(paths("is it /tmp/pic.png?")).toEqual(["/tmp/pic.png"]);
    expect(paths("check /tmp/pic.png, then /tmp/doc.pdf.")).toEqual([
      "/tmp/pic.png",
      "/tmp/doc.pdf",
    ]);
  });

  it("expands a leading tilde via expandPath", () => {
    expect(paths("see ~/pic.png")).toEqual([`${os.homedir()}/pic.png`]);
  });

  it("leaves ~user paths alone instead of throwing", () => {
    // expandPath throws on `~user/...`; a media mention must never crash
    // detection. The token passes through and dies at the stat gate.
    expect(paths("see ~bob/pic.png")).toEqual(["~bob/pic.png"]);
  });

  it("preserves message order across quoted and unquoted mentions", () => {
    expect(paths("/tmp/a.png then '/tmp/b b.pdf' then /tmp/c.gif")).toEqual([
      "/tmp/a.png",
      "/tmp/b b.pdf",
      "/tmp/c.gif",
    ]);
  });

  it("matches extensions case-insensitively and maps all six", () => {
    expect(_scanMediaPaths("a.PNG b.jpg c.jpeg d.gif e.webp f.pdf").map((c) => c.mime)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
    ]);
  });

  it("ignores non-media extensions", () => {
    expect(paths("read /tmp/notes.md and /tmp/code.ts")).toEqual([]);
  });

  it("does not treat a mid-word dot-ext substring as a path", () => {
    // "x.pngs" has no media extension per extname; the hint regex lets it
    // into tokenization but the candidate gate drops it.
    expect(paths("weird x.pngs token")).toEqual([]);
  });
});
