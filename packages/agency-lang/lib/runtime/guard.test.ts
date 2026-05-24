import { describe, expect, it } from "vitest";
import {
  GuardEntry,
  GuardExceededError,
  isGuardExceededError,
} from "./guard.js";

describe("GuardEntry", () => {
  it("has the expected shape", () => {
    const entry: GuardEntry = { costLimit: 2.0, costAtPush: 0.0 };
    expect(entry.costLimit).toBe(2.0);
    expect(entry.costAtPush).toBe(0.0);
  });
});

describe("GuardExceededError", () => {
  it("is an Error subclass with name, type, limit, spent fields", () => {
    const err = new GuardExceededError("cost", 2.0, 2.5);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GuardExceededError);
    expect(err.name).toBe("GuardExceededError");
    expect(err.type).toBe("cost");
    expect(err.limit).toBe(2.0);
    expect(err.spent).toBe(2.5);
    expect(err.message).toContain("cost");
    expect(err.message).toContain("2");
  });
});

describe("isGuardExceededError", () => {
  it("returns true for a GuardExceededError instance", () => {
    expect(isGuardExceededError(new GuardExceededError("cost", 1, 2))).toBe(
      true,
    );
  });

  it("returns false for a plain Error", () => {
    expect(isGuardExceededError(new Error("oops"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isGuardExceededError(null)).toBe(false);
    expect(isGuardExceededError(undefined)).toBe(false);
    expect(isGuardExceededError("error")).toBe(false);
    expect(isGuardExceededError({})).toBe(false);
  });
});
