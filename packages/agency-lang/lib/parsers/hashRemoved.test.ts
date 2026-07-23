import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

// `#` used to introduce an object property description (`x: number # desc`).
// That syntax was removed to free the sigil for template holes; property
// descriptions are written with @jsonSchema({ description: ... }) instead.
describe("# is no longer a property description", () => {
  it("rejects a # description in a record type", () => {
    const result = parseAgency(
      `type A = {\n  x: number # a description\n}\nnode main() {\n  return 1\n}\n`,
      {},
      false,
      false,
    );
    expect(result.success).toBe(false);
  });
});
