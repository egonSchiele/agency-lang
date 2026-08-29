import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, describe, expect, it } from "vitest";

import { safeDeleteDirectoryWithin } from "@/utils.js";

import { checkName, parseJunit, runPytest } from "./checks.js";

const SUITE = path.resolve(__dirname, "..");
const TESTS = ["count-by-window", "pack-archive", "cert-and-checker", "name-the-weakness"];

describe("parseJunit", () => {
  it("reads a passing and a failing case", () => {
    const xml = `<testsuite><testcase name="test_a" time="0.1"/><testcase name="test_b"><failure message="m">AssertionError: root holds 31 entries</failure></testcase></testsuite>`;
    expect(parseJunit(xml)).toEqual([
      { name: "test_a", passed: true, message: "" },
      { name: "test_b", passed: false, message: "AssertionError: root holds 31 entries" },
    ]);
  });

  it("treats a skipped case as not passed", () => {
    expect(parseJunit(`<testcase name="test_s"><skipped/></testcase>`)[0].passed).toBe(false);
  });
});

describe("checkName", () => {
  it("drops test_ and swaps underscores for dashes", () => {
    expect(checkName("test_roundtrip_sample")).toBe("roundtrip-sample");
  });
});

const hasPytest =
  spawnSync("python3", ["-m", "pytest", "--version"], { stdio: "ignore" }).status === 0;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agency-agent-checks-"));

afterAll(() => {
  safeDeleteDirectoryWithin(os.tmpdir(), scratch);
});

function workdirFor(test: string, mode: "untouched" | "solved"): string {
  const workdir = path.join(scratch, `${test}-${mode}`);
  fs.mkdirSync(workdir);
  const files = path.join(SUITE, test, "files");
  if (fs.existsSync(files)) {
    fs.cpSync(files, workdir, { recursive: true });
  }
  if (mode === "solved") {
    execFileSync("bash", [path.join(SUITE, test, "graderFiles", "solution", "solve.sh")], {
      cwd: workdir,
      stdio: "pipe",
    });
  }
  return workdir;
}

function mustPassNames(test: string): string[] {
  const source = fs.readFileSync(path.join(SUITE, test, "graders.ts"), "utf8");
  return [...source.matchAll(/name: "([^"]+)", mustPass: true/g)].map((m) => m[1]);
}

// Each check must pass on the reference solution and its must-pass checks
// must fail on the untouched starting tree; a check that passes an empty
// workdir would let every brain score.
describe.skipIf(!hasPytest)("the checks discriminate", () => {
  for (const test of TESTS) {
    it(`${test}: solution passes every check`, () => {
      const results = runPytest({
        workdir: workdirFor(test, "solved"),
        graderFiles: path.join(SUITE, test, "graderFiles"),
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.filter((r) => !r.passed).map((r) => `${r.name}: ${r.message}`)).toEqual([]);
    });

    it(`${test}: untouched tree fails every must-pass check`, () => {
      const results = runPytest({
        workdir: workdirFor(test, "untouched"),
        graderFiles: path.join(SUITE, test, "graderFiles"),
      });
      const required = mustPassNames(test);
      expect(required.length).toBeGreaterThan(0);
      const passedRequired = results.filter(
        (r) => r.passed && required.includes(checkName(r.name)),
      );
      expect(passedRequired.map((r) => r.name)).toEqual([]);
    });
  }
});
