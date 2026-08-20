import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evalLs } from "./ls.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("eval ls", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-ls-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSuite(inputs: unknown[]): string {
    const file = path.join(tmpDir, "suite.json");
    fs.writeFileSync(file, JSON.stringify({ inputs }));
    return file;
  }

  it("lists every test with its tags and description, then a count", () => {
    const suite = writeSuite([
      { id: "a", input: "x", tags: ["easy", "coding"], description: "why a exists" },
      { id: "b", input: "x" },
    ]);
    expect(evalLs({ suite }).map(stripAnsi)).toEqual([
      "a  [easy, coding]",
      "  why a exists",
      "b",
      "2 tests",
    ]);
  });

  it("with a filter, shows the selection and the of-total count", () => {
    const suite = writeSuite([
      { id: "sort-a", input: "x", tags: ["easy"] },
      { id: "sort-b", input: "x", tags: ["hard"] },
      { id: "find-c", input: "x", tags: ["hard"] },
    ]);
    expect(evalLs({ suite, test: ["sort-*"], tags: ["hard"] }).map(stripAnsi)).toEqual([
      "sort-b  [hard]",
      "1 of 3 tests selected",
    ]);
  });

  it("matching nothing names the suite's tags instead of erroring", () => {
    const suite = writeSuite([{ id: "a", input: "x", tags: ["easy"] }]);
    expect(evalLs({ suite, tags: ["nope"] }).map(stripAnsi)).toEqual([
      "0 of 1 tests selected (suite tags: easy)",
    ]);
  });

  it("requires --suite", () => {
    expect(() => evalLs({})).toThrow(/needs --suite/);
  });
});
