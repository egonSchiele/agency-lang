import { afterEach, describe, expect, it, vi } from "vitest";

// Force the precompiled-file branch so runBundledAgent never invokes the
// compiler; spawn is injected, so nothing actually launches.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: () => true };
});

import { CONFIG_OVERRIDES_ENV } from "@/config.js";
import { agentConfigOverride, runBundledAgent } from "./runBundledAgent.js";

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
  it("bare --log-file (or one followed by a flag) is ignored, not a file named --print", () => {
    expect(agentConfigOverride(["--log-file"])).toEqual({});
    expect(agentConfigOverride(["--log-file", "--print"])).toEqual({});
  });
  it("--log-file <path> → log.logFile + observability, space and attached forms", () => {
    const expected = { log: { logFile: "l.jsonl" }, observability: true };
    expect(agentConfigOverride(["--log-file", "l.jsonl"])).toEqual(expected);
    expect(agentConfigOverride(["--log-file=l.jsonl"])).toEqual(expected);
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
      agentConfigOverride(["--model", "gpt", "hi", "--trace", "t", "--log-file", "l"]),
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

describe("runBundledAgent passes config overrides to the child via env", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes the override into AGENCY_CONFIG_OVERRIDES", () => {
    const onMock = vi.fn();
    const spawnMock = vi.fn((..._args: unknown[]) => ({ on: onMock }) as never);

    runBundledAgent({}, "agency-agent", ["--trace", "t.trace", "--log-file", "l.jsonl"], {
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
});
