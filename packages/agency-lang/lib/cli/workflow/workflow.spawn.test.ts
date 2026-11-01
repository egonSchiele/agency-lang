import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { makeAgencyTempDir } from "../../utils/agencyTempDir.js";

const execFileAsync = promisify(execFile);

// End-to-end: run the BUILT CLI in a small project. Mirrors
// budgetRun.spawn.test.ts's harness.
const CLI = path.resolve("dist/scripts/agency.js");
const FIXTURES = path.resolve("tests/agency/workflow/fixtures/tools");

const addOne = (listId: string) => ({
  workflow: {
    format: 1,
    name: "addOne",
    description: "Find the weekly list and add soup to it.",
    inputs: "{ noteTitle: string }",
    steps: [
      {
        id: "note",
        kind: "tool",
        module: "./tools/notes.agency",
        tool: "searchNotes",
        args: { query: { $ref: "inputs.noteTitle" } },
      },
      {
        id: "list",
        kind: "tool",
        module: "./tools/lists.agency",
        tool: "findLists",
        args: { query: "weekly" },
      },
      {
        id: "add",
        kind: "tool",
        module: "./tools/lists.agency",
        tool: "addListItems",
        args: { listId: { $ref: listId }, items: ["soup"], section: "Meals" },
      },
    ],
  },
});

async function runCli(dir: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, "workflow", ...args], {
      cwd: dir,
      timeout: 120_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

// Requires the built CLI; skip in a clean checkout (CI runs make first).
describe.skipIf(!existsSync(CLI))("agency workflow (end-to-end)", () => {
  let project: string;

  beforeAll(() => {
    // Inside the package, so the driver's compiled imports of agency-lang
    // resolve, as they do in a project that has agency-lang installed.
    project = makeAgencyTempDir("wf-spawn");
    mkdirSync(path.join(project, "tools"));
    mkdirSync(path.join(project, "workflows"));
    for (const file of ["notes.agency", "lists.agency"]) {
      cpSync(path.join(FIXTURES, file), path.join(project, "tools", file));
    }
    const save = (name: string, value: unknown) =>
      writeFileSync(
        path.join(project, "workflows", `${name}.json`),
        JSON.stringify(value, null, 2),
      );
    save("addOne", addOne("steps.list[0].id"));
    const broken = addOne("steps.lists[0].id");
    broken.workflow.name = "broken";
    save("broken", broken);
    writeFileSync(
      path.join(project, "reject-add.json"),
      JSON.stringify({ "test::lists::add": [{ action: "reject" }] }),
    );
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  /** No command leaves its driver's folder behind. */
  const noDriverLeft = () => {
    const tmp = path.join(project, ".agency-tmp");
    const left = existsSync(tmp)
      ? readdirSync(tmp).filter((name) => name.startsWith("workflow-"))
      : [];
    expect(left).toEqual([]);
  };

  it("tools prints a local module's signatures and effects", async () => {
    const r = await runCli(project, ["tools", "./tools/lists.agency"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "addListItems(listId: string, items: string[], section: string): Result<string>",
    );
    expect(r.stdout).toContain("raises test::lists::add");
    noDriverLeft();
  });

  it("tools prints a standard module's catalog as JSON", async () => {
    const r = await runCli(project, ["tools", "std::math", "--json"]);
    expect(r.code).toBe(0);
    const names = JSON.parse(r.stdout).value.map((entry: { name: string }) => entry.name);
    expect(names).toContain("round");
    noDriverLeft();
  });

  it("check prints no problems and what the workflow can raise", async () => {
    const r = await runCli(project, ["check", "addOne"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("workflows/addOne.json: no problems");
    expect(r.stdout).toMatch(/test::lists::add\s+step add \(addListItems\)/);
    noDriverLeft();
  });

  it("check leaves a compiled .js beside each tool, as agency run does", async () => {
    expect(existsSync(path.join(project, "tools", "lists.js"))).toBe(true);
  });

  it("check reports a broken reference on its step and exits 1", async () => {
    const r = await runCli(project, ["check", "workflows/broken.json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^ {2}step add, args\.listId:/m);
    noDriverLeft();
  });

  it("compile prints the program", async () => {
    const r = await runCli(project, ["compile", "addOne"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('import { addListItems, findLists } from "./tools/lists.agency"');
    noDriverLeft();
  });

  it("list names both saved workflows", async () => {
    const r = await runCli(project, ["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("addOne { noteTitle: string }");
    expect(r.stdout).toContain("broken { noteTitle: string }");
    noDriverLeft();
  });

  it("exits 2 for a path that is not under a workflows folder", async () => {
    const r = await runCli(project, ["check", "tools/x.json"]);
    expect(r.code).toBe(2);
    noDriverLeft();
  });

  describe("run", () => {
    const INPUTS = ["--inputs", JSON.stringify({ noteTitle: "Groceries" })];
    const runAddOne = (...flags: string[]) =>
      runCli(project, ["run", "addOne", ...INPUTS, ...flags]);

    it("runs with the step's effect approved, and approves the start prompts itself", async () => {
      const r = await runAddOne("--approve", "test::lists::add");
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("added 1 items to l1/Meals");
      noDriverLeft();
    });

    it("runs nothing without a terminal when the policy does not cover an effect", async () => {
      const r = await runAddOne();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/test::lists::add\s+step add \(addListItems\)/);
      expect(r.stderr).toContain("Run this in a terminal to approve them");
      expect(r.stdout).toBe("");
      noDriverLeft();
    });

    it("lets the person's rejection of a start prompt win", async () => {
      const r = await runAddOne("--approve", "test::lists::add", "--reject", "std::workflow::run");
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).not.toContain("added");
      noDriverLeft();
    });

    it("stops at a step the person's policy rejects, without asking", async () => {
      const r = await runAddOne("--policy", "reject-add.json");
      expect(r.code).toBe(1);
      expect(r.stderr).not.toContain("does not cover");
      expect(r.stderr).toMatch(/step add/);
      noDriverLeft();
    });

    it("prints the result as JSON with --json", async () => {
      const r = await runAddOne("--approve", "test::lists::add", "--json");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ success: true, value: "added 1 items to l1/Meals" });
    });

    it("exits 2 for --inputs that is not JSON", async () => {
      const r = await runCli(project, ["run", "addOne", "--inputs", "nope"]);
      expect(r.code).toBe(2);
    });

    // A --max-time that trips while the run waits on the workflow's child
    // does not stop it today: `agency run --max-time` has the same gap when
    // its program calls runWorkflow. So this checks only that the budget
    // flags reach the run's settings, where a malformed one is refused.
    it("refuses a --max-time with no unit, as agency run does", async () => {
      const r = await runAddOne("--approve", "test::lists::add", "--max-time", "300");
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/max-time/);
    });

    it("writes the child's log events to --log-file", async () => {
      const log = path.join(project, "run.jsonl");
      const r = await runAddOne("--approve", "test::lists::add", "--log-file", log);
      expect(r.code).toBe(0);
      // The child's own run starts at the workflow's main node.
      expect(readFileSync(log, "utf-8")).toContain('"entryNode":"main"');
    });

    it("refuses --draft, which a workflow run does not take", async () => {
      const r = await runAddOne("--draft", "x");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/unknown option '--draft'/);
    });
  });
});
