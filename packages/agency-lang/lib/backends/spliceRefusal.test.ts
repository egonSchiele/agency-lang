import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

/**
 * The builder's splice tripwire, exercised by deliberately skipping
 * expansion — the one thing no real compile path does.
 *
 * Every path that compiles or checks a file runs `expandSplices` first, so
 * nothing else in the suite can reach this throw. That is exactly why it
 * needs its own test: delete the tripwire and only these tests notice, and
 * the next compile path added without an expansion call would surface as a
 * bare "Unhandled Agency node type: splice" instead.
 */
function buildWithoutExpansion(source: string): string {
  const parseResult = parseAgency(source, {}, false, false);
  if (!parseResult.success) throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder({} as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

const IMPORT = `import { gen } from "./gen.agency"\n\n`;

// One per splice position, because the pre-pass finds splices by walking the
// whole tree: an expression-position splice is nested several levels down and
// is the one a shallower walk would miss.
const POSITIONS: Record<string, string> = {
  decl: `${IMPORT}$( gen() )\n\nnode main() { print(1) }\n`,
  statement: `${IMPORT}node main() { $( gen() ) }\n`,
  expr: `${IMPORT}node main() { print($( gen() )) }\n`,
};

describe("the builder refuses an unexpanded splice before generating anything", () => {
  for (const [position, source] of Object.entries(POSITIONS)) {
    describe(`a splice in ${position} position`, () => {
      it("names the pass that should have removed it", () => {
        expect(() => buildWithoutExpansion(source)).toThrow(
          /expandSplices should have replaced it/,
        );
      });

      it("names the generator, so the message says which splice", () => {
        expect(() => buildWithoutExpansion(source)).toThrow(/generator: gen/);
      });

      it("does not report a missing language feature", () => {
        // The crash this replaces. If this assertion ever fails, the
        // tripwire has stopped running and the useless message is back.
        expect(() => buildWithoutExpansion(source)).not.toThrow(/Unhandled Agency node type/);
      });
    });
  }

  it("still builds a program with no splices in it", () => {
    const output = buildWithoutExpansion("const x = 1\n\nnode main() { print(x) }\n");
    expect(output).toContain("main");
  });
});
