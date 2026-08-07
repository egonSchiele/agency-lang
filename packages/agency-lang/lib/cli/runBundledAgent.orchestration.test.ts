import { EventEmitter } from "events";
import { describe, expect, test, vi } from "vitest";
import {
  runBundledAgent,
  type RunBundledAgentDependencies,
} from "./runBundledAgent.js";

/** A launcher harness with every dependency injected: no filesystem, no
 *  compiler, no real processes. The stage registers no exit listener, so
 *  listener-count coverage lives in stageConfiguredAgent.test.ts against the
 *  real staging. */
function makeLaunchHarness(options: { spawnError?: Error } = {}) {
  const agentDir = "/bundle/agency-agent";
  const precompiledFile = `${agentDir}/agent.js`;
  const runFile = "/owned-temp/agency-agent-1/agent.js";
  const child = new EventEmitter();
  const cleanup = vi.fn();
  const stage = vi.fn(() => ({ runFile, cleanup }));
  const calls: string[][] = [];
  const spawn = vi.fn((_command: string, argv: string[]) => {
    if (options.spawnError !== undefined) {
      throw options.spawnError;
    }
    calls.push(argv);
    return child;
  });
  const dependencies: RunBundledAgentDependencies = {
    resolveAgentDir: (agentName) => {
      expect(agentName).toBe("agency-agent");
      return agentDir;
    },
    fileExists: (file) => file === precompiledFile,
    stageConfiguredAgent: stage as never,
    compile: vi.fn(() => "/compiled/agent.js") as never,
    spawn: spawn as never,
    exit: vi.fn(),
  };
  return {
    config: {},
    agentDir,
    precompiledFile,
    child,
    cleanup,
    stage,
    deps: dependencies,
    get spawned() {
      const argv = calls.at(-1) ?? [];
      const fileIndex = argv.findIndex((argument) => argument.endsWith("agent.js"));
      return {
        runFile: argv[fileIndex],
        forwardedArgs: fileIndex === -1 ? [] : argv.slice(fileIndex + 1),
      };
    },
  };
}

describe("runBundledAgent config selection and cleanup", () => {
  test.each(["exit", "error"])("forwarded config selects staging; cleanup on %s", (event) => {
    const harness = makeLaunchHarness();
    const forwarded = ["-p", "hi", "--config", "child.json"];
    const errorSilencer = vi.spyOn(console, "error").mockImplementation(() => {});
    runBundledAgent(
      harness.config,
      "agency-agent",
      forwarded,
      { explicitConfigPath: "root.json" },
      harness.deps,
    );
    // Forwarded --config beats the root value.
    expect(harness.stage).toHaveBeenCalledWith("child.json", harness.agentDir);
    expect(harness.spawned.runFile).toBe("/owned-temp/agency-agent-1/agent.js");
    expect(harness.spawned.forwardedArgs).toEqual(forwarded);
    harness.child.emit(event, event === "error" ? new Error("boom") : 0);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    errorSilencer.mockRestore();
  });

  test("no config selects the shipped precompiled agent without staging", () => {
    const harness = makeLaunchHarness();
    runBundledAgent(harness.config, "agency-agent", ["--help"], {}, harness.deps);
    expect(harness.stage).not.toHaveBeenCalled();
    expect(harness.spawned.runFile).toBe(harness.precompiledFile);
  });

  test("root config alone selects the staged runFile and preserves forwarded argv", () => {
    const harness = makeLaunchHarness();
    const forwarded = ["-p", "hi"];
    runBundledAgent(
      harness.config,
      "agency-agent",
      forwarded,
      { explicitConfigPath: "root.json" },
      harness.deps,
    );
    expect(harness.stage).toHaveBeenCalledWith("root.json", harness.agentDir);
    expect(harness.spawned.forwardedArgs).toEqual(forwarded);
  });

  test("synchronous spawn throw cleans exactly once", () => {
    const harness = makeLaunchHarness({ spawnError: new Error("sync") });
    expect(() =>
      runBundledAgent(
        harness.config,
        "agency-agent",
        [],
        { explicitConfigPath: "root.json" },
        harness.deps,
      ),
    ).toThrow("sync");
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
  });

  test.each([
    { forwarded: ["--max-time", "bogus"], message: /max-time/i },
    { forwarded: ["--max-cost", "bogus"], message: /max-cost/i },
  ])("invalid budget exits before staging or spawn: $forwarded", ({ forwarded, message }) => {
    const harness = makeLaunchHarness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runBundledAgent(harness.config, "agency-agent", forwarded, {}, harness.deps);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(harness.deps.exit).toHaveBeenCalledWith(2);
    expect(harness.stage).not.toHaveBeenCalled();
    expect(harness.deps.spawn).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
