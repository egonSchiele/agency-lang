import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertEvalEntryNodeTakesOneParameter,
  parseTarget,
  resolveEvalRunTarget,
  resolveEvalTarget,
} from "./agentTarget.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("agent targets", () => {
  it("splits path from node on the last colon", () => {
    expect(parseTarget("a.agency:main")).toEqual({ filename: "a.agency", nodeName: "main" });
    expect(parseTarget("a.agency")).toEqual({ filename: "a.agency", nodeName: "" });
  });

  it("resolves file and directory agent targets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-target-"));
    dirs.push(tmpDir);
    const file = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(file, "node main() {}\n");
    const dir = path.join(tmpDir, "agent-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() {}\n");

    expect(resolveEvalRunTarget(`${file}:evalMain`)).toEqual({
      agentFile: file,
      node: "evalMain",
      label: `${file}:evalMain`,
    });
    expect(resolveEvalRunTarget(file)).toEqual({
      agentFile: file,
      node: "main",
      label: `${file}:main`,
    });
    expect(resolveEvalRunTarget(dir)).toEqual({
      agentFile: path.join(dir, "main.agency"),
      node: "main",
      label: `${path.join(dir, "main.agency")}:main`,
    });
  });
});

describe("resolveEvalTarget", () => {
  it("resolves --agent into a file target", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
    dirs.push(tmpDir);
    const file = path.join(tmpDir, "a.agency");
    fs.writeFileSync(file, "node main(task: string) {}\n");
    expect(resolveEvalTarget({ agent: `${file}:main` })).toEqual({
      kind: "file",
      agentFile: file,
      node: "main",
      label: `${file}:main`,
    });
  });

  it("resolves --agent-cmd into a command target with the placeholder intact", () => {
    expect(resolveEvalTarget({ agentCmd: `agency agent -p -- {task}` })).toEqual({
      kind: "command",
      tokens: ["agency", "agent", "-p", "--", "{task}"],
      label: "agency agent -p -- {task}",
    });
  });

  it("rejects both, neither, and a command without {task}", () => {
    expect(() => resolveEvalTarget({ agent: "a.agency", agentCmd: "x {task}" })).toThrow(
      /exactly one of/,
    );
    expect(() => resolveEvalTarget({})).toThrow(/exactly one of/);
    expect(() => resolveEvalTarget({ agentCmd: "agency agent -p hello" })).toThrow(/\{task\}/);
  });
});

describe("assertEvalEntryNodeTakesOneParameter", () => {
  function agentWith(source: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shape-"));
    dirs.push(tmpDir);
    const file = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(file, source);
    return file;
  }

  it("accepts a one-parameter node, default value or not", () => {
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(agentWith("node main(task: string) {}\n"), "main"),
    ).not.toThrow();
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(agentWith('node main(task: string = "") {}\n'), "main"),
    ).not.toThrow();
  });

  it("rejects a zero-parameter node with the add-one hint", () => {
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(agentWith("node main() {}\n"), "main"),
    ).toThrow(/takes none — add one/);
  });

  it("rejects a two-parameter node, naming the parameters", () => {
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(
        agentWith("node main(a: string, b: string) {}\n"),
        "main",
      ),
    ).toThrow(/takes 2 \(a, b\)/);
  });

  it("stays quiet on unparseable files and absent nodes — compile/run report those better", () => {
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(agentWith("this is not agency"), "main"),
    ).not.toThrow();
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(agentWith("node other(x: string) {}\n"), "main"),
    ).not.toThrow();
    expect(() =>
      assertEvalEntryNodeTakesOneParameter(path.join(os.tmpdir(), "does-not-exist.agency"), "main"),
    ).not.toThrow();
  });
});
