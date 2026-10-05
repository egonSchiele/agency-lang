import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

// Generated code takes the run as `__run` and hands it to the runtime. When
// it also hands the runtime a body to call back, that body must declare a
// `__run` parameter of its own:
//
//   await runner.step(1, __run, async (runner, __run) => { ... });
//
// The runtime calls the body with a child run. A body that left the
// parameter out would still compile, and every `__run` inside it would be the
// outer function's run. Inside a fork block that reads the parent's globals
// and not the branch's, with no error.
//
// This test reads every generated fixture and checks the rule. A new
// language feature adds a fixture, so a body that forgets `__run` fails here.
// See docs/dev/compiler/codegen-run-parameter.md.

const RUN = "__run";
const fixtureDir = path.resolve(__dirname, "../../tests/typescriptGenerator");

type FunctionLiteral = ts.ArrowFunction | ts.FunctionExpression;

function isFunctionLiteral(node: ts.Node): node is FunctionLiteral {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function declaresRun(fn: FunctionLiteral): boolean {
  return fn.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === RUN,
  );
}

/** The `line: text` of every body that is handed to a call alongside
 *  `__run` and does not declare `__run` itself. */
function bodiesMissingRun(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const lines = source.split("\n");
  const missing: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const passesRun = node.arguments.some(
        (argument) => ts.isIdentifier(argument) && argument.text === RUN,
      );
      if (passesRun) {
        node.arguments
          .filter(isFunctionLiteral)
          .filter((body) => !declaresRun(body))
          .forEach((body) => {
            const { line } = file.getLineAndCharacterOfPosition(body.getStart());
            missing.push(`${line + 1}: ${lines[line].trim()}`);
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return missing;
}

describe("the check itself", () => {
  it("accepts a body that declares __run", () => {
    const source = "await runner.step(1, __run, async (runner, __run) => { work(__run); });";
    expect(bodiesMissingRun("good.mjs", source)).toEqual([]);
  });

  it("reports a body that leaves __run out", () => {
    const source = "await runner.step(1, __run, async (runner) => { work(__run); });";
    expect(bodiesMissingRun("bad.mjs", source)).toEqual([`1: ${source}`]);
  });

  it("reports a body nested inside a body that does declare it", () => {
    const source = [
      "await runner.step(1, __run, async (runner, __run) => {",
      "  await runner.fork(2, __run, items, async (item) => { work(__run); });",
      "});",
    ].join("\n");
    expect(bodiesMissingRun("nested.mjs", source)).toEqual([
      "2: await runner.fork(2, __run, items, async (item) => { work(__run); });",
    ]);
  });
});

describe("generated fixtures", () => {
  const fixtures = fs.readdirSync(fixtureDir).filter((name) => name.endsWith(".mjs"));

  it("finds the fixtures", () => {
    // If the fixtures moved, the test below would pass over an empty list.
    expect(fixtures.length).toBeGreaterThan(50);
  });

  it("every body handed to the runtime alongside __run declares its own __run", () => {
    const problems = fixtures.flatMap((name) => {
      const source = fs.readFileSync(path.join(fixtureDir, name), "utf-8");
      return bodiesMissingRun(name, source).map((problem) => `${name}:${problem}`);
    });
    expect(problems).toEqual([]);
  });
});
