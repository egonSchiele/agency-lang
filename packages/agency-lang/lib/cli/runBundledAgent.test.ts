import { afterEach, describe, expect, it, vi } from "vitest";

// Force the precompiled-file branch so runBundledAgent never invokes the
// compiler; spawn is injected, so nothing actually launches.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: () => true };
});

import { agentDebugFlagsToEnv, runBundledAgent } from "./runBundledAgent.js";

describe("agentDebugFlagsToEnv", () => {
  it("--trace <file> → AGENCY_TRACE_FILE", () => {
    expect(agentDebugFlagsToEnv(["--trace", "out.agencytrace"])).toEqual({
      AGENCY_TRACE_FILE: "out.agencytrace",
    });
  });
  it("--trace=<file> attached form", () => {
    expect(agentDebugFlagsToEnv(["--trace=x.trace"])).toEqual({
      AGENCY_TRACE_FILE: "x.trace",
    });
  });
  it("bare --trace → AGENCY_TRACE_DIR=.", () => {
    expect(agentDebugFlagsToEnv(["--trace"])).toEqual({ AGENCY_TRACE_DIR: "." });
  });
  it("--trace followed by a single-dash token is bare (not a file named -p)", () => {
    expect(agentDebugFlagsToEnv(["--trace", "-p"])).toEqual({ AGENCY_TRACE_DIR: "." });
  });
  it("--log-file <path> and attached form", () => {
    expect(agentDebugFlagsToEnv(["--log-file", "l.jsonl"])).toEqual({
      AGENCY_LOG_FILE: "l.jsonl",
    });
    expect(agentDebugFlagsToEnv(["--log-file=l.jsonl"])).toEqual({
      AGENCY_LOG_FILE: "l.jsonl",
    });
  });
  it("bare --log-file yields nothing (no optional value)", () => {
    expect(agentDebugFlagsToEnv(["--log-file"])).toEqual({});
  });
  it("stops scanning at the -- terminator", () => {
    expect(agentDebugFlagsToEnv(["--", "--trace", "x"])).toEqual({});
  });
  it("last flag wins on repeats", () => {
    expect(agentDebugFlagsToEnv(["--trace", "a", "--trace", "b"])).toEqual({
      AGENCY_TRACE_FILE: "b",
    });
  });
  it("combines both and ignores unrelated args", () => {
    expect(agentDebugFlagsToEnv(["hi", "--trace", "t", "--log-file", "l"])).toEqual({
      AGENCY_TRACE_FILE: "t",
      AGENCY_LOG_FILE: "l",
    });
  });
  it("empty when neither present", () => {
    expect(agentDebugFlagsToEnv(["--print", "do it"])).toEqual({});
  });
});

describe("runBundledAgent passes the translated env to spawn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes AGENCY_TRACE_FILE / AGENCY_LOG_FILE in the child env", () => {
    const onMock = vi.fn();
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: onMock }) as never);

    runBundledAgent({}, "agency-agent", ["--trace", "t.trace", "--log-file", "l.jsonl"], {
      spawn: spawnMock as never,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnOptions = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AGENCY_TRACE_FILE).toBe("t.trace");
    expect(spawnOptions.env.AGENCY_LOG_FILE).toBe("l.jsonl");
    // Parent env is preserved (spread), so PATH survives.
    expect(spawnOptions.env.PATH).toBe(process.env.PATH);
  });
});
