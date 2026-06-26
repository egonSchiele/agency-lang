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
});
