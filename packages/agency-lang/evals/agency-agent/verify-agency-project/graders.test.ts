import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toGrader } from "@/eval/grading/functionGrader.js";
import { loadedRun } from "@/eval/grading/testUtils.js";
import { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

import graders from "./graders.js";

const ROOT = path.resolve(__dirname);
const TEMP_ROOT = path.resolve(".agency-tmp");
fs.mkdirSync(TEMP_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(TEMP_ROOT, "verify-eval-checks-"));
const solved = path.join(scratch, "solved");
const deterministic = graders
  .map(toGrader)
  .filter((item) => ["build-executed", "test-executed", "source-unchanged"].includes(item.name()));

beforeAll(() => {
  fs.cpSync(path.join(ROOT, "files"), solved, { recursive: true });
  execFileSync("bash", [path.join(ROOT, "graderFiles/solution/solve.sh")], {
    cwd: solved,
    env: { ...process.env, AGENCY_CLI: path.resolve("dist/scripts/agency.js") },
    stdio: "pipe",
    timeout: 30_000,
  });
});

afterAll(() => {
  safeDeleteDirectoryWithin(TEMP_ROOT, scratch);
});

async function scores(workdir: string): Promise<Record<string, boolean>> {
  const run = { ...loadedRun(""), workdir };
  const results: Record<string, boolean> = {};
  for (const item of deterministic) {
    const grade = await item.run({
      test: { input: "Verify the project" },
      run,
      runAgency: new AgencyRunner({}, async () => {
        throw new Error("Deterministic checks must not call a model");
      }),
      graderFiles: path.join(ROOT, "graderFiles"),
    });
    results[item.name()] = item.passes(grade);
  }
  return results;
}

function copySolved(name: string): string {
  const workdir = path.join(scratch, name);
  fs.cpSync(solved, workdir, { recursive: true });
  return workdir;
}

describe("verify-agency-project graders", () => {
  it("accepts actual compiler and test execution", async () => {
    expect(await scores(solved)).toEqual({
      "build-executed": true,
      "test-executed": true,
      "source-unchanged": true,
    });
  });

  it("rejects an untouched project and a script offered instead of execution", async () => {
    const workdir = path.join(scratch, "untouched");
    fs.cpSync(path.join(ROOT, "files"), workdir, { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "proposed-build.sh"),
      "agency compile src/coordinator.agency\n",
    );
    expect(await scores(workdir)).toEqual({
      "build-executed": false,
      "test-executed": false,
      "source-unchanged": true,
    });
  });

  it("rejects claimed success without compiler or test evidence", async () => {
    const workdir = path.join(scratch, "claims-only");
    fs.cpSync(path.join(ROOT, "files"), workdir, { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "verification.json"),
      '{"buildExitCode":0,"testExitCode":0}',
    );
    const result = await scores(workdir);
    expect(result["build-executed"]).toBe(false);
    expect(result["test-executed"]).toBe(false);
  });

  it("rejects a failed test even when the summary claims success", async () => {
    const workdir = copySolved("failed-test");
    const reportPath = path.join(workdir, "test-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.files[0].cases[0].status = "failed";
    fs.writeFileSync(reportPath, JSON.stringify(report));
    expect((await scores(workdir))["test-executed"]).toBe(false);
  });

  it("rejects changed source even when the build and test passed", async () => {
    const workdir = copySolved("changed-source");
    fs.appendFileSync(path.join(workdir, "src/coordinator.agency"), "\n// unsolicited edit\n");
    expect((await scores(workdir))["source-unchanged"]).toBe(false);
  });
});
