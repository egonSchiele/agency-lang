import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import type { AgencyProgram } from "../types.js";

/** The hoist pass lowers every `?` before codegen. If one ever reaches the
 *  builder, it must fail loudly as a toolchain bug, never emit a `?`. */
describe("an unlowered ? is a codegen tripwire", () => {
  it("the builder throws on an unwrap chain element", () => {
    const program = {
      type: "agencyProgram",
      nodes: [
        {
          type: "graphNode",
          nodeName: "main",
          parameters: [],
          body: [
            {
              type: "assignment",
              declKind: "const",
              variableName: "x",
              value: {
                type: "valueAccess",
                base: { type: "functionCall", functionName: "foo", arguments: [] },
                chain: [{ kind: "unwrap" }],
              },
            },
          ],
        },
      ],
    } as unknown as AgencyProgram;
    const builder = new TypeScriptBuilder(
      undefined,
      buildCompilationUnit(program),
      "unwrap.agency",
    );
    expect(() => builder.build(program)).toThrow(/unwrap.*toolchain bug/);
  });

  it("the normal pipeline lowers ? so the generated code has no unwrap left", () => {
    const parsed = parseAgency(
      `def parseName(text: string): Result<string> {\n  return success(text)\n}\n\nnode main(): Result<string> {\n  const name = parseName("x")?\n  return success(name)\n}\n`,
      {},
      false,
    );
    if (!parsed.success) throw new Error(parsed.message);
    const out = generateTypeScript(parsed.result, undefined, undefined, "unwrap.agency");
    expect(out).toContain("isFailure(");
    expect(out).toContain("runner.ifElse(");
    expect(out).toContain("__hoist_0.value");
  });
});
