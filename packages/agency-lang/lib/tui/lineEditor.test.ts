import { describe, expect, it } from "vitest";

import { applyLineEdit, lineEditAction } from "./lineEditor.js";

describe("lineEditAction", () => {
  it("maps the editing keys", () => {
    expect(lineEditAction({ key: "enter" })).toEqual({ kind: "submit" });
    expect(lineEditAction({ key: "escape" })).toEqual({ kind: "cancel" });
    expect(lineEditAction({ key: "backspace" })).toEqual({ kind: "backspace" });
    expect(lineEditAction({ key: "x" })).toEqual({ kind: "append", text: "x" });
  });

  it("appends a paste as one edit, with control characters removed", () => {
    expect(lineEditAction({ key: "paste", text: "two\nlines" })).toEqual({
      kind: "append",
      text: "two lines",
    });
    expect(lineEditAction({ key: "paste", text: "" })).toBeNull();
  });

  it("ignores chords and keys that are not text", () => {
    expect(lineEditAction({ key: "f", ctrl: true })).toBeNull();
    expect(lineEditAction({ key: "up" })).toBeNull();
  });
});

describe("applyLineEdit", () => {
  it("changes the draft only for append and backspace", () => {
    expect(applyLineEdit("ab", { kind: "append", text: "c" })).toBe("abc");
    expect(applyLineEdit("ab", { kind: "backspace" })).toBe("a");
    expect(applyLineEdit("ab", { kind: "cancel" })).toBe("ab");
    expect(applyLineEdit("ab", { kind: "submit" })).toBe("ab");
  });
});
