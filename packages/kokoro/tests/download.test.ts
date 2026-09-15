import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordInstalledModel } from "./installedModel.js";
import { makeTempDir, removeTempDir } from "./tempDir.js";

// Runs tests/agency/download.agency with an explicit models directory.
// Needs `make` first: the program imports the compiled package.
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const AGENCY_CLI = path.join(
  PACKAGE_ROOT,
  "node_modules",
  "agency-lang",
  "dist",
  "scripts",
  "agency.js",
);
const PROGRAM = path.join(PACKAGE_ROOT, "tests", "agency", "download.agency");
const RUN_TIMEOUT_MS = 120_000;

describe("download from Agency", () => {
  let modelsDir: string;
  let workDir: string;

  beforeEach(() => {
    modelsDir = makeTempDir("kokoro-download-models-");
    workDir = makeTempDir("kokoro-download-work-");
  });

  afterEach(() => {
    removeTempDir(modelsDir);
    removeTempDir(workDir);
  });

  function runProgram(): string {
    const run = spawnSync(
      process.execPath,
      [AGENCY_CLI, "run", PROGRAM, "--models-dir", modelsDir],
      { cwd: workDir, encoding: "utf8", timeout: RUN_TIMEOUT_MS },
    );
    expect(run.status, run.stderr).toBe(0);
    return run.stdout;
  }

  it("asks before downloading, naming the directory it would use", { timeout: RUN_TIMEOUT_MS }, () => {
    const output = runProgram();

    expect(output).toContain(`asked kokoro::download for ${path.join(modelsDir, "fp32")}`);
    expect(output).toMatch(/rejected:/);
    expect(output).not.toContain("installed in");
    expect(fs.readdirSync(modelsDir)).toEqual([]);
  });

  it("returns the directory of an installed model without asking", { timeout: RUN_TIMEOUT_MS }, () => {
    recordInstalledModel("fp32", modelsDir);

    const output = runProgram();

    expect(output).toContain(`installed in ${path.join(modelsDir, "fp32")}`);
    expect(output).not.toContain("asked");
  });
});
