import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { sha256Text } from "@/utils/hash.js";

import { makeGraderModuleCache } from "../grading/gradeRun.js";
import { loadGradersJson, loadGradersJsonSnapshot, snapshotGradersJson } from "./load.js";

const TEXT = JSON.stringify([
  { kind: "command", name: "roundtrip", command: "true", mustPass: true },
  { kind: "checklist", name: "grounded", points: ["a"], context: "notes.md" },
]);

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graders-json-load-"));
  fs.writeFileSync(path.join(dir, "graders.json"), TEXT);
  return path.join(dir, "graders.json");
}

describe("loadGradersJson", () => {
  it("builds the graders and names each by the file and its hash", async () => {
    const file = fixture();
    const graders = await loadGradersJson(file);
    expect(graders.map((grader) => grader.name())).toEqual(["roundtrip", "grounded"]);
    expect(graders[0].revision).toBe(`${file}@${sha256Text(TEXT)}`);
    expect(graders[1].annotator()).toEqual({ kind: "grader", id: `${file}@${sha256Text(TEXT)}` });
  });

  it("a file with an unknown kind rejects through the grader cache", async () => {
    const file = fixture();
    fs.writeFileSync(file, JSON.stringify([{ kind: "rubric", name: "r" }]));
    await expect(makeGraderModuleCache({})(file)).rejects.toThrow(
      'grader 0: unknown kind "rubric"',
    );
  });
});

describe("snapshotGradersJson and loadGradersJsonSnapshot", () => {
  it("stores the file under its hash and loads it back with the original source as revision", async () => {
    const file = fixture();
    const snapshot = await snapshotGradersJson(file);
    expect(snapshot.source).toBe(file);
    expect(snapshot.jsonFile).toBe(`${sha256Text(TEXT)}.json`);
    expect(snapshot.bundleFile).toBeUndefined();
    expect(snapshot.judgeFiles).toEqual({});
    expect(snapshot.files).toEqual([{ name: snapshot.jsonFile, content: TEXT }]);

    const gradersDir = fs.mkdtempSync(path.join(os.tmpdir(), "graders-dir-"));
    for (const stored of snapshot.files)
      fs.writeFileSync(path.join(gradersDir, stored.name), stored.content);
    fs.rmSync(file);
    const graders = await loadGradersJsonSnapshot(gradersDir, snapshot);
    expect(graders.map((grader) => grader.name())).toEqual(["roundtrip", "grounded"]);
    expect(graders[0].revision).toBe(`${file}@${sha256Text(TEXT)}`);
  });

  it("a broken file fails at snapshot time, before any agent runs", async () => {
    const file = fixture();
    fs.writeFileSync(file, "[{}]");
    await expect(snapshotGradersJson(file)).rejects.toThrow("grader 0: unknown kind undefined");
  });

  it("a missing stored file names the recorded source", async () => {
    await expect(
      loadGradersJsonSnapshot("/nowhere", {
        source: "/x/graders.json",
        jsonFile: "nope.json",
        judgeFiles: {},
      }),
    ).rejects.toThrow(/Grading snapshot not found.*\/x\/graders\.json/);
  });
});
