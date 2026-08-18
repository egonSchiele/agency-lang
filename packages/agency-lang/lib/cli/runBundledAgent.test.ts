import { afterEach, describe, expect, it, test, vi } from "vitest";

// Force the precompiled-file branch so runBundledAgent never invokes the
// compiler; spawn is injected, so nothing actually launches.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: () => true };
});

import { CONFIG_OVERRIDES_ENV } from "@/config.js";
import * as path from "path";
import { resolveAgentLaunchArgs, runBundledAgent } from "./runBundledAgent.js";

describe("resolveAgentLaunchArgs: trace/log → configOverrides", () => {
  it("--trace <file> → traceFile", () => {
    expect(resolveAgentLaunchArgs(["--trace", "out.agencytrace"]).configOverrides).toEqual({
      trace: true,
      traceFile: "out.agencytrace",
    });
  });
  it("--trace=<file> attached form", () => {
    expect(resolveAgentLaunchArgs(["--trace=x.trace"]).configOverrides).toEqual({
      trace: true,
      traceFile: "x.trace",
    });
  });
  it("bare --trace → per-run dir (traceDir)", () => {
    expect(resolveAgentLaunchArgs(["--trace"]).configOverrides).toEqual({
      trace: true,
      traceDir: ".",
    });
  });
  it("empty --trace= behaves identically to bare --trace (the divergence bug)", () => {
    expect(resolveAgentLaunchArgs(["--trace="]).configOverrides).toEqual({
      trace: true,
      traceDir: ".",
    });
  });
  it("a following flag is NOT consumed as the --trace value (matches std::args)", () => {
    expect(resolveAgentLaunchArgs(["--trace", "--print", "hi"]).configOverrides).toEqual({
      trace: true,
      traceDir: ".",
    });
    expect(resolveAgentLaunchArgs(["--trace", "-p"]).configOverrides).toEqual({
      trace: true,
      traceDir: ".",
    });
  });
  it("bare --log (or one followed by a flag) → default log.jsonl", () => {
    const expected = { log: { logFile: "log.jsonl" }, observability: true };
    expect(resolveAgentLaunchArgs(["--log"]).configOverrides).toEqual(expected);
    expect(resolveAgentLaunchArgs(["--log", "--print"]).configOverrides).toEqual(expected);
  });
  it("--log <path> → log.logFile + observability, space and attached forms", () => {
    const expected = { log: { logFile: "l.jsonl" }, observability: true };
    expect(resolveAgentLaunchArgs(["--log", "l.jsonl"]).configOverrides).toEqual(expected);
    expect(resolveAgentLaunchArgs(["--log=l.jsonl"]).configOverrides).toEqual(expected);
  });
  it("--log stdout (any case) → log.host=stdout, blanks the file sink", () => {
    const expected = { log: { host: "stdout", logFile: "" }, observability: true };
    expect(resolveAgentLaunchArgs(["--log", "stdout"]).configOverrides).toEqual(expected);
    expect(resolveAgentLaunchArgs(["--log", "STDOUT"]).configOverrides).toEqual(expected);
    expect(resolveAgentLaunchArgs(["--log=stdout"]).configOverrides).toEqual(expected);
  });
  it("stops at the -- terminator", () => {
    expect(resolveAgentLaunchArgs(["--", "--trace", "x"]).configOverrides).toEqual({});
  });
  it("last --trace wins on repeats", () => {
    expect(resolveAgentLaunchArgs(["--trace", "a", "--trace", "b"]).configOverrides).toEqual({
      trace: true,
      traceFile: "b",
    });
  });
  it("combines trace + log and ignores the agent's own flags/positionals", () => {
    expect(
      resolveAgentLaunchArgs(["--model", "gpt", "hi", "--trace", "t", "--log", "l"])
        .configOverrides,
    ).toEqual({
      trace: true,
      traceFile: "t",
      log: { logFile: "l" },
      observability: true,
    });
  });
  it("empty when neither flag is present", () => {
    expect(resolveAgentLaunchArgs(["--print", "do it"]).configOverrides).toEqual({});
  });
});

