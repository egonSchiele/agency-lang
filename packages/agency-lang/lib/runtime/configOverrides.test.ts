import { afterEach, describe, expect, it } from "vitest";

import {
  applyRuntimeConfigOverridesToContextArgs,
  setRuntimeConfigOverrides,
} from "./configOverrides.js";
import {
  CONFIG_OVERRIDES_ENV,
  serializeConfigOverrides,
} from "../config.js";
import { RuntimeContext } from "./state/context.js";
import { agentConfigOverride } from "../cli/runBundledAgent.js";

describe("runtime config overrides", () => {
  it("applies eval run statelog overrides without replacing existing fields", () => {
    const result = applyRuntimeConfigOverridesToContextArgs(
      {
        statelogConfig: {
          host: "https://statelog.example",
          apiKey: "key",
          projectId: "project",
          debugMode: true,
          observability: false,
        },
        smoltalkDefaults: { model: "gpt-4o-mini" },
        dirname: "/project",
      },
      { observability: true, log: { logFile: "/tmp/task.statelog.jsonl" } },
    );

    expect(result.statelogConfig).toEqual({
      host: "https://statelog.example",
      apiKey: "key",
      projectId: "project",
      debugMode: true,
      observability: true,
      logFile: "/tmp/task.statelog.jsonl",
    });
    expect(result.smoltalkDefaults).toEqual({ model: "gpt-4o-mini" });
  });

  it("merges client.providerModules into the context args (subprocess forwarding)", () => {
    const result = applyRuntimeConfigOverridesToContextArgs(
      {
        statelogConfig: {
          host: "",
          apiKey: "",
          projectId: "",
          debugMode: false,
          observability: false,
        },
        smoltalkDefaults: {},
        providerModules: ["/baked/a.mjs"],
        dirname: "/project",
      },
      { client: { providerModules: ["/abs/parent.mjs"] } },
    );

    expect(result.providerModules).toEqual([
      "/baked/a.mjs",
      "/abs/parent.mjs",
    ]);
  });

  it("leaves providerModules untouched when overrides carry none", () => {
    const result = applyRuntimeConfigOverridesToContextArgs(
      {
        statelogConfig: {
          host: "",
          apiKey: "",
          projectId: "",
          debugMode: false,
          observability: false,
        },
        smoltalkDefaults: {},
        providerModules: ["/baked/a.mjs"],
        dirname: "/project",
      },
      { observability: true },
    );

    expect(result.providerModules).toEqual(["/baked/a.mjs"]);
  });
});

describe("applyRuntimeConfigOverridesToContextArgs — trace overrides", () => {
  const baseArgs = () => ({
    statelogConfig: {
      host: "https://kept",
      apiKey: "",
      projectId: "",
      debugMode: true,
      observability: false,
    },
    smoltalkDefaults: {},
    dirname: "/project",
    traceConfig: { program: "agent" },
  });

  it("folds an override traceFile and preserves traceConfig.program", () => {
    const r = applyRuntimeConfigOverridesToContextArgs(baseArgs(), {
      trace: true,
      traceFile: "/t.agencytrace",
    });
    expect(r.traceConfig?.traceFile).toBe("/t.agencytrace");
    expect(r.traceConfig?.program).toBe("agent");
  });

  it("folds an override traceDir", () => {
    const r = applyRuntimeConfigOverridesToContextArgs(baseArgs(), {
      trace: true,
      traceDir: "/traces",
    });
    expect(r.traceConfig?.traceDir).toBe("/traces");
  });

  it("an override traceDir clears a baked traceFile so the dir takes effect", () => {
    const baked = { ...baseArgs(), traceConfig: { program: "agent", traceFile: "baked.trace" } };
    const r = applyRuntimeConfigOverridesToContextArgs(baked, {
      trace: true,
      traceDir: "/x",
    });
    expect(r.traceConfig?.traceFile).toBeUndefined();
    expect(r.traceConfig?.traceDir).toBe("/x");
  });

  it("applies trace + statelog overrides together, keeping statelog siblings", () => {
    const r = applyRuntimeConfigOverridesToContextArgs(baseArgs(), {
      trace: true,
      traceFile: "/t",
      observability: true,
      log: { logFile: "/l" },
    });
    expect(r.traceConfig?.traceFile).toBe("/t");
    expect(r.statelogConfig.logFile).toBe("/l");
    expect(r.statelogConfig.observability).toBe(true);
    expect(r.statelogConfig.host).toBe("https://kept");
  });

  it("is a no-op when overrides are empty/undefined", () => {
    expect(applyRuntimeConfigOverridesToContextArgs(baseArgs(), {}).traceConfig?.traceFile).toBeUndefined();
    expect(applyRuntimeConfigOverridesToContextArgs(baseArgs(), undefined).traceConfig?.program).toBe("agent");
  });
});

describe("RuntimeContext honors AGENCY_CONFIG_OVERRIDES at construction", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads the env override into statelogConfig", () => {
    process.env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides({
      observability: true,
      log: { logFile: "/tmp/wired.jsonl" },
    });
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: "/project",
    });
    const sc = (ctx as unknown as {
      statelogConfig: { logFile?: string; observability?: boolean };
    }).statelogConfig;
    expect(sc.logFile).toBe("/tmp/wired.jsonl");
    expect(sc.observability).toBe(true);
  });

  it("still applies the env override when an IPC override is also present (both transports layer)", () => {
    process.env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides({
      observability: true,
      log: { logFile: "/tmp/tree.jsonl" },
    });
    // A subprocess launched with explicit IPC overrides (e.g. an eval run) must
    // NOT drop out of the env-based statelog tree.
    setRuntimeConfigOverrides({ maxCallDepth: 7 });
    try {
      const ctx = new RuntimeContext({
        statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
        smoltalkDefaults: {},
        dirname: "/project",
      });
      const sc = (ctx as unknown as {
        statelogConfig: { logFile?: string; observability?: boolean };
      }).statelogConfig;
      expect(sc.logFile).toBe("/tmp/tree.jsonl");
      expect(sc.observability).toBe(true);
    } finally {
      setRuntimeConfigOverrides(undefined);
    }
  });
});

describe("writer→reader override contract", () => {
  it("agentConfigOverride output applies cleanly through the runtime merge", () => {
    const base = {
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: "/p",
      traceConfig: { program: "agent" },
    };
    // The exact object runBundledAgent serializes into AGENCY_CONFIG_OVERRIDES.
    const overrides = agentConfigOverride(["--trace", "t.trace", "--log-file", "l.jsonl"]);
    const r = applyRuntimeConfigOverridesToContextArgs(base, overrides);
    expect(r.traceConfig?.traceFile).toBe("t.trace");
    expect(r.statelogConfig.logFile).toBe("l.jsonl");
  });
});
