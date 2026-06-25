import { describe, it, expect, vi, afterEach } from "vitest";
import {
  interrupt,
  hasInterrupts,
  reportUnhandledInterrupts,
} from "./interrupts.js";

describe("hasInterrupts", () => {
  it("returns true for an array of interrupts", () => {
    const interrupts = [
      interrupt({ effect: "unknown", message: "test1", data: {}, origin: "", runId: "run1" }),
      interrupt({ effect: "unknown", message: "test2", data: {}, origin: "", runId: "run1" }),
    ];
    expect(hasInterrupts(interrupts)).toBe(true);
  });

  it("returns true for a single-element array", () => {
    expect(hasInterrupts([interrupt({ effect: "unknown", message: "test", data: {}, origin: "", runId: "run1" })])).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(hasInterrupts(null)).toBe(false);
    expect(hasInterrupts(undefined)).toBe(false);
  });

  it("returns false for a non-array", () => {
    expect(hasInterrupts("hello")).toBe(false);
    expect(hasInterrupts({ type: "interrupt" })).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(hasInterrupts([])).toBe(false);
  });

  it("returns false for an array of non-interrupts", () => {
    expect(hasInterrupts([1, 2, 3])).toBe(false);
  });
});

describe("reportUnhandledInterrupts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when the result has no interrupts", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    reportUnhandledInterrupts({ messages: {} as any, data: "the answer" });

    expect(err).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("prints a helpful message and exits non-zero for an unhandled interrupt", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    reportUnhandledInterrupts({
      messages: {} as any,
      data: [
        interrupt({
          effect: "std::edit",
          message: "edit the file",
          data: { path: "a.ts" },
          origin: "./foo.agency",
          runId: "run1",
        }),
      ],
    });

    expect(exit).toHaveBeenCalledWith(1);
    const printed = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain('Interrupt "std::edit" was not handled');
    expect(printed).toContain("edit the file");
    expect(printed).toContain('"path":"a.ts"');
    expect(printed).toContain("wrapping them in a handler");
    expect(printed).toContain("https://agency-lang.com/guide/handlers.html");
  });

  it("reports every interrupt when several are unhandled", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    reportUnhandledInterrupts({
      messages: {} as any,
      data: [
        interrupt({ effect: "std::read", message: "read", data: {}, origin: "", runId: "r" }),
        interrupt({ effect: "std::edit", message: "edit", data: {}, origin: "", runId: "r" }),
      ],
    });

    const printed = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain('Interrupt "std::read" was not handled');
    expect(printed).toContain('Interrupt "std::edit" was not handled');
  });
});
