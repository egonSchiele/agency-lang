import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadHubSnapshot } from "agency-lang/stdlib-lib/hubDownload.js";
import { snapshotFor } from "../src/lockfile.js";
import { downloadModel, modelRepoDir, modelStatus } from "../src/modelStore.js";
import { recordInstalledModel } from "./installedModel.js";
import { makeTempDir, removeTempDir } from "./tempDir.js";

vi.mock("agency-lang/stdlib-lib/hubDownload.js", () => ({ downloadHubSnapshot: vi.fn() }));

describe("modelStore", () => {
  let modelsDir: string;

  beforeEach(() => {
    modelsDir = makeTempDir("kokoro-models-");
    vi.stubEnv("AGENCY_KOKORO_MODELS_DIR", modelsDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    removeTempDir(modelsDir);
  });

  it("reports a model with no record as not installed, with its download size", () => {
    const status = modelStatus("fp32");

    expect(status.installed).toBe(false);
    expect(status.sizeBytes).toBe(325532232 + 44 + 3497 + 113);
    expect(status.source).toContain(snapshotFor("fp32").revision);
  });

  it("reports a complete record at the pinned revision as installed", () => {
    recordInstalledModel("fp32");
    expect(modelStatus("fp32").installed).toBe(true);
  });

  it("does not trust a record from another revision", () => {
    recordInstalledModel("fp32", { revision: "0".repeat(40) });
    expect(modelStatus("fp32").installed).toBe(false);
  });

  it("does not trust a record with a file still downloading", () => {
    recordInstalledModel("fp32", { incompletePath: "onnx/model.onnx" });
    expect(modelStatus("fp32").installed).toBe(false);
  });

  it("keeps each model separate", () => {
    recordInstalledModel("fp32");
    expect(modelStatus("q8").installed).toBe(false);
  });

  it("downloads the pinned snapshot into the model's own directory", async () => {
    await downloadModel("q8");
    expect(downloadHubSnapshot).toHaveBeenCalledWith(snapshotFor("q8"), modelRepoDir("q8"), {
      onEvent: undefined,
    });
    expect(modelRepoDir("q8").startsWith(modelsDir)).toBe(true);
  });
});
