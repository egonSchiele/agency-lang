import { describe, it, expect } from "vitest";
import * as nodePlatform from "./platform.node.js";
import * as browserPlatform from "./platform.browser.js";

describe("#platform", () => {
  it("both files match the declaration in packageImports.d.ts", () => {
    const node: typeof import("#platform") = nodePlatform;
    const browser: typeof import("#platform") = browserPlatform;
    expect(node.newCoverageCollector()).not.toBeNull();
    expect(browser.newCoverageCollector()).toBeNull();
  });

  it("the browser side loads nothing, and refuses a configured provider module", async () => {
    await expect(browserPlatform.loadConfiguredProviders({})).resolves.toBeUndefined();
    await expect(
      browserPlatform.loadConfiguredProviders({ providerModules: ["./my-provider.js"] }),
    ).rejects.toThrow(
      "Provider modules load from disk, which a browser cannot do: ./my-provider.js",
    );
    await expect(
      browserPlatform.loadConfiguredProviders({ smoltalkDefaults: { provider: "llama-cpp" } }),
    ).rejects.toThrow("llama-cpp");
  });

  it("the browser side refuses a local model", async () => {
    await expect(browserPlatform.resolveLocalEmbeddingModel("mlx", "bge")).rejects.toThrow(
      "cannot run in a browser",
    );
  });
});
