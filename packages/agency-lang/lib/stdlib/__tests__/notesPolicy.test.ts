import { describe, it, expect } from "vitest";
import picomatch from "picomatch";

// std::notes/apple passes "" for an omitted optional `folder`, never null.
// This test exists so nobody "tidies" that into null, and so the reasoning
// survives: an empty folder must match NOTHING, so a catch-all {"folder": "*"}
// approve rule cannot approve a listNotes() with no folder.
describe("policy globs against an omitted folder", () => {
  it("an empty folder does not match a specific glob", () => {
    expect(picomatch.isMatch("", "Work")).toBe(false);
  });

  it("an empty folder does not match a catch-all glob", () => {
    // The load-bearing one. If this ever becomes true, listNotes() with no
    // folder — the widest-reaching call in the module — starts matching any
    // {"folder": "*"} approve rule, and the payload design needs rethinking.
    expect(picomatch.isMatch("", "*")).toBe(false);
    expect(picomatch.isMatch("", "**")).toBe(false);
  });

  it("a real folder still matches", () => {
    expect(picomatch.isMatch("Work", "*")).toBe(true);
    expect(picomatch.isMatch("Work", "Work")).toBe(true);
  });

  it("null throws, which is why payloads never carry it", () => {
    expect(() => picomatch.isMatch(null as unknown as string, "Work")).toThrow();
  });
});
