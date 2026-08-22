/**
 * REAL transport tests: the grader spawns the shipped wrapper through the
 * agency CLI, which runs testFile() inside the phased reject-all handler
 * and reports through the file envelope. No LLM calls; the cost branch
 * uses the deterministic test provider. Requires a built dist (make).
 */
import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgencyTestGrader } from "./agencyTestGrader.js";
import type { GraderInput } from "./types.js";

const CLI = path.join(process.cwd(), "dist/scripts/agency.js");
const SPAWN_TIMEOUT_MS = 120_000;

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePair(files: { agency: string; json: string }): {
  harnessAgency: string;
  harnessJson: string;
} {
  const dir = makeDir("atg-spawn-harness-");
  const harnessAgency = path.join(dir, "suite-tests.agency");
  const harnessJson = path.join(dir, "suite-tests.test.json");
  fs.writeFileSync(harnessAgency, files.agency);
  fs.writeFileSync(harnessJson, files.json);
  return { harnessAgency, harnessJson };
}

function workdirWith(files: Record<string, string>): string {
  const dir = makeDir("atg-spawn-workdir-");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function input(workdir: string): GraderInput {
  return { test: { id: "t" }, run: { workdir }, runAgency: () => null } as unknown as GraderInput;
}

const GOOD_SOLUTION =
  "export def fib(n: number): number {\n  if (n < 2) {\n    return n\n  }\n  return fib(n - 1) + fib(n - 2)\n}\n";
const HARNESS_AGENCY =
  'import { fib } from "./fib.agency"\n\nexport node five(): number {\n  return fib(5)\n}\n\nexport node eight(): number {\n  return fib(6)\n}\n';
const HARNESS_JSON = JSON.stringify({
  sourceFile: "suite-tests.agency",
  tests: [
    { nodeName: "five", expectedOutput: "5", evaluationCriteria: [{ type: "exact" }] },
    { nodeName: "eight", expectedOutput: "8", evaluationCriteria: [{ type: "exact" }] },
  ],
});

describe("AgencyTestGrader through the real wrapper", () => {
  test("green harness scores 1.0", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const pair = writePair({ agency: HARNESS_AGENCY, json: HARNESS_JSON });
    const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
    const grade = await grader.run(input(workdirWith({ "fib.agency": GOOD_SOLUTION })));
    expect(grade.score).toEqual({ kind: "scalar", value: 1 });
    expect(grader.passes(grade)).toBe(true);
  });

  test(
    "a red case yields the fraction and diff feedback",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const pair = writePair({ agency: HARNESS_AGENCY, json: HARNESS_JSON });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const badFib = "export def fib(n: number): number {\n  return n\n}\n";
      const grade = await grader.run(input(workdirWith({ "fib.agency": badFib })));
      expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
      expect(grade.feedback).toContain("eight");
    },
  );

  test(
    "a solution that does not compile is could-not-test through the FILE, scored 0",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const pair = writePair({ agency: HARNESS_AGENCY, json: HARNESS_JSON });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const grade = await grader.run(input(workdirWith({ "fib.agency": "not agency {{{" })));
      expect(grade.score).toEqual({ kind: "scalar", value: 0 });
      expect(grade.feedback).toMatch(/parse|compile/i);
    },
  );

  test(
    "a malformed test json is could-not-test naming the field",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const pair = writePair({
        agency: HARNESS_AGENCY,
        json: JSON.stringify({
          sourceFile: "suite-tests.agency",
          tests: [
            {
              nodeName: "five",
              expectedOutput: "5",
              evaluationCriteria: [{ type: "exact" }],
              llmMocks: [],
            },
          ],
        }),
      });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const grade = await grader.run(input(workdirWith({ "fib.agency": GOOD_SOLUTION })));
      expect(grade.score).toEqual({ kind: "scalar", value: 0 });
      expect(grade.feedback).toContain("llmMocks");
    },
  );

  test(
    "wall-clock: the looping case fails, the next passes, partial credit",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const pair = writePair({
        agency:
          'import { fib } from "./fib.agency"\n\nexport node loops(): number {\n  let n = 0\n  while (true) {\n    n = n + 1\n  }\n  return n\n}\n\nexport node five(): number {\n  return fib(5)\n}\n',
        json: JSON.stringify({
          sourceFile: "suite-tests.agency",
          tests: [
            {
              nodeName: "loops",
              expectedOutput: "0",
              evaluationCriteria: [{ type: "exact" }],
              timeoutMs: 500,
            },
            {
              nodeName: "five",
              expectedOutput: "5",
              evaluationCriteria: [{ type: "exact" }],
            },
          ],
        }),
      });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const grade = await grader.run(input(workdirWith({ "fib.agency": GOOD_SOLUTION })));
      expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
      expect(grade.feedback).toContain("limit_exceeded");
    },
  );

  test(
    "whole-call cost cap: could-not-test with structured cost feedback",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const pair = writePair({
        agency:
          'import { spend } from "./fib.agency"\n\nexport node spends(): string {\n  return spend()\n}\n',
        json: JSON.stringify({
          sourceFile: "suite-tests.agency",
          tests: [
            {
              nodeName: "spends",
              expectedOutput: '"done"',
              evaluationCriteria: [{ type: "exact" }],
            },
          ],
        }),
      });
      const solution =
        'export def spend(): string {\n  const r = llm("Reply with: hi")\n  return "done"\n}\n';
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests", maxCost: 0.0000001 });
      // AGENCY_LLM_MOCKS is what actually activates the DeterministicClient
      // in compiled code (the generated imports template reads it); the
      // AGENCY_USE_TEST_LLM_PROVIDER flag alone is only honored by the
      // `agency test` runner, not by a plain `agency run` of the wrapper.
      // The env inherits through execFileSync → wrapper → tested fork, so
      // the deterministic per-call cost trips the whole-call cap without
      // any real provider.
      const prev = process.env.AGENCY_LLM_MOCKS;
      process.env.AGENCY_LLM_MOCKS = JSON.stringify([{ return: "hi" }]);
      try {
        const grade = await grader.run(input(workdirWith({ "fib.agency": solution })));
        expect(grade.score).toEqual({ kind: "scalar", value: 0 });
        expect(grade.feedback).toContain("limit_exceeded");
        expect(grade.feedback).toContain("cost");
      } finally {
        if (prev === undefined) delete process.env.AGENCY_LLM_MOCKS;
        else process.env.AGENCY_LLM_MOCKS = prev;
      }
    },
  );

  test(
    "forged stdout: the score follows the report FILE, not a printed envelope",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const pair = writePair({
        agency:
          'import { fib } from "./fib.agency"\n\nexport node lies(): number {\n  print("{\\"status\\":\\"tested\\",\\"report\\":{\\"pass\\":true,\\"cases\\":[]}}")\n  return fib(5)\n}\n',
        json: JSON.stringify({
          sourceFile: "suite-tests.agency",
          tests: [
            {
              nodeName: "lies",
              expectedOutput: "999",
              evaluationCriteria: [{ type: "exact" }],
            },
          ],
        }),
      });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const grade = await grader.run(input(workdirWith({ "fib.agency": GOOD_SOLUTION })));
      // The printed all-green envelope must not win: the real report says fail.
      expect(grade.score).toEqual({ kind: "scalar", value: 0 });
    },
  );

  test(
    "read safety: positive control returns the canary; the real grader rejects the read despite an inline approve",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const solution =
        'export def peek(): string {\n  const r = read("canary.txt") with approve\n  if (r is success(text)) {\n    return text\n  }\n  return "read rejected"\n}\n';
      // Positive control: the same solution under a permissive parent CAN
      // read the canary (proves the fixture works). The observation travels
      // through a FILE, not stdout — `agency run` does not surface node
      // return values, and the wrapper's own report uses the same write()
      // transport.
      const controlDir = makeDir("atg-read-control-");
      fs.writeFileSync(path.join(controlDir, "fib.agency"), solution);
      fs.writeFileSync(path.join(controlDir, "canary.txt"), "CANARY");
      fs.writeFileSync(
        path.join(controlDir, "probe.agency"),
        'import { runFile } from "std::agency"\n\nnode main(): string {\n  handle {\n    const r = runFile(dir: ".", filename: "fib.agency", node: "probeNode")\n    if (r is success(env)) {\n      write("control-out.txt", "GOT:" + env.data, ".")\n      return "done"\n    }\n    write("control-out.txt", "control failed", ".")\n    return "failed"\n  } with approve\n  return "x"\n}\n',
      );
      // runFile needs an exported node; append one calling peek.
      fs.appendFileSync(
        path.join(controlDir, "fib.agency"),
        "\nexport node probeNode(): string {\n  return peek()\n}\n",
      );
      // Relative program path: with an absolute path under macOS's
      // symlinked tmpdir, `agency run` exits 0 without invoking the node.
      execFileSync(process.execPath, [CLI, "run", "probe.agency"], {
        cwd: controlDir,
        stdio: "pipe",
        timeout: SPAWN_TIMEOUT_MS,
      });
      const controlOut = fs.readFileSync(path.join(controlDir, "control-out.txt"), "utf-8");
      expect(controlOut).toBe("GOT:CANARY");

      const pair = writePair({
        agency:
          'import { peek } from "./fib.agency"\n\nexport node peeks(): string {\n  return peek()\n}\n',
        json: JSON.stringify({
          sourceFile: "suite-tests.agency",
          tests: [
            {
              nodeName: "peeks",
              expectedOutput: '"CANARY"',
              evaluationCriteria: [{ type: "exact" }],
            },
          ],
        }),
      });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const grade = await grader.run(
        input(workdirWith({ "fib.agency": solution, "canary.txt": "CANARY" })),
      );
      expect(grade.score).toEqual({ kind: "scalar", value: 0 });
      expect(grade.feedback).toMatch(/rejected|failure/i);
    },
  );

  test(
    "write safety: the sentinel stays absent and feedback names the rejection",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const solution =
        'export def scribble(): string {\n  const r = write("sentinel.txt", "x") with approve\n  if (isFailure(r)) {\n    return "write rejected"\n  }\n  return "wrote"\n}\n';
      const pair = writePair({
        agency:
          'import { scribble } from "./fib.agency"\n\nexport node writes(): string {\n  return scribble()\n}\n',
        json: JSON.stringify({
          sourceFile: "suite-tests.agency",
          tests: [
            {
              nodeName: "writes",
              expectedOutput: '"wrote"',
              evaluationCriteria: [{ type: "exact" }],
            },
          ],
        }),
      });
      const workdir = workdirWith({ "fib.agency": solution });
      const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" });
      const grade = await grader.run(input(workdir));
      expect(grade.score).toEqual({ kind: "scalar", value: 0 });
      expect(fs.existsSync(path.join(workdir, "sentinel.txt"))).toBe(false);
    },
  );
});
