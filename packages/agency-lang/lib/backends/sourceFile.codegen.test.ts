import { describe, expect, it } from "vitest";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

const SOURCE = "export def shout(text: string): string {\n  return text\n}\n";
const SOURCE_FILE = "/proj/agent/shout.agency";

/** The generated code for SOURCE, compiled from SOURCE_FILE to `outputFile`. */
function generate(outputFile?: string): string {
  const parsed = parseAgency(SOURCE, {}, false);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  const info = buildCompilationUnit(parsed.result, undefined, SOURCE_FILE);
  return generateTypeScript(parsed.result, undefined, info, "agent/shout.agency", outputFile);
}

describe("the compiled module's source file", () => {
  it("is found beside the compiled file", () => {
    expect(generate("/proj/agent/shout.js")).toContain(
      'const __sourceFile = path.join(__dirname, "shout.agency");',
    );
  });

  it("is found from an output folder elsewhere, as with outDir", () => {
    expect(generate("/proj/dist/agent/shout.js")).toContain(
      'const __sourceFile = path.join(__dirname, "../../agent/shout.agency");',
    );
  });

  it("is null when the code is not written to a known output file", () => {
    expect(generate()).toContain("const __sourceFile = null;");
  });

  it("is given to every def's function value", () => {
    expect(generate("/proj/agent/shout.js")).toMatch(
      /__AgencyFunction\.create\(\{[^]*?sourceFile: __sourceFile/,
    );
  });
});
