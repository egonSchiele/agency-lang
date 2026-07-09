import { afterEach, describe, expect, it } from "vitest";

import {
  applyEnvOverridesToContextArgs,
  applyRuntimeConfigOverridesToContextArgs,
  DEBUG_ENV_VARS,
} from "./configOverrides.js";
import { RuntimeContext } from "./state/context.js";
import { agentDebugFlagsToEnv } from "../cli/runBundledAgent.js";

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

describe("applyEnvOverridesToContextArgs", () => {
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

  it("folds AGENCY_LOG_FILE into statelog, enables observability, keeps siblings", () => {
    const r = applyEnvOverridesToContextArgs(baseArgs(), {
      [DEBUG_ENV_VARS.logFile]: "/tmp/a.jsonl",
    });
    expect(r.statelogConfig.logFile).toBe("/tmp/a.jsonl");
    expect(r.statelogConfig.observability).toBe(true);
    expect(r.statelogConfig.host).toBe("https://kept");
    expect(r.statelogConfig.debugMode).toBe(true);
  });

  it("folds trace file/dir and preserves traceConfig.program", () => {
    const rf = applyEnvOverridesToContextArgs(baseArgs(), {
      [DEBUG_ENV_VARS.traceFile]: "/t.agencytrace",
    });
    expect(rf.traceConfig?.traceFile).toBe("/t.agencytrace");
    expect(rf.traceConfig?.program).toBe("agent");
    const rd = applyEnvOverridesToContextArgs(baseArgs(), {
      [DEBUG_ENV_VARS.traceDir]: "/traces",
    });
    expect(rd.traceConfig?.traceDir).toBe("/traces");
  });

  it("env wins over a baked traceConfig.traceFile", () => {
    const baked = { ...baseArgs(), traceConfig: { program: "agent", traceFile: "baked" } };
    const r = applyEnvOverridesToContextArgs(baked, { [DEBUG_ENV_VARS.traceFile]: "env" });
    expect(r.traceConfig?.traceFile).toBe("env");
  });

  it("handles an absent traceConfig", () => {
    const noTrace = {
      statelogConfig: baseArgs().statelogConfig,
      smoltalkDefaults: {},
      dirname: "/p",
    };
    const r = applyEnvOverridesToContextArgs(noTrace, { [DEBUG_ENV_VARS.traceFile]: "/t" });
    expect(r.traceConfig?.traceFile).toBe("/t");
  });

  it("applies both trace and log env at once", () => {
    const r = applyEnvOverridesToContextArgs(baseArgs(), {
      [DEBUG_ENV_VARS.traceFile]: "/t",
      [DEBUG_ENV_VARS.logFile]: "/l",
    });
    expect(r.traceConfig?.traceFile).toBe("/t");
    expect(r.statelogConfig.logFile).toBe("/l");
  });

  it("is a no-op when no env keys are set", () => {
    const r = applyEnvOverridesToContextArgs(baseArgs(), {});
    expect(r.statelogConfig.logFile).toBeUndefined();
    expect(r.traceConfig?.traceFile).toBeUndefined();
  });
});

describe("RuntimeContext honors debug env vars", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads AGENCY_LOG_FILE into statelogConfig at construction", () => {
    process.env[DEBUG_ENV_VARS.logFile] = "/tmp/wired.jsonl";
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
});

describe("writer→reader env contract", () => {
  it("agentDebugFlagsToEnv output lands in context args via applyEnvOverridesToContextArgs", () => {
    const base = {
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: "/p",
      traceConfig: { program: "agent" },
    };
    const env = agentDebugFlagsToEnv(["--trace", "t.trace", "--log-file", "l.jsonl"]);
    const r = applyEnvOverridesToContextArgs(base, env);
    expect(r.traceConfig?.traceFile).toBe("t.trace");
    expect(r.statelogConfig.logFile).toBe("l.jsonl");
  });
});
