import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// A method name is whatever the program wrote after the dot. The checker
// looked it up in a plain object, so a name that every object inherits
// (`constructor`, `toString`) found a JavaScript function where it expected
// a signature, and the checker threw.
describe("a method named like a member of Object.prototype", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "does not crash the checker: .%s(...)",
    (method) => {
      const source = `def f(): number {\n  return 1\n}\nnode main() {\n  const k = 1\n  print(k.${method}("5"))\n  print(f.${method}("5"))\n}\n`;
      expect(() => typecheckSource(source)).not.toThrow();
    },
  );

  it("still checks a real function-value method", () => {
    const source = `def f(): number {\n  return 1\n}\nnode main() {\n  const g = f.describe(1, 2)\n  print(g)\n}\n`;
    expect(typecheckSource(source).length).toBeGreaterThan(0);
  });
});
