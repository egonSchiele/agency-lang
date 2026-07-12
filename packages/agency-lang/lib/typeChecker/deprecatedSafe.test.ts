import { describe, expect, it } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

const warnsDeprecated = (source: string): boolean =>
  typeCheckSource(source).warnings.some((w) =>
    w.message.includes("'safe' is deprecated"),
  );

describe("safe deprecation warning", () => {
  it("warns on safe def", () => {
    expect(warnsDeprecated("safe def add(a: number): number { return a }")).toBe(
      true,
    );
  });

  it("warns on import { safe x }", () => {
    expect(
      warnsDeprecated(
        'import { safe x } from "./t.js"\nnode main() { return 1 }',
      ),
    ).toBe(true);
  });

  it("does not warn on destructive def", () => {
    expect(warnsDeprecated("destructive def rm(p: string) { return 1 }")).toBe(
      false,
    );
  });

  it("does not warn on idempotent def", () => {
    expect(warnsDeprecated("idempotent def f(): number { return 1 }")).toBe(
      false,
    );
  });
});
