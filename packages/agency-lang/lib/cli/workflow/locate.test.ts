import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { locateWorkflow } from "./locate.js";

describe("locateWorkflow", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(path.join(realpathSync(tmpdir()), "wf-locate-"));
    mkdirSync(path.join(project, "workflows"));
    writeFileSync(path.join(project, "workflows", "addOne.json"), "{}");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  const addOne = () => ({
    dir: project,
    name: "addOne",
    file: path.join(project, "workflows", "addOne.json"),
  });

  it("finds a workflow by its path", () => {
    expect(locateWorkflow("workflows/addOne.json", project)).toEqual({
      found: addOne(),
      error: null,
    });
  });

  it("finds a workflow by a path from another folder", () => {
    const other = path.join(project, "src");
    mkdirSync(other);
    expect(locateWorkflow("../workflows/addOne.json", other).found).toEqual(addOne());
  });

  it("finds a workflow by its bare name in ./workflows", () => {
    expect(locateWorkflow("addOne", project)).toEqual({ found: addOne(), error: null });
  });

  it("refuses a .json path outside a workflows folder", () => {
    writeFileSync(path.join(project, "addOne.json"), "{}");
    expect(locateWorkflow("addOne.json", project).error).toMatch(/not in a folder named workflows/);
  });

  it("refuses a name that is not an identifier", () => {
    expect(locateWorkflow("../x", project).error).toBe('name "../x" is not an identifier');
  });

  it("refuses a missing file", () => {
    expect(locateWorkflow("nope", project).error).toBe("no workflow at workflows/nope.json");
    expect(locateWorkflow("workflows/nope.json", project).error).toBe(
      "no workflow at workflows/nope.json",
    );
  });

  it("refuses a symbolic link", () => {
    symlinkSync(
      path.join(project, "workflows", "addOne.json"),
      path.join(project, "workflows", "linked.json"),
    );
    expect(locateWorkflow("linked", project).error).toMatch(/symbolic link/);
  });
});
