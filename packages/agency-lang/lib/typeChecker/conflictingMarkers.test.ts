import { describe, expect, it } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

const conflictError = (source: string) =>
  typeCheckSource(source).errors.find(
    (e) => (e as { code?: string }).code === "AG7006",
  );

describe("conflicting destructive/idempotent markers", () => {
  it("errors when a def is both destructive and idempotent", () => {
    const err = conflictError("destructive idempotent def f() { return 1 }");
    expect(err).toBeDefined();
    expect(err?.message).toContain("cannot be both destructive and idempotent");
  });

  it("errors regardless of marker order", () => {
    expect(
      conflictError("idempotent destructive def f() { return 1 }"),
    ).toBeDefined();
  });

  it("does not error on a plain destructive def", () => {
    expect(
      conflictError("destructive def rm(p: string) { return 1 }"),
    ).toBeUndefined();
  });

  it("does not error on a plain idempotent def", () => {
    expect(
      conflictError("idempotent def f(): number { return 1 }"),
    ).toBeUndefined();
  });

  it("does not error on an unmarked def", () => {
    expect(conflictError("def f(): number { return 1 }")).toBeUndefined();
  });
});
