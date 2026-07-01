import { describe, it, expect, vi } from "vitest";

// Mock the native shim so modelsRefresh's success/failure branches are
// exercised without a real network fetch. The pure functions under test
// (selectHostedModels/formatHostedCatalog) take explicit args and don't touch
// the mocked natives, so this mock doesn't affect them.
vi.mock("../stdlib/llm.js", () => ({
  _listHostedModels: () => [],
  _refreshHostedCatalog: vi.fn(),
}));

import {
  selectHostedModels,
  formatHostedCatalog,
  modelsRefresh,
} from "./hostedModels.js";
import { _refreshHostedCatalog } from "../stdlib/llm.js";
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
  it("prints the model count on success", async () => {
    vi.mocked(_refreshHostedCatalog).mockResolvedValue({ ok: true, count: 42, error: "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await modelsRefresh();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("42"));
    log.mockRestore();
  });
  it("reports the error and sets a non-zero exit code on failure", async () => {
    vi.mocked(_refreshHostedCatalog).mockResolvedValue({ ok: false, count: 0, error: "network down" });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await modelsRefresh();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("network down"));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset so a real later failure isn't masked
    errorLog.mockRestore();
  });
});
