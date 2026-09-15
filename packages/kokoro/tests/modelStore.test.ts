import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remove, root } from "agency-lang/stdlib-lib/contained.js";
import { downloadHubSnapshot } from "agency-lang/stdlib-lib/hubDownload.js";
import { snapshotFor } from "../src/lockfile.js";
import {
  downloadModel,
  modelRepoDir,
  modelStatus,
  resolveModelsDir,
} from "../src/modelStore.js";
import { recordInstalledModel } from "./installedModel.js";
import { makeTempDir, removeTempDir } from "./tempDir.js";

vi.mock("agency-lang/stdlib-lib/hubDownload.js", () => ({ downloadHubSnapshot: vi.fn() }));

describe("modelStore", () => {
  let modelsDir: string;

  beforeEach(() => {
    modelsDir = makeTempDir("kokoro-models-");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    removeTempDir(modelsDir);
  });

  it("uses the caller's directory first, then the environment, then the home directory", () => {
    vi.stubEnv("AGENCY_KOKORO_MODELS_DIR", "/from/env");

    expect(resolveModelsDir("/from/caller")).toBe("/from/caller");
    expect(resolveModelsDir(null)).toBe("/from/env");
    expect(resolveModelsDir("")).toBe("/from/env");

    vi.stubEnv("AGENCY_KOKORO_MODELS_DIR", "");
    expect(resolveModelsDir(null)).toMatch(/\.agency[\\/]models[\\/]kokoro$/);
  });

  it("reports a model with no record as not installed, with its download size", () => {
    const status = modelStatus("fp32", modelsDir);

    expect(status.installed).toBe(false);
    expect(status.dir).toBe(path.join(modelsDir, "fp32"));
    expect(status.sizeBytes).toBe(325532232 + 44 + 3497 + 113);
    expect(status.source).toContain(snapshotFor("fp32").revision);
  });

  it("reports a complete record at the pinned revision as installed", () => {
    recordInstalledModel("fp32", modelsDir);
    expect(modelStatus("fp32", modelsDir).installed).toBe(true);
  });

  it("does not trust a record from another revision", () => {
    recordInstalledModel("fp32", modelsDir, { revision: "0".repeat(40) });
    expect(modelStatus("fp32", modelsDir).installed).toBe(false);
  });

  it("does not trust a record with a file still downloading", () => {
    recordInstalledModel("fp32", modelsDir, { incompletePath: "onnx/model.onnx" });
    expect(modelStatus("fp32", modelsDir).installed).toBe(false);
  });

  it("does not trust a record whose file is gone from disk", () => {
    recordInstalledModel("fp32", modelsDir);
    remove(root(modelRepoDir("fp32", modelsDir)), "onnx/model.onnx");
    expect(modelStatus("fp32", modelsDir).installed).toBe(false);
  });

  it("keeps each model separate", () => {
    recordInstalledModel("fp32", modelsDir);
    expect(modelStatus("q8", modelsDir).installed).toBe(false);
  });

  it("downloads the pinned snapshot into the model's own directory", async () => {
    await downloadModel("q8", modelsDir);
    expect(downloadHubSnapshot).toHaveBeenCalledWith(snapshotFor("q8"), modelRepoDir("q8", modelsDir), {});
    expect(modelRepoDir("q8", modelsDir).startsWith(modelsDir)).toBe(true);
  });
});
