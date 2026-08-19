import * as fs from "fs";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { writeRunDirectory, writeRunGroup } from "@/eval/runDirectoryFixture.js";
import { tempDir } from "@/runDirectory/testFixtures.js";

import { resolveLabelingGroup } from "./group.js";

const quiet = { reportWarning: () => {} };
const made: string[] = [];

function group(): string {
  const dir = writeRunGroup([
    { traceId: "ta", test: { id: "a", input: "t" }, output: "x" },
    { traceId: "tb", test: { id: "b", input: "t" }, output: "y" },
    { traceId: "tc", test: { id: "c", input: "t" }, wroteStatelog: false, ended: "error" },
  ]);
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  made.length = 0;
});

describe("resolveLabelingGroup", () => {
  it("a group's children resolve in walk order, silent runs excluded, fields derived", () => {
    const dir = group();
    const resolved = resolveLabelingGroup([dir], quiet);
    expect(fs.realpathSync(resolved.dir)).toBe(fs.realpathSync(dir));
    expect(resolved.runs.map((run) => [path.basename(run.dir), run.traceId])).toEqual([
      ["a", "ta"],
      ["b", "tb"],
    ]);
    expect(resolved.runs[0].fields).toEqual({ input: "t", output: "x" });
    expect(resolved.runs[0].snapshot.traces[0].traceId).toBe("ta");
  });

  it("one run resolves to its parent as the group", () => {
    const dir = group();
    const resolved = resolveLabelingGroup([path.join(dir, "b")], quiet);
    expect(fs.realpathSync(resolved.dir)).toBe(fs.realpathSync(dir));
    expect(resolved.runs.map((run) => run.traceId)).toEqual(["tb"]);
  });

  it("several paths keep the user's order; aliases of one directory count once", () => {
    const dir = group();
    const alias = path.join(dir, "alias-of-a");
    fs.symlinkSync(path.join(dir, "a"), alias, "dir");
    const resolved = resolveLabelingGroup([path.join(dir, "b"), path.join(dir, "a"), alias], quiet);
    expect(resolved.runs.map((run) => run.traceId)).toEqual(["tb", "ta"]);
  });

  it("refuses runs from two different parents", () => {
    const one = group();
    const two = group();
    expect(() => resolveLabelingGroup([path.join(one, "a"), path.join(two, "b")], quiet)).toThrow(
      /different groups/,
    );
  });

  it("refuses two physical directories that carry the same trace id, naming both", () => {
    const dir = group();
    const copy = path.join(dir, "a-copy");
    fs.cpSync(path.join(dir, "a"), copy, { recursive: true });
    expect(() => resolveLabelingGroup([dir], quiet)).toThrow(
      new RegExp(`${path.join(fs.realpathSync(dir), "a")} and .*a-copy both hold trace ta`),
    );
  });

  it("refuses a group with no traced runs", () => {
    const dir = tempDir("group-");
    made.push(dir);
    writeRunDirectory(
      { test: { id: "c", input: "t" }, wroteStatelog: false, ended: "error" },
      path.join(dir, "c"),
    );
    expect(() => resolveLabelingGroup([dir], quiet)).toThrow(/nothing to label/);
  });
});
