import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgencyConfig } from "@/config.js";
import { BaseGrader } from "./baseGrader.js";
import { loadGradingModule, loadGradingSnapshot, snapshotGradingModule } from "./gradingModule.js";

const cfg: AgencyConfig = {};

describe("loadGradingModule", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, src: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, src);
    return p;
  };

  it("loads a default-exported metric function as one grader", async () => {
    const file = write(
      "grading.ts",
      `export default ({ output }: any) => (output === "Paris" ? 1 : 0);`,
    );
    const graders = await loadGradingModule(file, cfg);
    expect(graders).toHaveLength(1);
    expect(graders[0]).toBeInstanceOf(BaseGrader);
  });

  it("loads a default-exported array of graders", async () => {
    const file = write(
      "grading.ts",
      `
      // Grader-shaped objects (the duck type toGrader accepts) so this temp-dir
      // module needs no import; plain functions would both be named "fn".
      const named = (name: string) => ({ run: async () => 1, name: () => name, mustPass: () => false });
      export default [named("a"), named("b")];
    `,
    );
    const graders = await loadGradingModule(file, cfg);
    expect(graders).toHaveLength(2);
  });

  it("refuses two graders with the same name, since scores are keyed by name", async () => {
    const file = write(
      "grading.ts",
      `
      const a = ({ output }: any) => output === "x";
      const b = ({ output }: any) => 0.5;
      export default [a, b];
    `,
    );
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(
      /two graders named "fn".*distinct name/,
    );
  });

  it("throws a clear error when there is no default export", async () => {
    const file = write("grading.ts", `export const notDefault = () => 1;`);
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(/must default-export/);
  });

  it("throws a clear error when an exported entry is not a grader", async () => {
    const file = write("grading.ts", `export default [123];`);
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(
      /expected a grader function or grader instance/,
    );
  });
});

describe("grading snapshots", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A grader-shaped object (no import, so the module is hermetic) that reads a
  // sibling prompt file by path, the way LlmJudge reads a custom judge file.
  const moduleSource = () => `
    import { readFileSync } from "fs";
    const declared = ${JSON.stringify(path.join(dir, "judge.agency"))};
    let promptFile = declared;
    export default [{
      run: async () => ({ score: { kind: "scalar", value: readFileSync(promptFile, "utf8").length } }),
      name: () => "prompted",
      mustPass: () => false,
      externalFiles: () => [declared],
      rebindExternalFile: (from, to) => { if (from === declared) promptFile = to; },
    }];
  `;

  it("bundles the module with its judge file, and loading the snapshot rebinds the file to the stored copy", async () => {
    const modulePath = path.join(dir, "graders.ts");
    fs.writeFileSync(modulePath, moduleSource());
    fs.writeFileSync(path.join(dir, "judge.agency"), "judge v1");

    const snapshot = await snapshotGradingModule(modulePath);
    expect(snapshot.source).toBe(modulePath);
    expect(snapshot.files.map((f) => f.name)).toEqual([
      snapshot.bundleFile,
      ...Object.values(snapshot.judgeFiles),
    ]);
    expect(Object.keys(snapshot.judgeFiles)).toEqual([path.join(dir, "judge.agency")]);

    // Store the snapshot somewhere else entirely, then delete the originals.
    const gradersDir = path.join(dir, "copied-run", "graders");
    fs.mkdirSync(gradersDir, { recursive: true });
    for (const file of snapshot.files)
      fs.writeFileSync(path.join(gradersDir, file.name), file.content);
    fs.rmSync(modulePath);
    fs.rmSync(path.join(dir, "judge.agency"));

    const [loaded] = await loadGradingSnapshot(gradersDir, snapshot);
    // `externalFiles` still names the declared path; the read below proves the
    // grader now reads the stored copy (the original is gone).
    expect(loaded.externalFiles()).toEqual([path.join(dir, "judge.agency")]);
    expect(loaded.revision).toBe(`${modulePath}@${snapshot.bundleFile.replace(/\.mjs$/, "")}`);
    const grade = await loaded.run({
      test: { id: "t" },
      run: { output: null, traceId: "t", workdir: "", record: {} as never },
      runAgency: {} as never,
    });
    expect(grade.score).toEqual({ kind: "scalar", value: "judge v1".length });
  });

  it("a missing snapshot file names the recorded source and the --graders escape hatch", async () => {
    await expect(
      loadGradingSnapshot(dir, { source: "/x/graders.ts", bundleFile: "nope.mjs", judgeFiles: {} }),
    ).rejects.toThrow(/Grading snapshot not found.*\/x\/graders\.ts.*--graders/);
  });
});
