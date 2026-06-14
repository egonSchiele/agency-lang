import { describe, it, expect } from "vitest";
import { _diff } from "./syntax.js";

// The dim-red / dim-green background SGR codes diffBody emits.
const RED_BG = "\x1b[48;2;60;0;0m";
const GREEN_BG = "\x1b[48;2;0;45;0m";

describe("_diff highlighted mode", () => {
  // color: true forces coloring on regardless of TTY.
  const run = (oldT: string, newT: string) =>
    _diff(oldT, newT, -1, false, true, "", "", false, false, false, "ts");

  it("backgrounds a deleted line in red and an inserted line in green", () => {
    const out = run("const x = 1", "const x = 2");
    expect(out).toContain(RED_BG);
    expect(out).toContain(GREEN_BG);
    // and it is syntax-highlighted (a foreground truecolor code is present)
    expect(out).toMatch(/\x1b\[38;2;/);
  });

  it("does not background context lines", () => {
    // line 1 unchanged, line 2 changed
    const out = run("keep\nconst x = 1", "keep\nconst x = 2");
    const firstLine = out.split("\n")[0];
    expect(firstLine).not.toContain(RED_BG);
    expect(firstLine).not.toContain(GREEN_BG);
  });

  it("ignores language when color is off (plain inline diff, no ANSI)", () => {
    const out = _diff("a", "b", -1, false, false, "", "", false, false, false, "ts");
    expect(out).not.toContain("\x1b");
    expect(out).toBe("- a\n+ b");
  });
});
