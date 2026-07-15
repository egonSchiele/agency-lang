import { describe, test, expect, vi, afterEach } from "vitest";
import {
  formatBudgetExceeded,
  reportBudgetExceededAndExit,
} from "@/runtime/budgetExit.js";
import { GuardExceededError } from "@/runtime/guard.js";
import { AgencyCancelledError, makeAbortCause } from "@/runtime/errors.js";
import { EXIT_CODE_BUDGET_EXCEEDED } from "@/constants.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatBudgetExceeded", () => {
  test("cost message", () => {
    expect(
      formatBudgetExceeded({ dimension: "cost", limit: 0.5, spent: 0.63 }),
    ).toBe("Exceeded cost limit of $0.5 (used $0.63)");
  });
  test("time message renders whole ms", () => {
    expect(
      formatBudgetExceeded({ dimension: "time", limit: 5000, spent: 5002.4 }),
    ).toBe("Exceeded time limit of 5000ms (ran 5002ms)");
  });
});

describe("reportBudgetExceededAndExit", () => {
  test("exits 3 for a GuardExceededError (shouldSkip delivery)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    reportBudgetExceededAndExit(new GuardExceededError("time", 100, 150, "g"));
    expect(errSpy).toHaveBeenCalledWith(
      "Exceeded time limit of 100ms (ran 150ms)",
    );
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE_BUDGET_EXCEEDED);
  });
  test("exits 3 for a cancelled leaf op carrying a guardTrip cause", () => {
    // A root time trip usually lands THIS way: the timer aborts an
    // in-flight sleep/fetch, whose leafCancel throws AgencyCancelledError
    // with the guardTrip cause attached.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const e = new AgencyCancelledError(
      "sleep cancelled",
      makeAbortCause({
        kind: "guardTrip",
        dimension: "time",
        limit: 100,
        spent: 140,
        guardId: "g",
      }),
    );
    reportBudgetExceededAndExit(e);
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE_BUDGET_EXCEEDED);
  });
  test("returns without exiting for a non-budget error", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    reportBudgetExceededAndExit(new Error("plain crash"));
    expect(exitSpy).not.toHaveBeenCalled();
  });
  test("returns without exiting for a plain user cancel", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    reportBudgetExceededAndExit(new AgencyCancelledError("esc"));
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
