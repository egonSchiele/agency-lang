import { describe, it, expect } from "vitest";
import { __UNINIT_STATIC, __readStatic } from "./staticInit.js";

describe("__readStatic", () => {
  it("returns plain values unchanged", () => {
    expect(__readStatic(5, "x", "foo.agency")).toBe(5);
    expect(__readStatic("hello", "x", "foo.agency")).toBe("hello");
    expect(__readStatic(null, "x", "foo.agency")).toBe(null);
    expect(__readStatic(undefined, "x", "foo.agency")).toBe(undefined);
    expect(__readStatic({ a: 1 }, "x", "foo.agency")).toEqual({ a: 1 });
    expect(__readStatic([1, 2, 3], "x", "foo.agency")).toEqual([1, 2, 3]);
    expect(__readStatic(0, "x", "foo.agency")).toBe(0);
    expect(__readStatic(false, "x", "foo.agency")).toBe(false);
    expect(__readStatic(NaN, "x", "foo.agency")).toBeNaN();
  });

  it("throws on sentinel", () => {
    expect(() =>
      __readStatic(__UNINIT_STATIC as any, "barStatic", "bar.agency"),
    ).toThrow(/Tried to read static `barStatic` from bar\.agency/);
  });

  it("error message includes diagnostic context", () => {
    try {
      __readStatic(__UNINIT_STATIC as any, "x", "y.agency");
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.message).toMatch(/before its initializer ran/i);
      expect(e.message).toMatch(/circular import|indirect/i);
    }
  });

  it("works transparently in binary operations and templates", () => {
    const x = __readStatic("hello", "x", "f.agency");
    expect(x + "!").toBe("hello!");
    expect(`${x} world`).toBe("hello world");

    const n = __readStatic(5, "n", "f.agency");
    expect(n + 1).toBe(6);
    expect(n * 2).toBe(10);

    const arr = __readStatic([1, 2, 3], "arr", "f.agency");
    expect(arr.length).toBe(3);
    expect([...arr, 4]).toEqual([1, 2, 3, 4]);

    const obj = __readStatic({ port: 8080 }, "obj", "f.agency");
    expect(obj.port * 2).toBe(16160);
  });

  it("does not confuse sentinel with other symbols or falsy values", () => {
    // sentinel is a unique Symbol — must not collide
    expect(__readStatic(Symbol("uninit"), "x", "f.agency")).not.toBe(
      __UNINIT_STATIC,
    );
    // Other falsy / quirky values pass through normally
    expect(() => __readStatic(0 as any, "x", "f.agency")).not.toThrow();
    expect(() => __readStatic("" as any, "x", "f.agency")).not.toThrow();
    expect(() => __readStatic(null as any, "x", "f.agency")).not.toThrow();
  });
});
