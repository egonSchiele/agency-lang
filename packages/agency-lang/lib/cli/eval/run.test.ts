import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evalRun, executeEvalRunTask, resolveEvalRunTarget, validateTaskSelection } from "./run.js";

describe("eval run CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves file and directory agent targets", () => {
    const file = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(file, "node main() {}\n");
    const dir = path.join(tmpDir, "agent-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() {}\n");

    expect(resolveEvalRunTarget(`${file}:evalMain`)).toEqual({ agentFile: file, node: "evalMain", label: `${file}:evalMain` });
    expect(resolveEvalRunTarget(file)).toEqual({ agentFile: file, node: "main", label: `${file}:main` });
    expect(resolveEvalRunTarget(dir)).toEqual({ agentFile: path.join(dir, "main.agency"), node: "main", label: `${path.join(dir, "main.agency")}:main` });
  });

  it("requires exactly one of tasks or goal", () => {
    expect(() => validateTaskSelection({})).toThrow(/one of/i);
    expect(() => validateTaskSelection({ tasks: "tasks.json", goal: "goal" })).toThrow(/one of/i);
    expect(validateTaskSelection({ goal: "goal" })).toBe("goal");
  });

  it("builds a run and invokes each task through dependencies", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const runsDir = path.join(tmpDir, "runs");

    const result = await evalRun(
      {
        agent: agentFile,
        goal: "do it",
        runsDir,
        runId: "r1",
        continueOnError: true,
      },
      {
        now: () => new Date("2026-06-09T14:30:00.000Z"),
        makeId: () => "task1",
        compileAgent: async () => ({ moduleId: "agent", path: "/compiled/agent.js" }),
        runTask: async ({ statelogPath }) => {
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
        extract: async ({ outPath }) => { fs.writeFileSync(outPath, "{}"); },
      },
    );

    expect(result).toMatchObject({ runId: "r1", okCount: 1, errorCount: 0 });
    expect(result.tasks[0]).toMatchObject({ taskId: "task1", status: "success" });
    expect(fs.existsSync(path.join(runsDir, "r1", "tasks", "task1", "eval-record.json"))).toBe(true);
  });

  it("executes one task through artifact, run, and extract dependencies", async () => {
    const state = {
      runId: "r1",
      runDir: path.join(tmpDir, "runs", "r1"),
      tasksDir: path.join(tmpDir, "runs", "r1", "tasks"),
      agent: "agent.agency:main",
      tasksSource: "inline:--goal",
      continueOnError: true,
    };
    fs.mkdirSync(state.tasksDir, { recursive: true });

    const result = await executeEvalRunTask({
      state,
      task: { task_id: "task1", rubric: "do it", args: {} },
      compiled: { moduleId: "agent", path: "/compiled/agent.js" },
      defaultNode: "main",
      runTask: async ({ statelogPath }) => {
        fs.writeFileSync(statelogPath, "{}\n");
        return { ok: true };
      },
      extract: async ({ outPath }) => { fs.writeFileSync(outPath, "{}"); },
    });

    expect(result).toMatchObject({ taskId: "task1", status: "success" });
    expect(fs.existsSync(path.join(state.tasksDir, "task1", "eval-record.json"))).toBe(true);
  });
});
