import { describe, it, expect } from "vitest";
import { formatKey, keyMatches } from "./format.js";

describe("formatKey", () => {
  it("returns single-char keys verbatim", () => {
    expect(formatKey({ key: "j" })).toBe("j");
    expect(formatKey({ key: "G" })).toBe("G");
  });

  it("title-cases named keys", () => {
    expect(formatKey({ key: "up" })).toBe("Up");
    expect(formatKey({ key: "enter" })).toBe("Enter");
    expect(formatKey({ key: "pagedown" })).toBe("PageDown");
  });

  it("prefixes with Ctrl+ / Shift+ in canonical order", () => {
    expect(formatKey({ key: "c", ctrl: true })).toBe("Ctrl+C");
    expect(formatKey({ key: "tab", shift: true })).toBe("Shift+Tab");
    expect(formatKey({ key: "right", ctrl: true, shift: true })).toBe(
      "Ctrl+Shift+Right",
    );
  });
});

describe("keyMatches", () => {
  it("matches by canonical name, case-insensitively", () => {
    expect(keyMatches({ key: "j" }, "j")).toBe(true);
    expect(keyMatches({ key: "c", ctrl: true }, "ctrl+c")).toBe(true);
    expect(keyMatches({ key: "up" }, "UP")).toBe(true);
    expect(keyMatches({ key: "j" }, "k")).toBe(false);
  });
});
