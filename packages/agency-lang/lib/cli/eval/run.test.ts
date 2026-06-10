import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evalRun, resolveEvalRunTarget, validateTaskSelection } from "./run.js";

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

  it("compiles, runs each task through the injected runner, and writes artifacts", async () => {
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
        runner: async ({ statelogPath }) => {
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
        extractor: async ({ outPath }) => {
          fs.writeFileSync(outPath, "{}");
        },
      },
    );

    expect(result).toMatchObject({ runId: "r1", okCount: 1, errorCount: 0 });
    expect(result.tasks[0]).toMatchObject({ status: "success" });
    expect(fs.existsSync(path.join(runsDir, "r1", "tasks", result.tasks[0].taskId, "eval-record.json"))).toBe(true);
  });

  it("stops after the first task error when continueOnError is false", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const runsDir = path.join(tmpDir, "runs");
    const tasksFile = path.join(tmpDir, "tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({
      tasks: [
        { task_id: "first", rubric: "r1", args: {} },
        { task_id: "second", rubric: "r2", args: {} },
      ],
    }));

    let runs = 0;
    const result = await evalRun(
      {
        agent: agentFile,
        tasks: tasksFile,
        runsDir,
        runId: "stop",
        continueOnError: false,
      },
      {
        runner: async () => {
          runs += 1;
          return { ok: false, errorMessage: "nope" };
        },
        extractor: async () => {},
      },
    );

    expect(runs).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ taskId: "first", status: "error", errorMessage: "nope" });
  });
});
