import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the programs in tests/agency through the agency CLI, in a folder
// whose agency.json points the Python at the fake trainer. Needs `make`
// first: the programs import the compiled package.
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const AGENCY_CLI = path.join(
  PACKAGE_ROOT,
  "node_modules",
  "agency-lang",
  "dist",
  "scripts",
  "agency.js",
);
const FAKE_PYTHON = path.join(PACKAGE_ROOT, "tests", "fakePython.sh");
const RUN_TIMEOUT_MS = 120_000;

describe("trainLora from Agency", () => {
  let workDir: string;
  let log: string;

  beforeEach(() => {
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lora-agency-")));
    fs.mkdirSync(path.join(workDir, "images"));
    fs.writeFileSync(path.join(workDir, "images", "a.png"), "png");
    fs.mkdirSync(path.join(workDir, "model", "unet"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "model", "model_index.json"),
      JSON.stringify({ _class_name: "StableDiffusionXLPipeline" }),
    );
    fs.writeFileSync(
      path.join(workDir, "model", "unet", "diffusion_pytorch_model.safetensors"),
      "",
    );
    fs.writeFileSync(
      path.join(workDir, "agency.json"),
      JSON.stringify({ client: { mlx: { python: FAKE_PYTHON } } }),
    );
    log = path.join(workDir, "runs.log");
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function runProgram(name: string): string {
    const run = spawnSync(
      process.execPath,
      [AGENCY_CLI, "run", path.join(PACKAGE_ROOT, "tests", "agency", name)],
      {
        cwd: workDir,
        env: { ...process.env, FAKE_TRAINER_LOG: log },
        encoding: "utf8",
        timeout: RUN_TIMEOUT_MS,
      },
    );
    expect(run.status, run.stderr).toBe(0);
    return run.stdout;
  }

  it(
    "raises lora::train first, and starts nothing when it is rejected",
    { timeout: RUN_TIMEOUT_MS },
    () => {
      const output = runProgram("reject.agency");

      expect(output).toContain(`asked lora::train for ${path.join(workDir, "images")}`);
      expect(output).toMatch(/rejected/i);
      expect(fs.existsSync(log)).toBe(false);
      expect(fs.existsSync(path.join(workDir, "sketch.safetensors"))).toBe(false);
    },
  );

  it("trains once when it is approved", { timeout: RUN_TIMEOUT_MS }, () => {
    const output = runProgram("approve.agency");

    expect(output).toContain("asked lora::train");
    expect(output).toContain(`trained ${path.join(workDir, "sketch.safetensors")}`);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