describe("resolveAgentLaunchArgs: agent-home", () => {
  it("--agent-home <dir> → absolute path, space and attached forms", () => {
    expect(resolveAgentLaunchArgs(["--agent-home", "/x/home"]).agentHome).toBe("/x/home");
    expect(resolveAgentLaunchArgs(["--agent-home=/x/home"]).agentHome).toBe("/x/home");
  });
  it("resolves a relative dir against cwd", () => {
    expect(resolveAgentLaunchArgs(["--agent-home", "rel"]).agentHome).toBe(path.resolve("rel"));
  });
  it("bare --agent-home (or one followed by a flag) is ignored", () => {
    expect(resolveAgentLaunchArgs(["--agent-home"]).agentHome).toBeNull();
    expect(resolveAgentLaunchArgs(["--agent-home", "--print"]).agentHome).toBeNull();
    expect(resolveAgentLaunchArgs(["--agent-home="]).agentHome).toBeNull();
  });
  it("null when the flag is absent, stops at the -- terminator", () => {
    expect(resolveAgentLaunchArgs(["--print", "hi"]).agentHome).toBeNull();
    expect(resolveAgentLaunchArgs(["--", "--agent-home", "/x"]).agentHome).toBeNull();
  });
});

describe("resolveAgentLaunchArgs: --config", () => {
  it("config path extracted from anywhere in the tail", () => {
    expect(resolveAgentLaunchArgs(["--config", "prod.json", "-p", "hi"]).configPath).toBe(
      "prod.json",
    );
    expect(resolveAgentLaunchArgs(["-p", "hi", "--config=prod.json"]).configPath).toBe("prod.json");
    expect(resolveAgentLaunchArgs(["-p", "hi"]).configPath).toBeUndefined();
  });
  test.each([
    [["--config"]],
    [["--config", "--help"]],
    [["--config", "-p", "hi"]],
    [["--", "--config", "x.json"]],
  ])("required config value is not greedy: %j", (args) => {
    expect(resolveAgentLaunchArgs(args).configPath).toBeUndefined();
  });
});

describe("resolveAgentLaunchArgs: budget required-value semantics", () => {
  test.each([
    [["--max-cost"], {}],
    [["--max-time", "--help"], {}],
    [["--max-cost", "-p", "hi"], {}],
    [["--max-cost=5"], { maxCost: "5" }],
    [["--max-cost", "-5"], { maxCost: "-5" }],
    [["--max-time", "-2"], { maxTime: "-2" }],
    [["--", "--max-cost", "5"], {}],
    [["-p", "hi", "--max-cost", "5"], { maxCost: "5" }],
  ])("pre-scan required-value semantics: %j", (raw, budget) => {
    const before = [...raw];
    const resolved = resolveAgentLaunchArgs(raw).budgetInput;
    expect(resolved.maxCost).toBe((budget as { maxCost?: string }).maxCost);
    expect(resolved.maxTime).toBe((budget as { maxTime?: string }).maxTime);
    expect(raw).toEqual(before);
  });
});

