import { afterEach, describe, expect, it, vi } from "vitest";

// Force the precompiled-file branch so runBundledAgent never invokes the
// compiler; spawn is injected, so nothing actually launches.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: () => true };
});

import { CONFIG_OVERRIDES_ENV } from "@/config.js";
import * as path from "path";
import {
  agentConfigOverride,
  agentHomeOverride,
  runBundledAgent,
} from "./runBundledAgent.js";

describe("agentConfigOverride", () => {
  it("--trace <file> → traceFile", () => {
    expect(agentConfigOverride(["--trace", "out.agencytrace"])).toEqual({
      trace: true,
      traceFile: "out.agencytrace",
    });
  });
  it("--trace=<file> attached form", () => {
    expect(agentConfigOverride(["--trace=x.trace"])).toEqual({
      trace: true,
      traceFile: "x.trace",
    });
  });
  it("bare --trace → per-run dir (traceDir)", () => {
    expect(agentConfigOverride(["--trace"])).toEqual({ trace: true, traceDir: "." });
  });
  it("empty --trace= behaves identically to bare --trace (the divergence bug)", () => {
    expect(agentConfigOverride(["--trace="])).toEqual({ trace: true, traceDir: "." });
  });
  it("a following flag is NOT consumed as the --trace value (matches std::args)", () => {
    // Both are bare on the agent side, so they must be bare here too — not a
    // trace file named "--print" / "-p".
    expect(agentConfigOverride(["--trace", "--print", "hi"])).toEqual({
      trace: true,
      traceDir: ".",
    });
    expect(agentConfigOverride(["--trace", "-p"])).toEqual({ trace: true, traceDir: "." });
  });
  it("bare --log (or one followed by a flag) → default log.jsonl, not a file named --print", () => {
    const expected = { log: { logFile: "log.jsonl" }, observability: true };
    expect(agentConfigOverride(["--log"])).toEqual(expected);
    expect(agentConfigOverride(["--log", "--print"])).toEqual(expected);
  });
  it("--log <path> → log.logFile + observability, space and attached forms", () => {
    const expected = { log: { logFile: "l.jsonl" }, observability: true };
    expect(agentConfigOverride(["--log", "l.jsonl"])).toEqual(expected);
    expect(agentConfigOverride(["--log=l.jsonl"])).toEqual(expected);
  });
  it("--log stdout (any case) → log.host=stdout, blanks the file sink, + observability", () => {
    // logFile: "" so stdout overrides an agency.json logFile at merge time.
    const expected = { log: { host: "stdout", logFile: "" }, observability: true };
    expect(agentConfigOverride(["--log", "stdout"])).toEqual(expected);
    expect(agentConfigOverride(["--log", "STDOUT"])).toEqual(expected);
    expect(agentConfigOverride(["--log=stdout"])).toEqual(expected);
  });
  it("stops at the -- terminator", () => {
    expect(agentConfigOverride(["--", "--trace", "x"])).toEqual({});
  });
  it("last --trace wins on repeats", () => {
    expect(agentConfigOverride(["--trace", "a", "--trace", "b"])).toEqual({
      trace: true,
      traceFile: "b",
    });
  });
  it("combines trace + log and ignores the agent's own flags/positionals", () => {
    expect(
      agentConfigOverride(["--model", "gpt", "hi", "--trace", "t", "--log", "l"]),
    ).toEqual({
      trace: true,
      traceFile: "t",
      log: { logFile: "l" },
      observability: true,
    });
  });
  it("empty when neither flag is present", () => {
    expect(agentConfigOverride(["--print", "do it"])).toEqual({});
  });
});

describe("agentHomeOverride", () => {
  it("--agent-home <dir> → absolute path, space and attached forms", () => {
    expect(agentHomeOverride(["--agent-home", "/x/home"])).toBe("/x/home");
    expect(agentHomeOverride(["--agent-home=/x/home"])).toBe("/x/home");
  });
  it("resolves a relative dir against cwd", () => {
    expect(agentHomeOverride(["--agent-home", "rel"])).toBe(
      path.resolve("rel"),
    );
  });
  it("bare --agent-home (or one followed by a flag) is ignored, not a dir named --print", () => {
    expect(agentHomeOverride(["--agent-home"])).toBeNull();
    expect(agentHomeOverride(["--agent-home", "--print"])).toBeNull();
    expect(agentHomeOverride(["--agent-home="])).toBeNull();
  });
  it("null when the flag is absent, stops at the -- terminator", () => {
    expect(agentHomeOverride(["--print", "hi"])).toBeNull();
    expect(agentHomeOverride(["--", "--agent-home", "/x"])).toBeNull();
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

    runBundledAgent({}, "agency-agent", ["--trace", "t.trace", "--log", "l.jsonl"], {
      spawn: spawnMock as never,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    const overrides = JSON.parse(opts.env[CONFIG_OVERRIDES_ENV]);
    expect(overrides).toEqual({
      trace: true,
      traceFile: "t.trace",
      log: { logFile: "l.jsonl" },
      observability: true,
    });
    // Parent env is preserved (spread), so PATH survives.
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it("does not set the env var when no debug flags are present", () => {
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    runBundledAgent({}, "agency-agent", ["--print", "hi"], { spawn: spawnMock as never });
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env[CONFIG_OVERRIDES_ENV]).toBeUndefined();
  });

  it("--agent-home sets AGENCY_AGENT_HOME in the child env, beating an inherited value", () => {
    vi.stubEnv("AGENCY_AGENT_HOME", "/from/env");
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    runBundledAgent({}, "agency-agent", ["--agent-home", "/from/flag", "hi"], {
      spawn: spawnMock as never,
    });
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.AGENCY_AGENT_HOME).toBe("/from/flag");
  });

  it("without the flag, an inherited AGENCY_AGENT_HOME passes through untouched", () => {
    vi.stubEnv("AGENCY_AGENT_HOME", "/from/env");
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }) as never);
    runBundledAgent({}, "agency-agent", ["hi"], { spawn: spawnMock as never });
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.AGENCY_AGENT_HOME).toBe("/from/env");
  });
});
