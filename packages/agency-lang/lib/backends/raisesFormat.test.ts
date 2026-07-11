import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";

function fmt(input: string): string {
  const parsed = parseAgency(input, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return "";
  return new AgencyGenerator().generate(parsed.result).output.trim();
}

describe("formatter: effect sets, raises clauses, raise statement", () => {
  const cases = [
    {
      description: "effectSet declaration",
      input: "effectSet FsKinds = <std::read, std::write>",
      expectedOutput: "effectSet FsKinds = <std::read, std::write>",
    },
    {
      description: "exported effectSet declaration",
      input: "export effectSet NetKinds = <std::http>",
      expectedOutput: "export effectSet NetKinds = <std::http>",
    },
    {
      description: "effectSet = <*> round-trips as <*> (not `any`)",
      input: "effectSet Anything = <*>",
      expectedOutput: "effectSet Anything = <*>",
    },
    {
      description: "effectSet = <> round-trips",
      input: "effectSet None = <>",
      expectedOutput: "effectSet None = <>",
    },
    {
      description: "raises clause with inline set on a def + raise statement",
      input: 'def f(): string raises <std::read> { raise std::read("m", {}) }',
      expectedOutput: 'def f(): string raises <std::read> {\n  raise std::read("m", {})\n}',
    },
    {
      description: "raises clause referencing a named set on a node",
      input: 'node main() raises FsKinds { print("hi") }',
      expectedOutput: 'node main() raises FsKinds {\n  print("hi")\n}',
    },
    {
      description: "raises <*> round-trips verbatim",
      input: "def a(): number raises <*> { return 1 }",
      expectedOutput: "def a(): number raises <*> {\n  return 1\n}",
    },
    {
      description: "raises <> round-trips verbatim",
      input: "def s(): number raises <> { return 1 }",
      expectedOutput: "def s(): number raises <> {\n  return 1\n}",
    },
    {
      description: "raises on a function type is preserved",
      input: "type Callback = (string) -> string raises <std::read>",
      expectedOutput: "type Callback = (string) -> string raises <std::read>",
    },
    {
      description: "raises <> on a function type is preserved",
      input: "type Pure = (string) -> string raises <>",
      expectedOutput: "type Pure = (string) -> string raises <>",
    },
    {
      description: "raises <*> on a function type is preserved",
      input: "type AnyFn = (string) -> string raises <*>",
      expectedOutput: "type AnyFn = (string) -> string raises <*>",
    },
    {
      description: "a function type with no clause stays clause-free",
      input: "type Plain = (string) -> string",
      expectedOutput: "type Plain = (string) -> string",
    },
  ];

  cases.forEach(({ description, input, expectedOutput }) => {
    it(description, () => {
      expect(fmt(input)).toBe(expectedOutput);
    });
  });

  it("format is a fixed point for a function-type raises clause", () => {
    const once = fmt("type Callback = (string) -> string raises <std::read>");
    expect(fmt(once)).toBe(once);
  });
});
