import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRunStatelog } from "./logs.js";

describe("resolveRunStatelog", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-logs-"));
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  function addInput(id: string, withStatelog = true): string {
    const agentDir = path.join(runDir, "inputs", id, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const statelogPath = path.join(agentDir, "statelog.jsonl");
    if (withStatelog) fs.writeFileSync(statelogPath, "{}\n");
    return statelogPath;
  }

  it("a one-input run resolves without --input", () => {
    const statelogPath = addInput("regex-log");
    expect(resolveRunStatelog(runDir)).toBe(statelogPath);
  });

  it("a multi-input run demands --input and lists the choices", () => {
    addInput("a");
    addInput("b");
    expect(() => resolveRunStatelog(runDir)).toThrow(/--input: a, b/);
    expect(resolveRunStatelog(runDir, "b")).toBe(
      path.join(runDir, "inputs", "b", "agent", "statelog.jsonl"),
    );
    expect(() => resolveRunStatelog(runDir, "zzz")).toThrow(/No input "zzz".*a, b/);
  });

  it("accepts an input directory or the statelog file itself", () => {
    const statelogPath = addInput("only");
    expect(resolveRunStatelog(path.join(runDir, "inputs", "only"))).toBe(statelogPath);
    expect(resolveRunStatelog(statelogPath)).toBe(statelogPath);
  });

  it("names the failure when an input never produced a statelog", () => {
    addInput("dead", false);
    expect(() => resolveRunStatelog(runDir)).toThrow(
      /no statelog.*failed before the agent started/,
    );
  });
});
