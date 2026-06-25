import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalRunLoadedInputs } from "./run.js";

describe("evalRunLoadedInputs compiles + runs inside each input workdir", () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "evalwd-"));
    fs.writeFileSync(path.join(proj, "agent.agency"), "node main() { return 1 }\n");
  });
  afterEach(() => {
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it("module-dir == cwd: compiled entry lives inside each input's workdir", async () => {
    const runsDir = path.join(proj, "runs");
    const seen: { compiledEntryPath: string; cwd: string }[] = [];
    const runner = vi.fn(async (args: { compiledEntryPath: string; cwd: string }) => {
      seen.push({ compiledEntryPath: args.compiledEntryPath, cwd: args.cwd });
      return { ok: true as const };
    });

    const result = await evalRunLoadedInputs(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", args: {} }],
        inputsSource: "test",
        runsDir,
        runId: "r1",
        config: {},
        pipeAgentOutput: false,
      },
      { runner },
    );

    const workdir = result.inputs[0].workdirPath;
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(workdir);
    expect(seen[0].compiledEntryPath.startsWith(workdir + path.sep)).toBe(true);
    expect(fs.existsSync(seen[0].compiledEntryPath)).toBe(true);
  });

  it("rejects working_dir that does not contain the agent file", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const runner = vi.fn(async () => ({ ok: true as const }));
    try {
      const result = await evalRunLoadedInputs(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "input-1", goal: "g", args: {}, working_dir: outside }],
          inputsSource: "test",
          runsDir: path.join(proj, "runs"),
          runId: "r-outside",
          config: {},
          pipeAgentOutput: false,
        },
        { runner },
      );
      expect(result.inputs[0].status).toBe("error");
      expect(result.inputs[0].errorMessage).toMatch(/working_dir must contain the agent file/);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects working_dir values that point to files", async () => {
    const file = path.join(proj, "not-a-dir.txt");
    fs.writeFileSync(file, "x");
    const runner = vi.fn(async () => ({ ok: true as const }));
    const result = await evalRunLoadedInputs(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", args: {}, working_dir: file }],
        inputsSource: "test",
        runsDir: path.join(proj, "runs"),
        runId: "r-file",
        config: {},
        pipeAgentOutput: false,
      },
      { runner },
    );
    expect(result.inputs[0].status).toBe("error");
    expect(result.inputs[0].errorMessage).toMatch(/working_dir is not a directory/);
  });

  it("rejects combining a caller-supplied seed with input.working_dir", async () => {
    const runner = vi.fn(async () => ({ ok: true as const }));
    const result = await evalRunLoadedInputs(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", args: {}, working_dir: proj }],
        inputsSource: "test",
        runsDir: path.join(proj, "runs"),
        runId: "r-seed-conflict",
        config: {},
        pipeAgentOutput: false,
        seed: { dir: proj, agentRelPath: "agent.agency" },
      },
      { runner },
    );
    expect(result.inputs[0].status).toBe("error");
    expect(result.inputs[0].errorMessage).toMatch(/cannot be combined with a caller-supplied seed/);
  });
});
