import { describe, it, expect } from "vitest";
import { buildJsonTree } from "./build.js";
import {
  renderJson,
  lineToText,
  defaultOpenSet,
} from "./render.js";

describe("renderJson", () => {
  it("renders a collapsed object as one line with key count", () => {
    const tree = buildJsonTree({ a: 1, b: 2 });
    const lines = renderJson(tree, { open: new Set() });
    expect(lines).toHaveLength(1);
    expect(lineToText(lines[0])).toMatch(/\{\s*2 keys\s*\}/);
    expect(lineToText(lines[0])).toMatch(/▶/);
  });

  it("renders an expanded object as one line per key plus braces", () => {
    const tree = buildJsonTree({ a: 1 });
    const lines = renderJson(tree, { open: new Set(["$"]) });
    expect(lines.map(lineToText)).toEqual([
      expect.stringMatching(/▼ \{/),
      expect.stringMatching(/"a":\s+1$/),
      expect.stringMatching(/\}$/),
    ]);
  });

  it("renders an expanded array as one item per line plus brackets", () => {
    const tree = buildJsonTree([10, 20]);
    const lines = renderJson(tree, { open: new Set(["$"]) });
    expect(lines.map(lineToText)).toEqual([
      expect.stringMatching(/▼ \[/),
      expect.stringMatching(/^\s+>?\s*10,$/m),
      expect.stringMatching(/^\s+>?\s*20$/m),
      expect.stringMatching(/\]$/),
    ]);
  });

  it("assigns the documented foreground color per primitive type", () => {
    const tree = buildJsonTree({ s: "x", n: 1, b: true, z: null });
    const lines = renderJson(tree, { open: new Set(["$"]) });
    const segByText = (txt: string) =>
      lines.flatMap((l) => l.segments).find((s) => s.text === txt);
    expect(segByText('"x"')?.fg).toBe("bright-green");
    expect(segByText("1")?.fg).toBe("bright-cyan");
    expect(segByText("true")?.fg).toBe("bright-magenta");
    expect(segByText("null")?.fg).toBe("gray");
  });

  it("colors object keys as bright-white", () => {
    const tree = buildJsonTree({ k: 1 });
    const lines = renderJson(tree, { open: new Set(["$"]) });
    const keySeg = lines
      .flatMap((l) => l.segments)
      .find((s) => s.text.includes('"k"'));
    expect(keySeg?.fg).toBe("bright-white");
  });

  it("renders a longString collapsed with a preview and length", () => {
    const tree = buildJsonTree("a".repeat(200));
    const lines = renderJson(tree, { open: new Set() });
    expect(lines).toHaveLength(1);
    expect(lineToText(lines[0])).toMatch(/▶/);
    expect(lineToText(lines[0])).toMatch(/\(200 chars\)/);
  });

  it("renders a longString expanded across multiple lines", () => {
    const tree = buildJsonTree("hello\nworld");
    const lines = renderJson(tree, { open: new Set(["$"]) });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lineToText(lines[0])).toMatch(/▼/);
  });

  it("places a > marker on the cursor row", () => {
    const tree = buildJsonTree({ a: { b: 1 } });
    const lines = renderJson(tree, {
      open: new Set(["$", "$.a"]),
      cursorPath: "$.a",
    });
    const cursorLine = lines.find((l) => lineToText(l).startsWith("> "));
    expect(cursorLine).toBeDefined();
    expect(lineToText(cursorLine!)).toMatch(/"a":/);
  });
});

describe("defaultOpenSet", () => {
  it("expands top-level object and one level of nested objects", () => {
    const tree = buildJsonTree({ outer: { inner: { leaf: 1 } } });
    const open = defaultOpenSet(tree);
    expect(open.has("$")).toBe(true);
    expect(open.has("$.outer")).toBe(true);
    // The third level (`$.outer.inner`) qualifies as "small" so it's
    // also open per the small-container rule.
    expect(open.has("$.outer.inner")).toBe(true);
  });

  it("expands small containers (≤ 3 items) by default", () => {
    const tree = buildJsonTree({ a: { x: 1, y: 2, z: 3 } });
    const open = defaultOpenSet(tree);
    expect(open.has("$.a")).toBe(true);
  });

  it("leaves large nested containers collapsed", () => {
    const big = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, i]),
    );
    const tree = buildJsonTree({ a: { b: big } });
    const open = defaultOpenSet(tree);
    expect(open.has("$.a.b")).toBe(false);
  });
});