describe("runBundledAgent passes config overrides to the child via env", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("serializes the override into AGENCY_CONFIG_OVERRIDES", () => {
    const onMock = vi.fn();
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: onMock }) as never);

    runBundledAgent(
      {},
      "agency-agent",
      ["--trace", "t.trace", "--log", "l.jsonl"],
      {},
      {
        spawn: spawnMock as never,
      },
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    const overrides = JSON.parse(opts.env[CONFIG_OVERRIDES_ENV]);
    expect(overrides).toEqual({
      trace: true,
      traceFile: "t.trace",
      log: { logFile: "l.jsonl", code: expect.objectContaining({ entry: "agent.agency" }) },
      observability: true,
    });
    // Parent env is preserved (spread), so PATH survives.
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it("merges onto inherited overrides: --trace keeps the harness statelog path", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    vi.stubEnv(
      CONFIG_OVERRIDES_ENV,
      JSON.stringify({ observability: true, log: { logFile: "harness.jsonl" } }),
    );

    runBundledAgent({}, "agency-agent", ["--trace", "t.trace"], {}, { spawn: spawnMock as never });

    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(JSON.parse(opts.env[CONFIG_OVERRIDES_ENV])).toEqual({
      observability: true,
      // inherited logFile survives; the launcher adds which code is running
      log: { logFile: "harness.jsonl", code: expect.objectContaining({ entry: "agent.agency" }) },
      trace: true,
      traceFile: "t.trace",
    });
  });

  it("an explicit --log still wins the logFile key (user intent); the rest of the inherited overrides survive", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    vi.stubEnv(
      CONFIG_OVERRIDES_ENV,
      JSON.stringify({ observability: true, log: { logFile: "harness.jsonl" } }),
    );

    runBundledAgent(
      {},
      "agency-agent",
      ["--log", "other.jsonl"],
      {},
      { spawn: spawnMock as never },
    );

    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    const overrides = JSON.parse(opts.env[CONFIG_OVERRIDES_ENV]);
    expect(overrides.log.logFile).toBe("other.jsonl");
    expect(overrides.observability).toBe(true);
  });

  it("the launcher's own code identity replaces an inherited log.code: a trace never names another program", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    vi.stubEnv(
      CONFIG_OVERRIDES_ENV,
      JSON.stringify({
        log: {
          logFile: "harness.jsonl",
          code: { entry: "other.agency", closureHash: "stale", closure: [] },
        },
      }),
    );

    runBundledAgent({}, "agency-agent", [], {}, { spawn: spawnMock as never });

    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    const overrides = JSON.parse(opts.env[CONFIG_OVERRIDES_ENV]);
    expect(overrides.log.code.entry).toBe("agent.agency");
    expect(overrides.log.code.closureHash).not.toBe("stale");
    expect(overrides.log.logFile).toBe("harness.jsonl");
  });

  it("sets AGENCY_MAX_COST/AGENCY_MAX_TIME from the forwarded flags and clears stale ones", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    vi.stubEnv("AGENCY_MAX_COST", "999");
    vi.stubEnv("AGENCY_MAX_TIME", "999999");

    runBundledAgent(
      {},
      "agency-agent",
      ["--print", "hi", "--max-cost", "0.5"],
      {},
      {
        spawn: spawnMock as never,
      },
    );

    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.AGENCY_MAX_COST).toBe("0.5");
    // No --max-time given: the stale inherited value must be CLEARED,
    // not passed through — the env is an internal carrier, not a knob.
    expect(opts.env.AGENCY_MAX_TIME).toBeUndefined();
  });

  it("clears both budget env vars when no budget flags are forwarded", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    vi.stubEnv("AGENCY_MAX_COST", "999");
    vi.stubEnv("AGENCY_MAX_TIME", "999999");

    runBundledAgent(
      {},
      "agency-agent",
      ["--print", "hi"],
      {},
      {
        spawn: spawnMock as never,
      },
    );

    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.AGENCY_MAX_COST).toBeUndefined();
    expect(opts.env.AGENCY_MAX_TIME).toBeUndefined();
  });

  test.each([
    { forwarded: ["--max-time", "bogus"], message: /max-time/i },
    { forwarded: ["--max-cost", "bogus"], message: /max-cost/i },
  ])("invalid budget exits before spawn: $forwarded", ({ forwarded, message }) => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    const exitMock = vi.fn();
    const errorMock = vi.spyOn(console, "error").mockImplementation(() => {});

    runBundledAgent(
      {},
      "agency-agent",
      forwarded,
      {},
      {
        spawn: spawnMock as never,
        exit: exitMock,
      },
    );

    expect(errorMock).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(exitMock).toHaveBeenCalledWith(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("always records which code is running, even with no debug flags", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    runBundledAgent({}, "agency-agent", ["--print", "hi"], {}, { spawn: spawnMock as never });
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    const overrides = JSON.parse(opts.env[CONFIG_OVERRIDES_ENV]);
    expect(Object.keys(overrides)).toEqual(["log"]);
    expect(overrides.log.code.entry).toBe("agent.agency");
    expect(overrides.log.code.closureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(overrides.log.code.closure.map((file: { file: string }) => file.file)).toContain(
      "agent.agency",
    );
  });

  it("--agent-home sets AGENCY_AGENT_HOME in the child env, beating an inherited value", () => {
    vi.stubEnv("AGENCY_AGENT_HOME", "/from/env");
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    runBundledAgent(
      {},
      "agency-agent",
      ["--agent-home", "/from/flag", "hi"],
      {},
      {
        spawn: spawnMock as never,
      },
    );
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.AGENCY_AGENT_HOME).toBe("/from/flag");
  });

  it("without the flag, an inherited AGENCY_AGENT_HOME passes through untouched", () => {
    vi.stubEnv("AGENCY_AGENT_HOME", "/from/env");
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    runBundledAgent({}, "agency-agent", ["hi"], {}, { spawn: spawnMock as never });
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.AGENCY_AGENT_HOME).toBe("/from/env");
  });

  it("the child receives the ORIGINAL argv, budget flags included", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    const forwarded = ["-p", "hi", "--max-cost", "0.5"];
    runBundledAgent({}, "agency-agent", forwarded, {}, { spawn: spawnMock as never });
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.slice(-4)).toEqual(forwarded);
  });
});
