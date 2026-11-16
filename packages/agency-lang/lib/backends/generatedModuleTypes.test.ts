import { describe, expect, it } from "vitest";
import * as path from "path";
import ts from "typescript";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

// A generated module starts with `// @ts-nocheck`, so a type it names and
// forgets to import is not an error in the module itself. The TypeScript
// program that imports the module does not get an error either: the node's
// result quietly becomes `any`, and every use of it type-checks.
//
// This test type-checks a small caller against a generated module and asks
// the checker what type the caller got back from a node.

const packageRoot = path.resolve(__dirname, "../..");
// Neither file is written to disk. They are named inside a directory that
// exists so that module resolution looks for them.
const modulePath = path.join(__dirname, "agent.ts");
const callerPath = path.join(__dirname, "caller.ts");

const AGENCY_SOURCE = `
node main(name: string) {
  return name
}
`;

const CALLER_SOURCE = `
import { main } from "./agent.js";

const result = await main("Ada");
const traceId: string = result.traceId;
`;

type CallerCheck = {
  errors: string[];
  /** True when the caller's `result` has no real type. */
  resultIsAny: boolean;
};

function generateModule(): string {
  const parsed = parseAgency(AGENCY_SOURCE, {}, false);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  return generateTypeScript(parsed.result, undefined, undefined, "agent.agency");
}

/** Type-check the caller against `moduleSource`. `agency-lang/runtime`
 *  resolves to the runtime's source, so the test needs no build. */
function checkCaller(moduleSource: string): CallerCheck {
  const virtualFiles: Record<string, string> = {
    [modulePath]: moduleSource,
    [callerPath]: CALLER_SOURCE,
  };
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    paths: {
      "agency-lang/runtime": [path.join(packageRoot, "lib/runtime/index.ts")],
      "@/*": [path.join(packageRoot, "lib/*")],
    },
  };
  const host = ts.createCompilerHost(options);
  const readRealFile = host.readFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => virtualFiles[fileName] ?? readRealFile(fileName);
  host.fileExists = (fileName) => fileName in virtualFiles || realFileExists(fileName);

  const program = ts.createProgram([callerPath], options, host);
  const caller = program.getSourceFile(callerPath);
  if (!caller) {
    throw new Error("The caller is not in the program");
  }
  const errors = ts
    .getPreEmitDiagnostics(program, caller)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

  const checker = program.getTypeChecker();
  const resultDeclaration = caller.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => declaration.name.getText() === "result");
  if (!resultDeclaration) {
    throw new Error("The caller does not declare `result`");
  }
  const resultType = checker.getTypeAtLocation(resultDeclaration.name);
  return { errors, resultIsAny: (resultType.flags & ts.TypeFlags.Any) !== 0 };
}

describe("a TypeScript caller of a generated module", () => {
  const generated = generateModule();

  it("gets a typed result from a node", () => {
    expect(checkCaller(generated)).toEqual({ errors: [], resultIsAny: false });
  });

  it("gets `any` when the module does not import RunNodeResult", () => {
    // Shows that the check above can fail.
    const withoutImport = generated.replace(", RunNodeResult }", " }");
    expect(withoutImport).not.toBe(generated);
    expect(checkCaller(withoutImport).resultIsAny).toBe(true);
  });
});
