import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { _readTestFileSandbox, _readNodeBindingTable, _bindTestFileCases } from "./agency.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agency-testfile-"));
}

const HARNESS =
  'import { fib } from "./fib.agency"\n\n' +
  "export node testFive(a: number, b: number = 1): number {\n  return fib(a) + b\n}\n" +
  "export node noArgs(): number {\n  return 1\n}\n";

describe("_readTestFileSandbox", () => {
  test("maps a valid file with parsed expected values", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "suite.test.json"),
      JSON.stringify({
        sourceFile: "harness.agency",
        defaultTimeoutMs: 5000,
        tests: [
          {
            nodeName: "testFive",
            input: "3, 4",
            expectedOutput: "9",
            evaluationCriteria: [{ type: "exact" }],
          },
        ],
      }),
    );
    const wire = _readTestFileSandbox(dir, "suite.test.json");
    expect(wire.sourceFile).toBe("harness.agency");
    expect(wire.defaultTimeoutMs).toBe(5000);
    expect(wire.rawCases[0].expected).toBe(9);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refused fields error by name; escaping json path refused before read", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "bad.test.json"),
      JSON.stringify({
        tests: [
          {
            nodeName: "n",
            input: "",
            expectedOutput: "1",
            evaluationCriteria: [{ type: "exact" }],
            llmMocks: [],
          },
        ],
      }),
    );
    expect(() => _readTestFileSandbox(dir, "bad.test.json")).toThrow(/llmMocks/);
    // The escape target EXISTS (an ENOENT would refuse for the wrong reason)
    // and holds valid content, so only the containment check can be what
    // stops the read.
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.test.json`);
    fs.writeFileSync(outside, JSON.stringify({ tests: [] }));
    expect(() => _readTestFileSandbox(dir, `../${path.basename(outside)}`)).toThrow(
      /Sandbox violation/,
    );
    fs.rmSync(outside, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("_readNodeBindingTable", () => {
  test("one read and one parse yields every node's parameters", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "harness.agency"), HARNESS);
    const table = _readNodeBindingTable(dir, "harness.agency");
    expect(table.testFive).toEqual([
      { name: "a", hasDefault: false, variadic: false },
      { name: "b", hasDefault: true, variadic: false },
    ]);
    expect(table.noArgs).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an escaping sourceFile is refused before any read", () => {
    const dir = makeDir();
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.agency`);
    fs.writeFileSync(outside, "export node x(): number {\n  return 1\n}\n");
    expect(() => _readNodeBindingTable(dir, `../${path.basename(outside)}`)).toThrow(
      /Sandbox violation/,
    );
    fs.rmSync(outside, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("_bindTestFileCases", () => {
  const table = {
    testFive: [
      { name: "a", hasDefault: false, variadic: false },
      { name: "b", hasDefault: true, variadic: false },
    ],
  };
  const wire = (rawCase: object) => ({
    sourceFile: "harness.agency",
    rawCases: [
      {
        nodeName: "testFive",
        input: "3, 4",
        expected: 9,
        criteria: "exact" as const,
        interrupts: [],
        ...rawCase,
      },
    ],
  });

  test("binds every case with named args; defaults stay absent", () => {
    const bound = _bindTestFileCases(wire({ input: "3" }), table);
    expect(bound[0].args).toEqual({ a: 3 });
    const both = _bindTestFileCases(wire({}), table);
    expect(both[0].args).toEqual({ a: 3, b: 4 });
  });

  test("unknown node names the case, the node, and the available nodes", () => {
    expect(() => _bindTestFileCases(wire({ nodeName: "nope" }), table)).toThrow(
      /case 1.*'nope'.*testFive/,
    );
  });

  test("a non-literal input names the case and node", () => {
    expect(() => _bindTestFileCases(wire({ input: "foo()" }), table)).toThrow(
      /case 1 \(testFive\)/,
    );
  });

  test("an arity violation names the accepted range", () => {
    expect(() => _bindTestFileCases(wire({ input: "1, 2, 3" }), table)).toThrow(
      /expected 1-2 argument/,
    );
  });

  test("performs no reads: works on wire data alone", () => {
    const bound = _bindTestFileCases(wire({ timeoutMs: 250, description: "d" }), table);
    expect(bound[0].wallClock).toBe(250);
    expect(bound[0].description).toBe("d");
  });
});
