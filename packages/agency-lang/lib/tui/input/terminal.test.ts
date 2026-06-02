import { describe, expect, it } from "vitest";
import {
  parseKeypress,
  readBracketed,
  readEscapeSequence,
} from "./terminal.js";

// Bracketed-paste markers — repeated locally so test failures don't
// drag in `terminal.ts` module internals just to read the constants.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("parseKeypress", () => {
  it("maps a known special key from KEY_MAP", () => {
    expect(parseKeypress("\r")).toEqual({ key: "enter" });
    expect(parseKeypress("\x7f")).toEqual({ key: "backspace" });
    expect(parseKeypress("\t")).toEqual({ key: "tab" });
  });

  it("maps Ctrl+letter (0x01-0x1a) to lowercase ctrl key", () => {
    // Ctrl+A = 0x01, Ctrl+U = 0x15, Ctrl+Z = 0x1a
    expect(parseKeypress("\x01")).toEqual({ key: "a", ctrl: true });
    expect(parseKeypress("\x15")).toEqual({ key: "u", ctrl: true });
  });

  it("treats unknown bytes as a literal printable key", () => {
    expect(parseKeypress("q")).toEqual({ key: "q" });
    expect(parseKeypress("@")).toEqual({ key: "@" });
  });
});

describe("readBracketed", () => {
  it("returns null when the open marker isn't at the start position", () => {
    expect(readBracketed("hello", 0, PASTE_START, PASTE_END)).toBeNull();
    // Open marker exists later in the string but not at `pos` — still
    // null, because the contract is "is this position the start of a
    // bracketed region", not "find one anywhere."
    expect(
      readBracketed(`xx${PASTE_START}body${PASTE_END}`, 0, PASTE_START, PASTE_END),
    ).toBeNull();
  });

  it("returns a complete read when both markers are present", () => {
    const input = `${PASTE_START}hello world${PASTE_END}trailing`;
    const result = readBracketed(input, 0, PASTE_START, PASTE_END);
    expect(result).toEqual({
      kind: "complete",
      body: "hello world",
      end: PASTE_START.length + "hello world".length + PASTE_END.length,
    });
  });

  it("returns a partial read when only the open marker is present", () => {
    // A paste that spans two `data` chunks — the open marker arrived
    // but the close marker hasn't yet. Caller is responsible for
    // buffering `body` and re-reading on the next chunk.
    const input = `${PASTE_START}half-pasted text`;
    const result = readBracketed(input, 0, PASTE_START, PASTE_END);
    expect(result).toEqual({ kind: "partial", body: "half-pasted text" });
  });

  it("respects `pos` and reads from that offset", () => {
    const input = `abc${PASTE_START}body${PASTE_END}`;
    expect(readBracketed(input, 0, PASTE_START, PASTE_END)).toBeNull();
    expect(readBracketed(input, 3, PASTE_START, PASTE_END)).toMatchObject({
      kind: "complete",
      body: "body",
    });
  });

  it("returns an empty body when open and close are adjacent", () => {
    const input = `${PASTE_START}${PASTE_END}`;
    expect(readBracketed(input, 0, PASTE_START, PASTE_END)).toEqual({
      kind: "complete",
      body: "",
      end: PASTE_START.length + PASTE_END.length,
    });
  });

  it("is marker-agnostic — any open/close pair works", () => {
    // The helper is reusable for non-paste bracketed framing.
    const input = "<<wrap>>X<<unwrap>>";
    expect(readBracketed(input, 0, "<<wrap>>", "<<unwrap>>")).toMatchObject({
      kind: "complete",
      body: "X",
    });
  });
});

describe("readEscapeSequence", () => {
  it("returns null when the byte at `pos` isn't ESC", () => {
    expect(readEscapeSequence("hello", 0)).toBeNull();
    expect(readEscapeSequence("abc", 1)).toBeNull();
  });

  it("matches a known sequence and reports bytes consumed", () => {
    // Up arrow — CSI A
    const result = readEscapeSequence("\x1b[A", 0);
    expect(result).toEqual({
      event: { key: "up" },
      consumed: 3,
    });
  });

  it("prefers the longest matching prefix (Shift+Up over plain Up)", () => {
    // `\x1b[1;2A` is Shift+Up; the shorter `\x1b[A` (plain Up) is also
    // in KEY_MAP. Longest-prefix match guarantees the modifier survives.
    const result = readEscapeSequence("\x1b[1;2A", 0);
    expect(result).toEqual({
      event: { key: "up", shift: true },
      consumed: 6,
    });
  });

  it("returns null for an ESC followed by an unknown CSI", () => {
    // `\x1b[Z` (Shift+Tab) IS known, but `\x1b[~` is not. The caller
    // is responsible for treating null as "bare ESC, advance one byte"
    // or "drop the sequence" depending on context.
    expect(readEscapeSequence("\x1b[~unknown", 0)).toBeNull();
  });

  it("recognises Alt/Option+Enter as a portable Shift+Enter fallback", () => {
    // Many terminals (Terminal.app, iTerm2) send `\x1b\r` when the
    // user presses Option+Enter. We map it to Shift+Enter so users
    // who can't get a distinct Shift+Enter code can still insert
    // newlines into the input bar.
    const result = readEscapeSequence("\x1b\r", 0);
    expect(result).toEqual({
      event: { key: "enter", shift: true },
      consumed: 2,
    });
  });
});
