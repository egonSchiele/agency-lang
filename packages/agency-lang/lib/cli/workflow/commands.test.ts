import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  prepareWorkflow,
  readDriverResult,
  workflowCheck,
  workflowCompile,
  workflowList,
  workflowRun,
  workflowTools,
  type WorkflowIo,
} from "./commands.js";
import { NO_TERMINAL } from "./output.js";
import { CATCH_ALL_MESSAGE } from "./runPolicy.js";
import type { DriverCall, DriverOutcome } from "./runDriver.js";

const FIXTURES = path.resolve("tests/agency/workflow/fixtures/tools");

const success = (value: unknown) => ({ __type: "resultType", success: true, value });
const failure = (error: string, data: unknown = null) => ({
  __type: "resultType",
  success: false,
  error,
  data,
});

const addOne = {
  format: 1,
  name: "addOne",
  description: "Find a list and add soup to it.",
  inputs: "{ noteTitle: string }",
  steps: [
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
      args: { listId: { $ref: "steps.list[0].id" }, items: ["soup"], section: "Meals" },
    },
  ],
};

describe("readDriverResult", () => {
  it("reads a success as its value", () => {
    expect(readDriverResult({ ok: true, data: success([1]) })).toEqual({
      kind: "value",
      value: [1],
    });
  });

  it("reads a failure with problems as problems", () => {
    const problems = [{ step: "a", field: "tool", message: "x" }];
    expect(readDriverResult({ ok: true, data: failure("bad", { problems }) })).toEqual({
      kind: "problems",
      problems,
    });
  });

  it("reads any other failure with its step", () => {
    expect(readDriverResult({ ok: true, data: failure("step add: no", { step: "add" }) })).toEqual({
      kind: "failed",
      message: "step add: no",
      step: "add",
    });
  });

  it("reads a list of interrupts as unanswered", () => {
    expect(readDriverResult({ ok: true, data: [{ effect: "std::read" }] })).toEqual({
      kind: "unanswered",
      effects: ["std::read"],
    });
  });

  it("reads a child that failed as failed", () => {
    expect(readDriverResult({ ok: false, message: "boom" })).toEqual({
      kind: "failed",
      message: "boom",
      step: null,
    });
  });
});

