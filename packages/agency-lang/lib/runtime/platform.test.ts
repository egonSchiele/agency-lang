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
  function args(
    hasDebugger: boolean,
    host: ReturnType<typeof nodeHost> | ReturnType<typeof memoryHost>,
  ) {
    return {
      ctx: { hasDebugger: () => hasDebugger } as never,
      nodeName: "main",
      host,
      functions: {} as never,
    };
  }

  it("registerAttach writes nothing under a memory host, with a debugger, in an IPC child, or when AGENCY_NO_ATTACH is 1", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-"));
    const previous = process.env.AGENCY_HOME;
    process.env.AGENCY_HOME = home;
    try {
      // The memory host reads AGENCY_HOME from its own variables, so a
      // registration that wrongly went ahead would write under `home`.
      nodePlatform.registerAttach(args(false, memoryHost({ variables: { AGENCY_HOME: home } })));
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
      const noAttach = process.env[nodePlatform.NO_ATTACH_VAR];
      process.env[nodePlatform.NO_ATTACH_VAR] = "1";
      try {
        nodePlatform.registerAttach(args(false, nodeHost()));
      } finally {
        if (noAttach === undefined) {
          delete process.env[nodePlatform.NO_ATTACH_VAR];
        } else {
          process.env[nodePlatform.NO_ATTACH_VAR] = noAttach;
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

  it("registerAttach serves the functions of the most recent registration through one shared slot", () => {
    // This registers the test worker itself, under the run's AGENCY_HOME
    // (lib/debugger/attach/vitest.globalSetup.ts), and opens a real
    // socket under its pid. The slot is deliberately not cleared
    // afterwards: attach.test.ts registers the same process later and
    // reads the slot through the server's getter, and a cleared slot
    // would make that registration open a second server on the same
    // socket path.
    const first = { first: true } as never;
    const second = { second: true } as never;
    nodePlatform.registerAttach({ ...args(false, nodeHost()), functions: first });
    nodePlatform.registerAttach({ ...args(false, nodeHost()), functions: second });
    const slot = process as unknown as Record<symbol, { functions: unknown } | undefined>;
    expect(slot[Symbol.for("agency.debug.attachTarget")]?.functions).toBe(second);
  });
});
