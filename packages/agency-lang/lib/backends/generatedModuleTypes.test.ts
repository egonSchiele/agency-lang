import { describe, expect, it } from "vitest";
import * as path from "path";
import ts from "typescript";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

// The file `agency compile --ts` writes starts with `// @ts-nocheck`, so a
// type it names and forgets to import is not an error in the file itself.
// The TypeScript program that imports it does not get an error either: the
// value quietly becomes `any`, and every use of it type-checks.
//
// Two checks here:
//
// 1. Type-check a small caller against the file and ask the checker what
//    type the caller got back from a node.
// 2. Type-check the module without the `@ts-nocheck` line and collect every
//    name it uses and does not declare or import.

const packageRoot = path.resolve(__dirname, "../..");
// Neither file is written to disk. They are named inside a directory that
// exists so that module resolution looks for them.
const modulePath = path.join(__dirname, "agent.ts");
const callerPath = path.join(__dirname, "caller.ts");

const AGENCY_SOURCE = `
export def greet(name: string): string {
  return name
}

node main(name: string) {
  return greet(name)
}
`;

const CALLER_SOURCE = `
import { main } from "./agent.js";

const result = await main("Ada");
const traceId: string = result.traceId;
`;

const CANNOT_FIND_NAME = 2304;

type CallerCheck = {
  errors: string[];
  /** True when the caller's `result` has no real type. */
  resultIsAny: boolean;
};

/** The module text `generateTypeScript` returns, which has no
 *  `@ts-nocheck` line. */
function generateModule(): string {
  const parsed = parseAgency(AGENCY_SOURCE, {}, false);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  return generateTypeScript(parsed.result, undefined, undefined, "agent.agency");
}

/** The file a user gets. `lib/compiler/buildSession.ts` adds this line when
 *  it writes a `--ts` file. */
function asWrittenToDisk(moduleSource: string): string {
  return "// @ts-nocheck\n" + moduleSource;
}

function messagesOf(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
}

/** A program holding the caller and `moduleSource`. `agency-lang/runtime`
 *  resolves to the runtime's source, so the test needs no build. */
function programWith(moduleSource: string): ts.Program {
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
  return ts.createProgram([callerPath], options, host);
}

function sourceFileOf(program: ts.Program, fileName: string): ts.SourceFile {
  const file = program.getSourceFile(fileName);
  if (!file) {
    throw new Error(`${fileName} is not in the program`);
  }
  return file;
}

function checkCaller(moduleSource: string): CallerCheck {
  const program = programWith(moduleSource);
  const caller = sourceFileOf(program, callerPath);
  const resultDeclaration = caller.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "result");
  if (!resultDeclaration) {
    throw new Error("The caller does not declare `result`");
  }
  const resultType = program.getTypeChecker().getTypeAtLocation(resultDeclaration.name);
  return {
    errors: messagesOf(ts.getPreEmitDiagnostics(program, caller)),
    resultIsAny: (resultType.flags & ts.TypeFlags.Any) !== 0,
  };
}

/** Every "Cannot find name" error in the module. Empty for a module that
 *  has a `@ts-nocheck` line, so pass the text without one. */
function missingNames(moduleSource: string): string[] {
  const program = programWith(moduleSource);
  const diagnostics = program
    .getSemanticDiagnostics(sourceFileOf(program, modulePath))
    .filter((diagnostic) => diagnostic.code === CANNOT_FIND_NAME);
  return messagesOf(diagnostics);
}

describe("a generated module", () => {
  const generated = generateModule();
  const withoutImport = generated.replace(", RunNodeResult }", " }");

  it("has an import to remove, for the two cases that remove it", () => {
    expect(withoutImport).not.toBe(generated);
  });

  it("gives a TypeScript caller a typed result from a node", () => {
    expect(checkCaller(asWrittenToDisk(generated))).toEqual({ errors: [], resultIsAny: false });
  });

  it("gives the caller `any` when it does not import RunNodeResult", () => {
    // Shows that the check above can fail.
    expect(checkCaller(asWrittenToDisk(withoutImport)).resultIsAny).toBe(true);
  });

  it("declares or imports every name it uses", () => {
    expect(missingNames(generated)).toEqual([]);
  });

  it("reports a name it does not import", () => {
    // Shows that the check above can fail.
    expect(missingNames(withoutImport)).toContain("Cannot find name 'RunNodeResult'.");
  });
});
