import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";

function gen(src: string): string {
  const parsed = parseAgency(src, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return "";
  return new AgencyGenerator().generate(parsed.result).output;
}

describe("AgencyGenerator — finalize binder", () => {
  it("prints the canonical binder form without parens", () => {
    const out = gen(
      'def f(): string {\n  return "x"\n  finalize() as d {\n    return "y"\n  }\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("finalize as d {");
    expect(out).not.toContain("finalize()");
  });

  it("prints the binder-less form unchanged", () => {
    const out = gen(
      'def f(): string {\n  return "x"\n  finalize {\n    return "y"\n  }\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("finalize {");
  });

  it("canonicalizes a stray `as` with no binder away (fmt IS the migration, like guard)", () => {
    const out = gen(
      'def f(): string {\n  return "x"\n  finalize as {\n    return "y"\n  }\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("finalize {");
    expect(out).not.toContain("finalize as {");
  });

  it("round-trips: printed output parses back and prints identically", () => {
    const src =
      'def f(): string {\n  return "x"\n  finalize as draft {\n    if (draft != null) {\n      return draft\n    }\n    return "y"\n  }\n}\nnode main() { return f() }\n';
    const once = gen(src);
    const reparsed = parseAgency(once, {}, false);
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;
    const twice = new AgencyGenerator().generate(reparsed.result).output;
    expect(twice).toBe(once);
  });
});
