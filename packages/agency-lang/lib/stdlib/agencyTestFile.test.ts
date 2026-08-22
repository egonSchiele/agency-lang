import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { _readTestFileSandbox } from "./agency.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agency-testfile-"));
}

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
            args: { a: 3, b: 4 },
            expectedOutput: "9",
            evaluationCriteria: [{ type: "exact" }],
          },
        ],
      }),
    );
    const wire = _readTestFileSandbox(dir, "suite.test.json");
    expect(wire.sourceFile).toBe("harness.agency");
    expect(wire.defaultTimeoutMs).toBe(5000);
    expect(wire.cases[0]).toEqual({
      node: "testFive",
      args: { a: 3, b: 4 },
      expected: 9,
      interrupts: [],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("sourceFile is relative to the .test.json, so a nested suite tests its own sibling", () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, "sub"));
    const body = JSON.stringify({
      tests: [{ nodeName: "t", expectedOutput: "1", evaluationCriteria: [{ type: "exact" }] }],
    });
    fs.writeFileSync(path.join(dir, "sub", "suite.test.json"), body);
    fs.writeFileSync(
      path.join(dir, "sub", "explicit.test.json"),
      JSON.stringify({ ...JSON.parse(body), sourceFile: "harness.agency" }),
    );
    expect(_readTestFileSandbox(dir, "sub/suite.test.json").sourceFile).toBe(
      path.join("sub", "suite.agency"),
    );
    expect(_readTestFileSandbox(dir, "sub/explicit.test.json").sourceFile).toBe(
      path.join("sub", "harness.agency"),
    );
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
