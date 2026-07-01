import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the native shim so modelsRefresh's success/failure branches are
// exercised without a real network fetch. The pure functions under test
// (selectHostedModels/formatHostedCatalog) take explicit args and don't touch
// the mocked natives, so this mock doesn't affect them.
vi.mock("../stdlib/llm.js", () => ({
  _listHostedModels: () => [],
  _fetchModelData: vi.fn(),
}));

import {
  selectHostedModels,
  formatHostedCatalog,
  modelsRefresh,
} from "./hostedModels.js";
import { _fetchModelData } from "../stdlib/llm.js";
import type { HostedModelInfo } from "../stdlib/llm.js";

const catalog: HostedModelInfo[] = [
  { name: "cheap-oss", provider: "openrouter", openWeights: true, inputCost: 0.1, outputCost: 0.2, contextWindow: 32000, family: "x" },
  { name: "pricey", provider: "anthropic", openWeights: false, inputCost: 15, outputCost: 75, contextWindow: 200000, family: "y" },
];

describe("agency models selection", () => {
  it("filters by provider, price, and minContext", () => {
    expect(selectHostedModels(catalog, { provider: "anthropic" }).map((model) => model.name)).toEqual(["pricey"]);
    expect(selectHostedModels(catalog, { maxPrice: 1 }).map((model) => model.name)).toEqual(["cheap-oss"]);
    expect(selectHostedModels(catalog, { minContext: 100000 }).map((model) => model.name)).toEqual(["pricey"]);
    expect(selectHostedModels(catalog, {}).length).toBe(2);
    // maxPrice/minContext must use `!== undefined`, NOT a truthy check: 0 is a
    // real bound (excludes everything here), not "no filter". Guards against a
    // regression to `if (opts.maxPrice && …)`.
    expect(selectHostedModels(catalog, { maxPrice: 0 }).length).toBe(0);
    expect(selectHostedModels(catalog, { minContext: 0 }).length).toBe(2);
  });
  it("formats a table with name, provider, open-weights column, price, context", () => {
    const out = formatHostedCatalog(catalog);
    expect(out).toContain("cheap-oss");
    expect(out).toContain("openrouter");
    expect(out).toContain("yes"); // open-weights shown as a column
    expect(out).toContain("0.1");
    expect(out).toContain("32000");
  });
});

describe("agency models refresh", () => {
  beforeEach(() => {
    process.exitCode = 0;
    vi.mocked(_fetchModelData).mockReset();
  });
  // The failure test sets exitCode = 1; clear it so it doesn't fail the run.
  afterEach(() => {
    process.exitCode = 0;
  });

  it("prints the fetched JSON to stdout and nothing to stderr on success", async () => {
    const blob = { schemaVersion: 1, models: [{ modelName: "x" }] };
    vi.mocked(_fetchModelData).mockResolvedValue({ ok: true, json: JSON.stringify(blob, null, 2), error: "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await modelsRefresh();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toHaveProperty("models");
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
  it("reports the error on stderr, exits non-zero, and prints nothing to stdout on failure", async () => {
    vi.mocked(_fetchModelData).mockResolvedValue({ ok: false, json: "", error: "network down" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await modelsRefresh();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("network down"));
    expect(process.exitCode).toBe(1);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});
