import { describe, expect, it } from "vitest";
import { __asyncDone, __asyncFinished } from "./asyncJoin.js";
import { failure } from "./result.js";

// The main arm of an `async` block returns `__asyncDone(bindings)` when it
// runs to its end, and whatever it returned otherwise. `__asyncFinished`
// tells the two apart at the join.

describe("__asyncDone", () => {
  it("keeps the bindings it is given", () => {
    const done = __asyncDone({ reply: "hi", count: 2 });
    expect(done.reply).toBe("hi");
    expect(done.count).toBe(2);
  });

  it("does not change the object it is given", () => {
    const bindings = { reply: "hi" };
    __asyncDone(bindings);
    expect(bindings).toEqual({ reply: "hi" });
    expect(__asyncFinished(bindings)).toBe(false);
  });
});

describe("__asyncFinished", () => {
  it("is true for a marked completion", () => {
    expect(__asyncFinished(__asyncDone({}))).toBe(true);
    expect(__asyncFinished(__asyncDone({ x: 1 }))).toBe(true);
  });

  it("is true for a completion that went through JSON, as a checkpoint saves it", () => {
    const saved = JSON.parse(JSON.stringify(__asyncDone({ x: 1 })));
    expect(__asyncFinished(saved)).toBe(true);
    expect(saved.x).toBe(1);
  });

  it("is false for an early bare return (undefined)", () => {
    expect(__asyncFinished(undefined)).toBe(false);
  });

  it("is false for null", () => {
    expect(__asyncFinished(null)).toBe(false);
  });

  it("is false for a failure Result", () => {
    expect(__asyncFinished(failure("no"))).toBe(false);
  });

  it("is false for a plain object the user returned", () => {
    expect(__asyncFinished({ x: 1 })).toBe(false);
    expect(__asyncFinished({})).toBe(false);
  });

  it("is false for primitives", () => {
    expect(__asyncFinished(0)).toBe(false);
    expect(__asyncFinished("done")).toBe(false);
    expect(__asyncFinished(true)).toBe(false);
  });

  it("is false for an array", () => {
    expect(__asyncFinished([__asyncDone({})])).toBe(false);
  });
});
