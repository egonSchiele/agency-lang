import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTasks, loadTasksFromFile, taskFromGoal } from "./loadTasks.js";

describe("eval run task loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-load-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(relativePath: string, value: unknown): string {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
    return filePath;
  }

  it("loads tasks from a suite file and fills defaults", () => {
    const suitePath = writeJson("suite.json", {
      tasks: [{ goal: "do it", args: { prompt: "x" } }],
    });

    expect(loadTasksFromFile(suitePath, () => "generated-id")).toEqual([
      { task_id: "generated-id", goal: "do it", args: { prompt: "x" } },
    ]);
  });

  it("validates required goals and task ids", () => {
    expect(() => loadTasksFromFile(writeJson("missing-goal.json", { tasks: [{}] }))).toThrow(/goal/i);
    expect(() => loadTasksFromFile(writeJson("bad-id.json", { tasks: [{ task_id: "bad/id", goal: "x" }] }))).toThrow(/task_id/i);
    expect(() => loadTasksFromFile(writeJson("duplicate-id.json", { tasks: [{ task_id: "same", goal: "a" }, { task_id: "same", goal: "b" }] }))).toThrow(/duplicate/i);
  });

  it("rejects rubric-shaped task files", () => {
    expect(() => loadTasksFromFile(writeJson("rubric-only.json", { tasks: [{ rubric: "x" }] }))).toThrow(/goal/i);
    expect(() => loadTasksFromFile(writeJson("goal-and-rubric.json", { tasks: [{ goal: "x", rubric: "y" }] }))).toThrow(/both goal and rubric/i);
  });

  it("allows an empty suite", () => {
    expect(loadTasksFromFile(writeJson("empty.json", { tasks: [] }))).toEqual([]);
  });

  it("loads task files from a directory in lexical order", () => {
    writeJson("tasks/b.json", { task_id: "b", goal: "B", working_dir: "fixtures/b" });
    writeJson("tasks/a.json", { task_id: "a", goal: "A", args: { n: 1 } });

    const tasks = loadTasks(path.join(tmpDir, "tasks"));

    expect(tasks.map((task) => task.task_id)).toEqual(["a", "b"]);
    expect(tasks[0].args).toEqual({ n: 1 });
    expect(tasks[1].working_dir).toBe(path.join(tmpDir, "tasks", "fixtures/b"));
  });

  it("returns an empty list for a directory with no json files", () => {
    fs.mkdirSync(path.join(tmpDir, "empty"));
    fs.writeFileSync(path.join(tmpDir, "empty", "note.txt"), "ignore me");

    expect(loadTasks(path.join(tmpDir, "empty"))).toEqual([]);
  });

  it("creates an inline task from a goal", () => {
    expect(taskFromGoal("do it")).toEqual({
      task_id: "task-1",
      goal: "do it",
      args: {},
    });
  });
});
