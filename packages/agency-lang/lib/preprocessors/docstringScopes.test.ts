import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { walkNodesArray } from "@/utils/node.js";
import type { AgencyProgram } from "../types.js";

/** Parse, preprocess, and hand back every assignment to `name`, in source
 *  order, with the scope the preprocessor stamped on it. */
function assignmentScopes(source: string, name: string): (string | undefined)[] {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
  const program = parsed.result as AgencyProgram;
  new TypescriptPreprocessor(program).preprocess();
  return walkNodesArray(program.nodes)
    .filter(({ node }) => node.type === "assignment" && node.variableName === name)
    .map(({ node }) => (node.type === "assignment" ? node.scope : undefined));
}

describe("docstring scopes", () => {
  // A docstring is walked under the ENCLOSING scopes, because it is built
  // when the module loads and so sees top-level names only. That left a
  // declaration inside one of its blocks looking like a top-level
  // declaration, and the whole module could then read it by name.
  it("makes a declaration inside a docstring block local to that block", () => {
    const source = [
      "let total = 1",
      "",
      "def described(): string {",
      '  """Doubled: ${map([1, 2]) as p { let total = p * 10',
      '    return total }}"""',
      '  return "ok"',
      "}",
    ].join("\n");

    // The top-level `let` is the global; the one in the docstring is not.
    expect(assignmentScopes(source, "total")).toEqual(["global", "block"]);
  });

  it("resolves a top-level name used in a docstring as a global", () => {
    const source = [
      "let limit = 5",
      "",
      "def described(): string {",
      '  """Up to ${limit}"""',
      '  return "ok"',
      "}",
    ].join("\n");

    expect(assignmentScopes(source, "limit")).toEqual(["global"]);
  });
});
