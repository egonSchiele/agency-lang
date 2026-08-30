import { describe, it, expect } from "vitest";
import { formatSource } from "@/formatter.js";

// The on-clause alias (#926) leaves no distinct AST node — it parses straight
// into the canonical inline handler — so `agency fmt` normalizes it away with no
// formatter change. This test guards that: the alias in, the canonical handler
// out.
describe("agency fmt normalizes the on-clause handler alias", () => {
  it("rewrites `with { on ... }` to the canonical `with (intr) { match ... }`", () => {
    // Wrapped in a node: a bare top-level statement is the area top-level
    // statements (#713) still restricts, and this test must not fail for a
    // reason unrelated to the alias.
    const alias =
      "node main() {\n" +
      "  handle {\n    foo()\n  } with {\n" +
      "    on std::read(data) { approve() }\n" +
      "    on _ { reject() }\n  }\n" +
      "}\n";
    const formatted = formatSource(alias);
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("with (intr)");
    expect(formatted).toContain("match(intr.effect)");
    expect(formatted).toContain('"std::read" =>');
    // The alias spelling is gone.
    expect(formatted).not.toContain("on std::read");
  });
});
