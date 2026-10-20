import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as nodePlatform from "./platform.node.js";
import * as browserPlatform from "./platform.browser.js";
import { memoryHost } from "../host/memoryHost.js";
import { nodeHost } from "../host/node/nodeHost.js";

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

  /** What registerAttach reads from a context, with no functions bound:
   *  every case here returns before they would be used. */
  function args(hasDebugger: boolean, host: ReturnType<typeof nodeHost>) {
    return {
      ctx: { hasDebugger: () => hasDebugger } as never,
      nodeName: "main",
      host,
      functions: {} as never,
    };
  }

  it("registerAttach writes nothing under a memory host, with a debugger, or in an IPC child", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-"));
    const previous = process.env.AGENCY_HOME;
    process.env.AGENCY_HOME = home;
    try {
      nodePlatform.registerAttach(args(false, memoryHost()));
      nodePlatform.registerAttach(args(true, nodeHost()));
      const ipc = process.env.AGENCY_IPC;
      process.env.AGENCY_IPC = "1";
      try {
        nodePlatform.registerAttach(args(false, nodeHost()));
      } finally {
        if (ipc === undefined) {
          delete process.env.AGENCY_IPC;
        } else {
          process.env.AGENCY_IPC = ipc;
        }
      }
      expect(fs.existsSync(path.join(home, "debug-sessions"))).toBe(false);
      browserPlatform.registerAttach(args(false, nodeHost()));
    } finally {
      if (previous === undefined) {
        delete process.env.AGENCY_HOME;
      } else {
        process.env.AGENCY_HOME = previous;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
