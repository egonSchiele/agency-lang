import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";

function fmt(input: string): string {
  const parsed = parseAgency(input, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return "";
  return new AgencyGenerator().generate(parsed.result).output.trim();
}

describe("formatter: effect declarations", () => {
  it("formats a single-field declaration", () => {
    // The shared object renderer breaks every non-empty object across lines
    // for stable round-tripping; locking that exact shape here.
    expect(fmt("effect std::read { dir: string }")).toBe(
      "effect std::read {\n  dir: string\n}",
    );
  });

  it("formats an empty payload", () => {
    expect(fmt("effect std::ping {}")).toBe("effect std::ping {}");
  });

  it("formats a multi-field declaration across lines", () => {
    // The realistic shape for users — multiple fields. A regression in the
    // shared object renderer (e.g., dropping the indent step) would break
    // this without the single-field test catching it.
    expect(
      fmt("effect std::write { dir: string, content: string }"),
    ).toBe("effect std::write {\n  dir: string;\n  content: string\n}");
  });

  it("round-trips: parse → format → parse → format is stable", () => {
    // Stronger than a one-shot snapshot: two passes must produce the same
    // output. Catches formatter output that isn't itself parseable.
    const once = fmt("effect std::read { dir: string }");
    expect(fmt(once)).toBe(once);
  });
});
