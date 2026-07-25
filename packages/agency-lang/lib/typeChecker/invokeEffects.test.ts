import { describe, it, expect } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

describe("effects through .invoke()", () => {
  it("warns about an unhandled interrupt reached via .invoke()", () => {
    const report = typeCheckSource(
      `node main() { let y = read.invoke("a.txt") }`,
    );
    expect(report.warnings.map((warning) => warning.code)).toContain("AG3009");
  });

  it("agrees with the plain call form", () => {
    const plain = typeCheckSource(`node main() { let y = read("a.txt") }`);
    const invoked = typeCheckSource(
      `node main() { let y = read.invoke("a.txt") }`,
    );
    expect(invoked.warnings.map((warning) => warning.code)).toEqual(
      plain.warnings.map((warning) => warning.code),
    );
  });

  it("names the receiver in the message, not invoke", () => {
    const report = typeCheckSource(
      `node main() { let y = read.invoke("a.txt") }`,
    );
    const warning = report.warnings.find((entry) => entry.code === "AG3009");
    expect(warning?.message).toContain("'read'");
    expect(warning?.message).not.toContain("'invoke'");
  });
});
