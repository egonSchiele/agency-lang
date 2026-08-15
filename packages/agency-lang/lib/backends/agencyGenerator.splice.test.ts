import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { generateAgency } from "./agencyGenerator.js";
import type { AgencyProgram } from "../types.js";

function parseTemplate(source: string): AgencyProgram {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "parse failed");
  }
  return result.result;
}

function print(source: string): string {
  return generateAgency(parseTemplate(source));
}

/** Print, re-parse, and compare trees. Substring presence is not fidelity;
 *  what the expansion pass needs is that a printed splice re-reads as the
 *  same splice. */
function roundTripsStructurally(source: string): boolean {
  const once = print(source);
  return JSON.stringify(parseTemplate(once)) === JSON.stringify(parseTemplate(source));
}

describe("formatting splices", () => {
  it("prints a declaration splice", () => {
    expect(print(`$( makeGetters(["a", "b"]) )\n`)).toContain(`$( makeGetters(["a", "b"]) )`);
  });

  it("prints an expression splice", () => {
    expect(print(`node main() {\n  const x = $( build(3) )\n  return x\n}\n`)).toContain(
      `$( build(3) )`,
    );
  });

  it("round-trips a declaration splice structurally", () => {
    expect(
      roundTripsStructurally(`$( makeGetters(["a"]) )\n\nnode main() {\n  return 1\n}\n`),
    ).toBe(true);
  });

  it("round-trips an expression splice structurally", () => {
    expect(
      roundTripsStructurally(`node main() {\n  const x = $( build(3) )\n  return x\n}\n`),
    ).toBe(true);
  });

  it("round-trips a splice whose argument is a code literal", () => {
    // Where a printer is most likely to mangle something, and what the
    // loopedBoilerplate fixture depends on.
    expect(roundTripsStructurally(`$( wrap([| print("step") |]) )\n`)).toBe(true);
  });

  it("is idempotent", () => {
    const once = print(`$( makeGetters(["a"]) )\n`);
    expect(print(once)).toBe(once);
  });
});
