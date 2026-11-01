import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { mealPlan } from "../../stdlib/workflow/testFixtures.js";
import { describeModule, importsForSources, importsForSteps } from "./toolImports.js";

const FIXTURES = path.resolve("tests/agency/workflow/fixtures/tools");

/** A workflow with one tool step per [id, module, tool]. */
const stepsOf = (...steps: [string, string, string][]) => ({
  steps: steps.map(([id, module, tool]) => ({ id, kind: "tool", module, tool, args: {} })),
});

describe("describeModule", () => {
  it("describes a local module's defs, with their effects", () => {
    const lists = describeModule("./lists.agency", FIXTURES);
    expect("error" in lists).toBe(false);
    if ("error" in lists) return;
    expect(Object.keys(lists.signatures).sort()).toEqual(["addListItems", "findLists"]);
    expect(lists.signatures.addListItems.effects).toEqual(["test::lists::add"]);
  });

  it("describes a standard module", () => {
    const math = describeModule("std::math", FIXTURES);
    expect("signatures" in math && Object.hasOwn(math.signatures, "round")).toBe(true);
  });

  it("refuses a std:: name that is a path", () => {
    expect(describeModule("std::../../x", FIXTURES)).toEqual({
      error: '"std::../../x" is not a standard module name',
      reachable: false,
    });
  });

  it("describes a module that imports another local file", () => {
    const greet = describeModule("./withHelper.agency", FIXTURES);
    expect("signatures" in greet && Object.keys(greet.signatures)).toEqual(["greet"]);
  });
});

describe("importsForSteps", () => {
  it("imports the meal plan's tools, one import per module", () => {
    const plan = importsForSteps(mealPlan, FIXTURES);
    expect(plan.problems).toEqual([]);
    expect(plan.imports).toEqual([
      { module: "./notes.agency", names: ["searchNotes", "readNote"] },
      { module: "./lists.agency", names: ["findLists", "addListItems"] },
    ]);
    expect(plan.signatures["./lists.agency.addListItems"].effects).toEqual(["test::lists::add"]);
  });

  it("leaves out a tool its module does not export, and a missing module", () => {
    const plan = importsForSteps(
      stepsOf(["a", "./notes.agency", "nope"], ["b", "./missing.agency", "x"]),
      FIXTURES,
    );
    expect(plan).toEqual({ imports: [], signatures: {}, problems: [] });
  });

  it("reports two tools with one name from different modules on the second step", () => {
    const plan = importsForSteps(
      stepsOf(["a", "./notes.agency", "searchNotes"], ["b", "std::math", "searchNotes"]),
      FIXTURES,
    );
    // std::math has no searchNotes, so only a clash between two real defs counts.
    expect(plan.problems).toEqual([]);
    const clash = importsForSteps(
      stepsOf(["a", "./notes.agency", "searchNotes"], ["b", "./notes.agency", "searchNotes"]),
      FIXTURES,
    );
    expect(clash.problems).toEqual([]);
    expect(clash.imports).toEqual([{ module: "./notes.agency", names: ["searchNotes"] }]);
  });

  it("imports a tool whose module imports another local file", () => {
    const plan = importsForSteps(stepsOf(["g", "./withHelper.agency", "greet"]), FIXTURES);
    expect(plan.imports).toEqual([{ module: "./withHelper.agency", names: ["greet"] }]);
  });
});

describe("modules in a temp folder", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wf-imports-"));
    writeFileSync(path.join(dir, "helper.ts"), "export const x = 1;\n");
    writeFileSync(
      path.join(dir, "usesTs.agency"),
      'import { x } from "./helper.ts"\nexport def f(): number {\n  return 1\n}\n',
    );
    writeFileSync(path.join(dir, "a.agency"), "export def same(): number {\n  return 1\n}\n");
    writeFileSync(path.join(dir, "b.agency"), "export def same(): number {\n  return 2\n}\n");
    writeFileSync(
      path.join(dir, "driverName.agency"),
      "export def wfTools(): number {\n  return 1\n}\n",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a module whose imports the sandbox refuses on the step's module field", () => {
    const plan = importsForSteps(stepsOf(["s", "./usesTs.agency", "f"]), dir);
    expect(plan.problems).toEqual([
      {
        step: "s",
        field: "module",
        message: expect.stringMatching(
          /^cannot read the exports of "\.\/usesTs\.agency": describe refused/,
        ),
      },
    ]);
  });

  it("reports two tools with one name from different modules on the second step's tool", () => {
    const plan = importsForSteps(
      stepsOf(["a", "./a.agency", "same"], ["b", "./b.agency", "same"]),
      dir,
    );
    expect(plan.problems).toEqual([
      {
        step: "b",
        field: "tool",
        message:
          'tools "same" from "./a.agency" and "./b.agency" have the same name; a workflow imports each tool by its name',
      },
    ]);
  });

  it("reports a tool named like one of the driver's names", () => {
    const plan = importsForSteps(stepsOf(["d", "./driverName.agency", "wfTools"]), dir);
    expect(plan.problems).toEqual([
      {
        step: "d",
        field: "tool",
        message: 'tool name "wfTools" is a name the agency workflow command uses',
      },
    ]);
  });

  it("names the source when a tools source cannot be described", () => {
    expect(importsForSources(["./usesTs.agency"], dir, dir)).toEqual({
      error: expect.stringMatching(
        /^\.\/usesTs\.agency: cannot read its exports: describe refused/,
      ),
    });
  });

  it("refuses a tools source outside the project directory", () => {
    expect(importsForSources(["../elsewhere.agency"], dir, dir)).toEqual({
      error: `../elsewhere.agency: is not inside the project directory ${dir}`,
    });
  });

  it("imports every def of each tools source, written relative to the project", () => {
    const plan = importsForSources(["a.agency", "std::math"], dir, dir);
    expect("imports" in plan && plan.imports[0]).toEqual({ module: "./a.agency", names: ["same"] });
    expect("imports" in plan && plan.imports[1].names).toContain("round");
  });
});
