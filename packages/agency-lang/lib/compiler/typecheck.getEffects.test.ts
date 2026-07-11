import { describe, expect, it } from "vitest";
import { getEffectsFromSource } from "./typecheck.js";

describe("getEffectsFromSource", () => {
  it("reports direct effects on an exported node", () => {
    const src = `export node main() {\n  write("out.txt", "hi")\n}`;
    expect(getEffectsFromSource(src)).toEqual({ main: ["std::write"] });
  });

  it("reports transitive effects through a local def and omits unexported symbols", () => {
    const src =
      `def helper() {\n  write("out.txt", "hi")\n}\n` +
      `export node main() {\n  helper()\n}`;
    expect(getEffectsFromSource(src)).toEqual({ main: ["std::write"] });
  });

  it("sorts, dedups, and includes exported defs, not just nodes", () => {
    const src =
      `export def helper() {\n` +
      `  write("a.txt", "hi")\n` +
      `  write("b.txt", "ho")\n` +
      `  const x = read("a.txt")\n` +
      `  return x\n` +
      `}`;
    expect(getEffectsFromSource(src)).toEqual({
      helper: ["std::read", "std::write"],
    });
  });

  it("maps a clean exported node to an empty list, not absence", () => {
    const src = `export node main() {\n  return 1\n}`;
    expect(getEffectsFromSource(src)).toEqual({ main: [] });
  });

  it("reports the unknown sentinel for bare interrupts", () => {
    const src = `export node main() {\n  const ok = interrupt("proceed?")\n  return ok\n}`;
    expect(getEffectsFromSource(src)).toEqual({ main: ["unknown"] });
  });

  it("throws on unparseable source", () => {
    expect(() => getEffectsFromSource("node {{{{")).toThrow();
  });
});
