import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordInstalledModel } from "./installedModel.js";
import { makeTempDir, removeTempDir } from "./tempDir.js";

// Runs tests/agency/reject.agency, whose handler rejects every interrupt.
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
const PROGRAM = path.join(PACKAGE_ROOT, "tests", "agency", "reject.agency");
const RUN_TIMEOUT_MS = 120_000;

describe("rejecting speak's interrupts", () => {
  let modelsDir: string;
  let workDir: string;

  beforeEach(() => {
    modelsDir = makeTempDir("kokoro-reject-models-");
    workDir = makeTempDir("kokoro-reject-work-");
    vi.stubEnv("AGENCY_KOKORO_MODELS_DIR", modelsDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    removeTempDir(modelsDir);
    removeTempDir(workDir);
  });

  function runProgram(): string {
    const run = spawnSync(process.execPath, [AGENCY_CLI, "run", PROGRAM], {
      cwd: workDir,
      env: { ...process.env, AGENCY_KOKORO_MODELS_DIR: modelsDir },
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    return run.stdout;
  }

  it("downloads nothing when the download is rejected", { timeout: RUN_TIMEOUT_MS }, () => {
    const output = runProgram();

    expect(output).toMatch(/reject/i);
    expect(fs.readdirSync(modelsDir)).toEqual([]);
    expect(fs.existsSync(path.join(workDir, "rejected.wav"))).toBe(false);
  });

  it("writes nothing when writing the file is rejected", { timeout: RUN_TIMEOUT_MS }, () => {
    recordInstalledModel("fp32", modelsDir);
    const output = runProgram();

    expect(output).toMatch(/reject/i);
    expect(fs.existsSync(path.join(workDir, "rejected.wav"))).toBe(false);
  });
});
