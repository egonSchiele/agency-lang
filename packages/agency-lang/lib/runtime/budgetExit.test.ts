import { describe, test, expect, vi, afterEach } from "vitest";
import {
  formatBudgetExceeded,
  reportBudgetExceededAndExit,
} from "@/runtime/budgetExit.js";
import { GuardExceededError } from "@/runtime/guard.js";
import { EXIT_CODE_BUDGET_EXCEEDED } from "@/constants.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatBudgetExceeded", () => {
  test("cost message", () => {
    const e = new GuardExceededError("cost", 0.5, 0.63, "g1");
    expect(formatBudgetExceeded(e)).toBe(
      "Exceeded cost limit of $0.5 (used $0.63)",
    );
  });
  test("time message renders ms", () => {
    const e = new GuardExceededError("time", 5000, 5002, "g1");
    expect(formatBudgetExceeded(e)).toBe(
      "Exceeded time limit of 5000ms (ran 5002ms)",
    );
  });
});

describe("reportBudgetExceededAndExit", () => {
  test("exits 3 with the message for a guard trip", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    reportBudgetExceededAndExit(new GuardExceededError("time", 100, 150, "g"));
    expect(errSpy).toHaveBeenCalledWith("Exceeded time limit of 100ms (ran 150ms)");
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE_BUDGET_EXCEEDED);
  });
  test("returns without exiting for a non-budget error", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    reportBudgetExceededAndExit(new Error("plain crash"));
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
