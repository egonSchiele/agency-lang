import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveAgencyAgentPath,
  runAgencyAgent,
  type RunAgencyAgentDeps,
} from "./runAgencyAgent.js";

describe("runAgencyAgent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-agency-agent-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves ordinary agent paths relative to cwd", () => {
    const agentPath = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentPath, "node main() {}\n");

    expect(resolveAgencyAgentPath("agent.agency", tmpDir)).toBe(agentPath);
  });

  it("resolves bundled agent names", () => {
    expect(resolveAgencyAgentPath("judgePairwise.agency")).toMatch(
      /lib\/agents\/judgePairwise\.agency$/,
    );
  });

  it("passes args, statelog config, limits, hooks, and argv to the execution boundary", async () => {
    const agentPath = path.join(tmpDir, "agent.agency");
    const statelogPath = path.join(tmpDir, "statelog.jsonl");
    fs.writeFileSync(agentPath, "node main(value: string) { return value }\n");
    const executeNodeAsync = vi.fn(async () => ({
      data: { ok: true },
      stdout: "out",
      stderr: "err",
    }));
    const deps: RunAgencyAgentDeps = { executeNodeAsync };
    const interruptHandlers = [{ action: "approve" as const }];
    const llmMocks = [{ return: "mocked" }];

    const result = await runAgencyAgent({
      agent: "agent.agency",
      node: "main",
      args: { value: "hello" },
      config: { client: { defaultModel: "gpt-test" } },
      cwd: tmpDir,
      scratchDir: tmpDir,
      statelogPath,
      limits: { wallClockMs: 1234, stdoutBytes: 2048 },
      interruptHandlers,
      llmMocks,
      useTestLLMProvider: true,
      argv: ["--flag"],
    }, deps);

    expect(result).toEqual({
      data: { ok: true },
      stdout: "out",
      stderr: "err",
      statelogPath,
    });
    expect(executeNodeAsync).toHaveBeenCalledWith({
      config: {
        client: { defaultModel: "gpt-test" },
        observability: true,
        log: { logFile: statelogPath },
      },
      agencyFile: agentPath,
      nodeName: "main",
      hasArgs: true,
      argsString: "\"hello\"",
      interruptHandlers,
      timeoutMs: 1234,
      maxBufferBytes: 2048,
      llmMocks,
      useTestLLMProvider: true,
      argv: ["--flag"],
      scratchDir: tmpDir,
    });
  });

  it("rejects unsupported policy fields explicitly", async () => {
    const agentPath = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentPath, "node main() {}\n");

    await expect(runAgencyAgent({
      agent: agentPath,
      node: "main",
      args: {},
      config: {},
      policy: { allowedTools: ["read"] },
    })).rejects.toThrow(/policy\.allowedTools is not supported/);
  });
});
