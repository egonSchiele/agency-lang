import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { readRunDirectory } from "@/runDirectory/runDir.js";
import { tempDir } from "@/runDirectory/testFixtures.js";

import { writeRunDirectory, writeRunGroup } from "./runDirectoryFixture.js";

const quiet = { reportWarning: () => {} };

describe("writeRunDirectory", () => {
  it("writes one run: its trace and its run row", () => {
    const dir = writeRunDirectory({ traceId: "t1", test: { id: "a", input: "hi" }, output: "x" });
    const snapshot = readRunDirectory(dir, quiet);
    expect(snapshot.traces.map((trace) => trace.traceId)).toEqual(["t1"]);
    expect(snapshot.effectiveAnnotations.t1.run?.kind).toBe("run");
  });
});

describe("writeRunGroup", () => {
  it("writes <group>/<test.id>/ per run", () => {
    const group = writeRunGroup([
      { traceId: "t1", test: { id: "a", input: "hi" }, output: "x" },
      { traceId: "t2", test: { id: "b", input: "hi" }, output: "y" },
    ]);
    expect(fs.readdirSync(group).sort()).toEqual(["a", "b"]);
    expect(readRunDirectory(path.join(group, "b"), quiet).traces[0].traceId).toBe("t2");
  });

  it("refuses duplicate child names before creating anything", () => {
    const group = path.join(tempDir("group-"), "g");
    expect(() =>
      writeRunGroup(
        [
          { traceId: "t1", test: { id: "a", input: "hi" } },
          { traceId: "t2", test: { id: "a", input: "hi" } },
        ],
        group,
      ),
    ).toThrow(/share/);
    expect(fs.existsSync(group)).toBe(false);
  });
});