describe("the commands", () => {
  let project: string;
  let out: string[];
  let err: string[];
  let calls: DriverCall[];
  let answer: DriverOutcome;
  let confirm: WorkflowIo["confirm"];
  let asked: string[];

  const io = (): WorkflowIo => ({
    cwd: project,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    config: {},
    runDriver: async (call) => {
      calls.push(call);
      return answer;
    },
    confirm,
  });

  const save = (name: string, workflow: unknown) =>
    writeFileSync(path.join(project, "workflows", `${name}.json`), JSON.stringify({ workflow }));

  beforeEach(() => {
    project = mkdtempSync(path.join(realpathSync(tmpdir()), "wf-commands-"));
    mkdirSync(path.join(project, "workflows"));
    mkdirSync(path.join(project, "tools"));
    cpSync(path.join(FIXTURES, "lists.agency"), path.join(project, "tools", "lists.agency"));
    save("addOne", addOne);
    out = [];
    err = [];
    calls = [];
    answer = { ok: true, data: success([]) };
    asked = [];
    confirm = null;
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  describe("prepareWorkflow", () => {
    it("exits 2 for a workflow it cannot find", () => {
      expect(prepareWorkflow("nope", io())).toEqual({ exitCode: 2 });
      expect(err).toEqual(["no workflow at workflows/nope.json"]);
    });

    it("exits 1 for a file that is not JSON", () => {
      writeFileSync(path.join(project, "workflows", "bad.json"), "{");
      expect(prepareWorkflow("bad", io())).toEqual({ exitCode: 1 });
      expect(err[0]).toMatch(/^workflows\/bad\.json is not valid JSON/);
    });

    it("exits 1 for a file without the shape writeWorkflow writes", () => {
      writeFileSync(path.join(project, "workflows", "bare.json"), JSON.stringify(addOne));
      expect(prepareWorkflow("bare", io())).toEqual({ exitCode: 1 });
      expect(err[0]).toBe("workflows/bare.json has 1 problem:\n  a workflow must be a JSON object");
    });

    it("plans the imports of a workflow it can read", () => {
      const prepared = prepareWorkflow("addOne", io());
      expect("plan" in prepared && prepared.plan.imports).toEqual([
        { module: "./tools/lists.agency", names: ["findLists", "addListItems"] },
      ]);
    });
  });

  it("check prints what the workflow can raise", async () => {
    expect(await workflowCheck("addOne", {}, io())).toBe(0);
    expect(calls[0].node).toBe("wfCheckNode");
    expect(calls[0].args).toEqual(["addOne", project]);
    expect(out).toEqual([
      "workflows/addOne.json: no problems\ncan raise:\n  test::lists::add   step add (addListItems)",
    ]);
  });

  it("check prints the problems and exits 1", async () => {
    answer = {
      ok: true,
      data: failure("bad", { problems: [{ step: "add", field: "args.listId", message: "no" }] }),
    };
    expect(await workflowCheck("addOne", {}, io())).toBe(1);
    expect(err).toEqual(["workflows/addOne.json has 1 problem:\n  step add, args.listId: no"]);
  });

  it("check prints the value as JSON with --json", async () => {
    expect(await workflowCheck("addOne", { json: true }, io())).toBe(0);
    expect(JSON.parse(out[0])).toEqual({ success: true, value: [] });
  });

  it("check prints problems as JSON with --json, in the shape every command uses", async () => {
    const problems = [{ step: "add", field: "args.listId", message: "no" }];
    answer = { ok: true, data: failure("bad", { problems }) };
    expect(await workflowCheck("addOne", { json: true }, io())).toBe(1);
    expect(JSON.parse(out[0])).toEqual({
      success: false,
      error: "workflows/addOne.json has 1 problem:\n  step add, args.listId: no",
      step: null,
      problems,
    });
  });

  it("check prints a failed driver's message and exits 1", async () => {
    answer = { ok: false, message: "the driver did not compile" };
    expect(await workflowCheck("addOne", {}, io())).toBe(1);
    expect(err).toEqual(["the driver did not compile"]);
  });

  it("check names the effects of a prompt nobody answered", async () => {
    answer = { ok: true, data: [{ effect: "std::read" }] };
    expect(await workflowCheck("addOne", {}, io())).toBe(1);
    expect(err).toEqual(["stopped at a prompt nobody answered: std::read"]);
  });

  it("compile prints the source", async () => {
    answer = { ok: true, data: success("export node main() {}") };
    expect(await workflowCompile("addOne", io())).toBe(0);
    expect(calls[0].node).toBe("wfCompileNode");
    expect(out).toEqual(["export node main() {}"]);
  });

  it("tools runs the catalog over every def of each source", async () => {
    const entry = {
      module: "./tools/lists.agency",
      name: "findLists",
      description: "Find lists.",
      params: [],
      returns: null,
      effects: [],
    };
    answer = { ok: true, data: success([entry]) };
    expect(await workflowTools(["tools/lists.agency"], {}, io())).toBe(0);
    expect(calls[0]).toMatchObject({
      node: "wfToolsNode",
      args: [project],
      imports: [{ module: "./tools/lists.agency", names: ["findLists", "addListItems"] }],
    });
    expect(out).toEqual(["./tools/lists.agency\n  findLists()\n    Find lists."]);
  });

  it("tools exits 2 for a source it cannot describe", async () => {
    expect(await workflowTools(["tools/missing.agency"], {}, io())).toBe(2);
    expect(calls).toEqual([]);
  });

  it("list prints the saved workflows", async () => {
    answer = { ok: true, data: success([{ name: "addOne", workflow: addOne }]) };
    expect(await workflowList(undefined, {}, io())).toBe(0);
    expect(calls[0]).toMatchObject({ node: "wfListNode", args: [project], imports: [] });
    expect(out).toEqual(["addOne { noteTitle: string }\n  Find a list and add soup to it."]);
  });

  describe("run", () => {
    const settings = (person = {}) => ({ config: {}, person });
    const inputs = JSON.stringify({ noteTitle: "Groceries" });
    const answering = (yes: boolean) => async (question: string) => {
      asked.push(question);
      return yes;
    };

    it("runs on a yes, with the effects it accepted in the policy", async () => {
      confirm = answering(true);
      answer = { ok: true, data: success("added 1 items to l1/Meals") };
      expect(await workflowRun("addOne", { inputs }, settings(), io())).toBe(0);
      expect(asked).toEqual([
        "Approve these effects for the whole run? This is the same as --approve test::lists::add",
      ]);
      expect(err[0]).toBe(
        "Your policy does not cover these interrupts:\n  test::lists::add   step add (addListItems)",
      );
      expect(out).toEqual(["added 1 items to l1/Meals"]);
      expect(calls[0].node).toBe("wfRunNode");
      expect(calls[0].args).toEqual(["addOne", project, { noteTitle: "Groceries" }]);
      const policy = JSON.parse(calls[0].carriers!.policy!.policyJson);
      expect(policy["test::lists::add"]).toEqual([{ action: "approve" }]);
      expect(policy["*"]).toEqual([{ action: "reject", rejectMessage: CATCH_ALL_MESSAGE }]);
      expect(Object.keys(policy)).toContain("std::workflow::scan");
      expect(calls[0].carriers!.policy!.interactive).toBe(false);
    });

    it("does not run on a no", async () => {
      confirm = answering(false);
      expect(await workflowRun("addOne", {}, settings(), io())).toBe(1);
      expect(err).toContain("Did not run.");
      expect(calls).toEqual([]);
    });

    it("does not run without a terminal, and says how to cover the effects", async () => {
      expect(await workflowRun("addOne", {}, settings(), io())).toBe(1);
      expect(err).toContain(NO_TERMINAL);
      expect(calls).toEqual([]);
    });

    it("never asks when the policy covers every effect", async () => {
      confirm = answering(false);
      answer = { ok: true, data: success({ added: 1 }) };
      const person = { "test::lists::add": [{ action: "approve" as const }] };
      expect(await workflowRun("addOne", {}, settings(person), io())).toBe(0);
      expect(asked).toEqual([]);
      expect(out).toEqual(['{\n  "added": 1\n}']);
    });

    it("prints a failed step and exits 1", async () => {
      const person = { "test::lists::add": [{ action: "reject" as const }] };
      answer = { ok: true, data: failure("step add (addListItems): rejected", { step: "add" }) };
      expect(await workflowRun("addOne", {}, settings(person), io())).toBe(1);
      expect(err).toEqual(["step add (addListItems): rejected"]);
    });

    it("prints a prompt that a propagate rule left unanswered", async () => {
      const person = { "test::lists::add": [{ action: "propagate" as const }] };
      confirm = answering(true);
      answer = { ok: true, data: [{ effect: "test::lists::add" }] };
      expect(await workflowRun("addOne", {}, settings(person), io())).toBe(1);
      expect(asked).toEqual([]);
      expect(err).toEqual([
        "stopped at a prompt nobody answered: test::lists::add. This run cannot be resumed. Cover test::lists::add with --policy, --approve, or --reject, and run it again.",
      ]);
    });

    it("keeps stdout for the JSON alone with --json", async () => {
      confirm = answering(true);
      answer = { ok: true, data: success("done") };
      expect(await workflowRun("addOne", { json: true }, settings(), io())).toBe(0);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0])).toEqual({ success: true, value: "done" });
      expect(err[0]).toMatch(/^Your policy does not cover/);
    });

    it("prints a failure as JSON with its step", async () => {
      const person = { "test::lists::add": [{ action: "reject" as const }] };
      answer = { ok: true, data: failure("no", { step: "add" }) };
      expect(await workflowRun("addOne", { json: true }, settings(person), io())).toBe(1);
      expect(JSON.parse(out[0])).toEqual({ success: false, error: "no", step: "add" });
    });

    it("exits 2 for --inputs that is not JSON", async () => {
      expect(await workflowRun("addOne", { inputs: "nope" }, settings(), io())).toBe(2);
      expect(calls).toEqual([]);
    });

    it("leaves a person's * policy as it is", async () => {
      const person = { "*": [{ action: "approve" as const }] };
      answer = { ok: true, data: success("done") };
      expect(await workflowRun("addOne", {}, settings(person), io())).toBe(0);
      expect(JSON.parse(calls[0].carriers!.policy!.policyJson)).toEqual(person);
    });
  });
});
