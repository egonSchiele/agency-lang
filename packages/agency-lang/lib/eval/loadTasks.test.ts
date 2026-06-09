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
      tasks: [{ rubric: "do it", args: { prompt: "x" } }],
    });

    expect(loadTasksFromFile(suitePath, () => "generated-id")).toEqual([
      { task_id: "generated-id", rubric: "do it", args: { prompt: "x" } },
    ]);
  });

  it("validates required rubrics and task ids", () => {
    expect(() => loadTasksFromFile(writeJson("missing-rubric.json", { tasks: [{}] }))).toThrow(/rubric/i);
    expect(() => loadTasksFromFile(writeJson("bad-id.json", { tasks: [{ task_id: "bad/id", rubric: "x" }] }))).toThrow(/task_id/i);
    expect(() => loadTasksFromFile(writeJson("duplicate-id.json", { tasks: [{ task_id: "same", rubric: "a" }, { task_id: "same", rubric: "b" }] }))).toThrow(/duplicate/i);
  });

  it("allows an empty suite", () => {
    expect(loadTasksFromFile(writeJson("empty.json", { tasks: [] }))).toEqual([]);
  });

  it("loads task files from a directory in lexical order", () => {
    writeJson("tasks/b.json", { task_id: "b", rubric: "B", working_dir: "fixtures/b" });
    writeJson("tasks/a.json", { task_id: "a", rubric: "A", args: { n: 1 } });

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
    expect(taskFromGoal("rubric", () => "id1")).toEqual({
      task_id: "id1",
      rubric: "rubric",
      args: {},
    });
  });
});
