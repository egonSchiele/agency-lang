import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertTargetMatchesInputs,
  parseTarget,
  resolveEvalRunTarget,
  resolveEvalTarget,
  type EvalTarget,
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
    expect(resolveEvalTarget({ agentCmd: `agency agent -p -- {input}` })).toEqual({
      kind: "command",
      tokens: ["agency", "agent", "-p", "--", "{input}"],
      label: "agency agent -p -- {input}",
    });
  });

  it("rejects both and neither; a command without {input} is fine here (the input check decides)", () => {
    expect(() => resolveEvalTarget({ agent: "a.agency", agentCmd: "x {input}" })).toThrow(
      /exactly one of/,
    );
    expect(() => resolveEvalTarget({})).toThrow(/exactly one of/);
    expect(resolveEvalTarget({ agentCmd: "agency agent -p hello" }).kind).toBe("command");
  });
});

describe("assertTargetMatchesInputs", () => {
  function agentWith(source: string): EvalTarget {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shape-"));
    dirs.push(tmpDir);
    const file = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(file, source);
    return { kind: "file", agentFile: file, node: "main", label: file };
  }
  const withInput = [{ input: "t" }];
  const noInput = [{}];
  const command = (cmd: string): EvalTarget => resolveEvalTarget({ agentCmd: cmd });

  it("with inputs: accepts a one-parameter node, default value or not", () => {
    expect(() =>
      assertTargetMatchesInputs(agentWith("node main(task: string) {}\n"), withInput),
    ).not.toThrow();
    expect(() =>
      assertTargetMatchesInputs(agentWith('node main(task: string = "") {}\n'), withInput),
    ).not.toThrow();
  });

  it("with inputs: rejects a zero-parameter node with the add-one hint", () => {
    expect(() => assertTargetMatchesInputs(agentWith("node main() {}\n"), withInput)).toThrow(
      /takes none — add one/,
    );
  });

  it("with inputs: rejects a two-parameter node, naming the parameters", () => {
    expect(() =>
      assertTargetMatchesInputs(agentWith("node main(a: string, b: string) {}\n"), withInput),
    ).toThrow(/takes 2 \(a, b\)/);
  });

  it("without inputs: accepts a zero-parameter node and rejects one that expects an argument", () => {
    expect(() => assertTargetMatchesInputs(agentWith("node main() {}\n"), noInput)).not.toThrow();
    expect(() =>
      assertTargetMatchesInputs(agentWith("node main(task: string) {}\n"), noInput),
    ).toThrow(/no test provides an input.*--input/);
  });

  it("commands: the old {task} placeholder is refused with a pointer to {input}", () => {
    expect(() =>
      assertTargetMatchesInputs(command("agency agent -p -- {task}"), withInput),
    ).toThrow(/\{task\}, which was renamed: write \{input\}/);
  });

  it("commands: {input} is required with inputs and refused without", () => {
    expect(() =>
      assertTargetMatchesInputs(command("agency agent -p -- {input}"), withInput),
    ).not.toThrow();
    expect(() => assertTargetMatchesInputs(command("agency agent -p hello"), withInput)).toThrow(
      /must contain \{input\}/,
    );
    expect(() =>
      assertTargetMatchesInputs(command("agency agent -p hello"), noInput),
    ).not.toThrow();
    expect(() => assertTargetMatchesInputs(command("agency agent -p -- {input}"), noInput)).toThrow(
      /no test provides an input/,
    );
  });

  it("a suite must agree: all tests with an input, or none", () => {
    expect(() =>
      assertTargetMatchesInputs(agentWith("node main(task: string) {}\n"), [{ input: "t" }, {}]),
    ).toThrow(/every test provides an "input" or none does; 1 of 2/);
  });

  it("stays quiet on unparseable files and absent nodes — compile/run report those better", () => {
    expect(() =>
      assertTargetMatchesInputs(agentWith("this is not agency"), withInput),
    ).not.toThrow();
    expect(() =>
      assertTargetMatchesInputs(agentWith("node other(x: string) {}\n"), withInput),
    ).not.toThrow();
    const missing: EvalTarget = {
      kind: "file",
      agentFile: path.join(os.tmpdir(), "does-not-exist.agency"),
      node: "main",
      label: "x",
    };
    expect(() => assertTargetMatchesInputs(missing, withInput)).not.toThrow();
  });
});
