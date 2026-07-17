import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";

function gen(src: string): string {
  const parsed = parseAgency(src, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return "";
  return new AgencyGenerator().generate(parsed.result).output;
}

describe("AgencyGenerator — guardBlock", () => {
  it("prints canonically and drops the legacy as (fmt IS the migration)", () => {
    const out = gen(
      'node main() {\n  const r = guard(cost: $1, label: "x") as {\n    return 1\n  }\n  return r\n}\n',
    );
    expect(out).toContain('guard(cost: $1, label: "x") {');
    expect(out).not.toContain(" as {");
  });

  it("prints head args in source order and keeps empty parens", () => {
    const reordered = gen(
      "node main() {\n  const r = guard(time: 5m, cost: $1) {\n    return 1\n  }\n  return r\n}\n",
    );
    expect(reordered).toContain("guard(time: 5m, cost: $1) {");

    const empty = gen(
      "node main() {\n  const r = guard() {\n    return 1\n  }\n  return r\n}\n",
    );
    expect(empty).toContain("guard() {");
  });

  it("round-trips: printed output parses back to a deep-equal node", () => {
    const src =
      'node main() {\n  const r = guard(cost: $1, time: 30s, label: "g") {\n    const a = 1\n    return a\n  }\n  return r\n}\n';
    const once = gen(src);
    const reparsed = parseAgency(once, {}, false);
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;
    const twice = new AgencyGenerator().generate(reparsed.result).output;
    expect(twice).toBe(once);
  });
});
