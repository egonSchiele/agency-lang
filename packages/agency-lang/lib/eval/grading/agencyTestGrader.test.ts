import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgencyTestGrader, gradeReport, type RunHarness } from "./agencyTestGrader.js";
import { AgencyRunner } from "./agencyRunner.js";
import { buildTestReport, type TestFileReport } from "../../cli/testReport.js";
import type { GraderInput } from "./types.js";

function harnessPair(): { dir: string; agency: string; json: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  const agency = path.join(dir, "suite.agency");
  const json = path.join(dir, "suite.test.json");
  fs.writeFileSync(agency, "export node t(): number {\n  return 1\n}\n");
  fs.writeFileSync(
    json,
    JSON.stringify({
      tests: [{ nodeName: "t", expectedOutput: "1", evaluationCriteria: [{ type: "exact" }] }],
    }),
  );
  return { dir, agency, json };
}

function workdirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workdir-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function input(workdir: string): GraderInput {
  return {
    test: { id: "t" },
    run: { output: null, traceId: "tr", workdir, record: {} as never },
    runAgency: new AgencyRunner({}),
  };
}

function ran(cases: TestFileReport["cases"]): string {
  return JSON.stringify(
    buildTestReport([
      { file: "suite.test.json", sourceFile: "suite.agency", status: "ran", cases },
    ]),
  );
}

describe("AgencyTestGrader (stubbed CLI)", () => {
  test("scores the passing fraction and names the failing cases; revision covers both files", async () => {
    const pair = harnessPair();
    const stub: RunHarness = () => ({
      stdout: ran([
        { node: "a", status: "passed", durationMs: 1 },
        { node: "b", status: "failed", feedback: "- 1\n+ 2", durationMs: 1 },
      ]),
    });
    const grader = new AgencyTestGrader(
      { name: "suite", harnessAgency: pair.agency, harnessJson: pair.json },
      stub,
    );
    expect(grader.revision).toMatch(/^agency-tests\/suite@[0-9a-f]{64}$/);
    const grade = await grader.run(input(workdirWith({ "fib.agency": "x" })));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
    expect(grade.feedback).toBe("b: - 1\n+ 2");
    expect(grader.passes(grade)).toBe(false);
  });

  test("the stub sees the framework's harness bytes, not the agent's edited copy", async () => {
    const pair = harnessPair();
    let seen = "";
    const stub: RunHarness = ({ scratchDir, jsonFilename }) => {
      seen = fs.readFileSync(path.join(scratchDir, jsonFilename), "utf-8");
      return { stdout: ran([{ node: "t", status: "passed", durationMs: 1 }]) };
    };
    const grader = new AgencyTestGrader(
      { name: "suite", harnessAgency: pair.agency, harnessJson: pair.json },
      stub,
    );
    const workdir = workdirWith({ "suite.test.json": '{"tests": []}', "suite.agency": "tampered" });
    const grade = await grader.run(input(workdir));
    expect(seen).toBe(fs.readFileSync(pair.json, "utf-8"));
    expect(grade.score).toEqual({ kind: "scalar", value: 1 });
  });

  test("a symlink in the workdir is not copied into the scratch dir", async () => {
    const pair = harnessPair();
    const workdir = workdirWith({ "real.txt": "x" });
    fs.symlinkSync(path.join(workdir, "real.txt"), path.join(workdir, "link.txt"));
    let entries: string[] = [];
    const stub: RunHarness = ({ scratchDir }) => {
      entries = fs.readdirSync(scratchDir);
      return { stdout: ran([]) };
    };
    await new AgencyTestGrader(
      { name: "suite", harnessAgency: pair.agency, harnessJson: pair.json },
      stub,
    ).run(input(workdir));
    expect(entries).toContain("real.txt");
    expect(entries).not.toContain("link.txt");
  });

  test("no workdir, a compile-failed file, and a non-report all score 0 with a reason", async () => {
    const pair = harnessPair();
    const refused = JSON.stringify(
      buildTestReport([
        {
          file: "suite.test.json",
          sourceFile: "suite.agency",
          status: "compile-failed",
          error: "suite.agency imports 'fs', which is not Agency source",
          cases: [],
        },
      ]),
    );
    const make = (stdout: string) =>
      new AgencyTestGrader(
        { name: "suite", harnessAgency: pair.agency, harnessJson: pair.json },
        () => ({ stdout }),
      );
    const none = await make(ran([])).run(input(""));
    expect(none).toMatchObject({ score: { value: 0 }, feedback: "run left no workdir" });
    const compile = await make(refused).run(input(workdirWith({})));
    expect(compile.score).toEqual({ kind: "scalar", value: 0 });
    expect(compile.feedback).toMatch(/not Agency source/);
    const garbage = await make("not json at all").run(input(workdirWith({})));
    expect(garbage.feedback).toMatch(/produced no report/);
  });
});

describe("gradeReport", () => {
  test("a file with zero cases that ran scores 1", () => {
    expect(gradeReport(JSON.parse(ran([])), "suite.test.json").score).toEqual({
      kind: "scalar",
      value: 1,
    });
  });
});
