import { describe, it, expect, vi } from "vitest";
import {
  EMPTY_PASTE,
  pasteChar,
  pasteText,
  pasteBackspace,
  pasteJoin,
  classifyPasteKey,
  readMultiline,
  type PasteState,
} from "./cli.js";

/** Feed a string char-by-char through `pasteChar` (what the editor does
 *  for typed input and for a pasted chunk). */
function type(text: string, start: PasteState = EMPTY_PASTE): PasteState {
  let s = start;
  for (const ch of text) s = pasteChar(s, ch);
  return s;
}

describe("/paste buffer ops", () => {
  it("accumulates a single line", () => {
    expect(pasteJoin(type("hello"))).toBe("hello");
  });

  it("treats \\n as a line break (typed Enter or pasted newline)", () => {
    expect(pasteJoin(type("a\nb\nc"))).toBe("a\nb\nc");
  });

  it("normalizes pasted \\r\\n and bare \\r to single newlines", () => {
    // A pasted chunk goes through pasteText (CRLF/CR -> LF), not raw
    // char-by-char, so line endings don't double-break.
    expect(pasteJoin(pasteText(EMPTY_PASTE, "a\r\nb\rc"))).toBe("a\nb\nc");
  });

  it("pasteText appends a multi-line block onto existing input", () => {
    expect(pasteJoin(pasteText(type("start "), "a\nb"))).toBe("start a\nb");
  });

  it("backspace deletes within the current line", () => {
    let s = type("abc");
    s = pasteBackspace(s);
    expect(pasteJoin(s)).toBe("ab");
  });

  it("backspace is a no-op at the start of a line (no merge in v1)", () => {
    let s = type("a\n"); // current line is now empty, "a" committed
    s = pasteBackspace(s);
    expect(pasteJoin(s)).toBe("a\n");
  });

  it("backspace after typing on a later line stays on that line", () => {
    let s = type("a\nbc");
    s = pasteBackspace(s);
    expect(pasteJoin(s)).toBe("a\nb");
  });

  it("empty buffer joins to empty string", () => {
    expect(pasteJoin(EMPTY_PASTE)).toBe("");
  });
});

describe("/paste key classification", () => {
  it("Ctrl+D submits", () => {
    expect(classifyPasteKey(undefined, { name: "d", ctrl: true })).toBe("submit");
  });

  it("Ctrl+C and Esc cancel", () => {
    expect(classifyPasteKey(undefined, { name: "c", ctrl: true })).toBe("cancel");
    expect(classifyPasteKey(undefined, { name: "escape" })).toBe("cancel");
  });

  it("Enter / return insert a newline", () => {
    expect(classifyPasteKey(undefined, { name: "return" })).toBe("newline");
    expect(classifyPasteKey(undefined, { name: "enter" })).toBe("newline");
  });

  it("backspace maps to backspace", () => {
    expect(classifyPasteKey(undefined, { name: "backspace" })).toBe("backspace");
  });

  it("printable keys append themselves", () => {
    expect(classifyPasteKey("a", { name: "a" })).toEqual({ append: "a" });
    expect(classifyPasteKey(" ", { name: "space" })).toEqual({ append: " " });
  });

  it("ignores ctrl/meta chords and unknown keys", () => {
    expect(classifyPasteKey("k", { name: "k", ctrl: true })).toBeNull();
    expect(classifyPasteKey(undefined, { name: "up" })).toBeNull();
  });
});

describe("readMultiline editor (drives the hijacked _ttyWrite)", () => {
  /** Build a fake readline whose `_ttyWrite` slot readMultiline takes
   *  over, and a `send` that replays keystrokes through it. stdout is
   *  silenced so the editor's echo doesn't pollute test output. */
  function harness() {
    const fakeRl = { _ttyWrite: () => {} };
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const promise = readMultiline(fakeRl as never, false);
    const send = (s: unknown, key: Record<string, unknown>) =>
      (fakeRl as { _ttyWrite: (s: unknown, k: unknown) => void })._ttyWrite(s, key);
    return { promise, send, fakeRl, spy };
  }

  it("types two lines and submits on Ctrl+D", async () => {
    const { promise, send } = harness();
    send("a", { name: "a" });
    send("b", { name: "b" });
    send(undefined, { name: "return" });
    send("c", { name: "c" });
    send(undefined, { name: "d", ctrl: true });
    expect(await promise).toBe("ab\nc");
  });

  it("returns null when cancelled with Ctrl+C", async () => {
    const { promise, send } = harness();
    send("x", { name: "x" });
    send(undefined, { name: "c", ctrl: true });
    expect(await promise).toBeNull();
  });

  it("accepts a multi-line paste chunk without premature submit", async () => {
    const { promise, send } = harness();
    // Simulate a paste delivered as one chunk with CRLF endings.
    send("line1\r\nline2\r\nline3", { name: undefined });
    send(undefined, { name: "d", ctrl: true });
    expect(await promise).toBe("line1\nline2\nline3");
  });

  it("restores the previous _ttyWrite on exit", async () => {
    const original = () => {};
    const fakeRl = { _ttyWrite: original };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const p = readMultiline(fakeRl as never, false);
    (fakeRl._ttyWrite as (s: unknown, k: unknown) => void)(undefined, {
      name: "d",
      ctrl: true,
    });
    await p;
    expect(fakeRl._ttyWrite).toBe(original);
  });
});
