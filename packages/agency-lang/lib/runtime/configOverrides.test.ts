import { describe, expect, it } from "vitest";

import { applyRuntimeConfigOverridesToContextArgs } from "./configOverrides.js";

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
