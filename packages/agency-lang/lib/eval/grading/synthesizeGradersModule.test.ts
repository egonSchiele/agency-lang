import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  synthesizeGradersModule,
  snapshotAgencyTestGraders,
  suiteIdentityDigest,
  agencyTestsSourceIdentity,
} from "./synthesizeGradersModule.js";
import { loadGradingSnapshot, type GradersSnapshot } from "./gradingModule.js";
import { loadInputs } from "../loadInputs.js";
import type { Test } from "../runTypes.js";

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HARNESS_AGENCY = "export node t(): number {\n  return 1\n}\n";
function harnessJson(extra: object = {}): string {
  return JSON.stringify({
    tests: [
      {
        nodeName: "t",
        input: "",
        expectedOutput: "1",
        evaluationCriteria: [{ type: "exact" }],
        ...extra,
      },
    ],
  });
}

/** An eval test dir with discovered pairs, loadInputs-shaped. */
function makeEvalTestDir(args: { holdout?: boolean; gradersTs?: string } = {}): string {
  const suiteDir = makeDir("sgm-suite-");
  const testDir = path.join(suiteDir, "mytest");
  fs.mkdirSync(path.join(testDir, "files"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "test.json"), JSON.stringify({ input: "do the thing" }));
  fs.writeFileSync(path.join(testDir, "files", "suite-tests.agency"), HARNESS_AGENCY);
  fs.writeFileSync(path.join(testDir, "files", "suite-tests.test.json"), harnessJson());
  fs.writeFileSync(path.join(testDir, "files", "seeded.txt"), "seeded");
  if (args.holdout) {
    fs.mkdirSync(path.join(testDir, "holdout"));
    fs.writeFileSync(path.join(testDir, "holdout", "suite-holdout.agency"), HARNESS_AGENCY);
    fs.writeFileSync(path.join(testDir, "holdout", "suite-holdout.test.json"), harnessJson());
  }
  if (args.gradersTs !== undefined) {
    fs.writeFileSync(path.join(testDir, "graders.ts"), args.gradersTs);
  }
  return suiteDir;
}

function loadOne(suiteDir: string): Test {
  const tests = loadInputs(suiteDir, undefined, { requireGoal: false });
  return tests[0];
}

describe("discovery (loadInputs)", () => {
  test("files/ and holdout/ pairs are discovered with visibility; holdout is never seeded", () => {
    const suiteDir = makeEvalTestDir({ holdout: true });
    const test1 = loadOne(suiteDir);
    expect(test1.agencyTests?.map((d) => [d.name, d.visibility])).toEqual([
      ["suite-tests", "visible"],
      ["suite-holdout", "holdout"],
    ]);
    // Seeding copies only the test's files dir (runAgent's seedFiles), so
    // holdout content is structurally outside what the agent sees.
    expect(test1.files!.endsWith(`${path.sep}files`)).toBe(true);
    expect(fs.readdirSync(test1.files!).sort()).toEqual([
      "seeded.txt",
      "suite-tests.agency",
      "suite-tests.test.json",
    ]);
  });

  test("no .test.json anywhere leaves the field absent", () => {
    const suiteDir = makeDir("sgm-none-");
    const testDir = path.join(suiteDir, "t");
    fs.mkdirSync(path.join(testDir, "files"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "test.json"), JSON.stringify({ input: "x", goal: "g" }));
    fs.writeFileSync(path.join(testDir, "files", "a.txt"), "a");
    expect(loadOne(suiteDir).agencyTests).toBeUndefined();
  });

  test("a missing sibling harness and a duplicate basename are refused by name", () => {
    const suiteDir = makeEvalTestDir();
    const testDir = path.join(suiteDir, "mytest");
    fs.writeFileSync(path.join(testDir, "files", "lonely.test.json"), harnessJson());
    expect(() => loadOne(suiteDir)).toThrow(/lonely\.agency/);
    fs.rmSync(path.join(testDir, "files", "lonely.test.json"));

    fs.mkdirSync(path.join(testDir, "holdout"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "holdout", "suite-tests.agency"), HARNESS_AGENCY);
    fs.writeFileSync(path.join(testDir, "holdout", "suite-tests.test.json"), harnessJson());
    expect(() => loadOne(suiteDir)).toThrow(/appears twice/);
  });

  test("nested .test.json files are ignored: discovery is non-recursive", () => {
    const suiteDir = makeEvalTestDir();
    const nested = path.join(suiteDir, "mytest", "files", "deep");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "inner.test.json"), harnessJson());
    const test1 = loadOne(suiteDir);
    expect(test1.agencyTests?.map((d) => d.name)).toEqual(["suite-tests"]);
  });
});

describe("synthesizeGradersModule", () => {
  test("deterministic: permuted pairs yield byte-identical source", () => {
    const a = { harnessAgency: "/x/a.agency", harnessJson: "/x/a.test.json", name: "a" };
    const b = { harnessAgency: "/x/b.agency", harnessJson: "/x/b.test.json", name: "b" };
    expect(synthesizeGradersModule({ pairs: [a, b] }).moduleSource).toBe(
      synthesizeGradersModule({ pairs: [b, a] }).moduleSource,
    );
  });

  test("sibling exports compose whether single or array", () => {
    const single = synthesizeGradersModule({
      siblingGradersPath: "/x/graders.ts",
      pairs: [],
    }).moduleSource;
    expect(single).toContain("Array.isArray(sibling) ? sibling : [sibling]");
  });
});

describe("suite identity", () => {
  test("distinct suites, delimiter-like sources, and shas never collide; inline is tagged", () => {
    const ids = [
      agencyTestsSourceIdentity({ source: "a/b" }, "t"),
      agencyTestsSourceIdentity({ source: "a", sha: "b" }, "t"),
      agencyTestsSourceIdentity({ source: "a" }, "t"),
      agencyTestsSourceIdentity({ source: "a", sha: "c" }, "t"),
      agencyTestsSourceIdentity(undefined, "t"),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(suiteIdentityDigest(undefined)).toBe("inline");
  });
});

describe("snapshotAgencyTestGraders", () => {
  function loaded(suiteDir: string): Test {
    return loadOne(suiteDir);
  }

  test(
    "two snapshots of one suite share a revision; a harness edit changes it",
    { timeout: 60_000 },
    async () => {
      const suiteDir = makeEvalTestDir();
      const test1 = loaded(suiteDir);
      const suite = { source: "git:example" };
      const snap1 = await snapshotAgencyTestGraders({ test: test1, suite });
      const snap2 = await snapshotAgencyTestGraders({ test: test1, suite });
      expect(snap1.revision).toBeDefined();
      expect(snap1.revision).toEqual(snap2.revision);
      expect(snap1.source).toBe(agencyTestsSourceIdentity(suite, test1.id!));

      fs.appendFileSync(
        path.join(suiteDir, "mytest", "files", "suite-tests.agency"),
        "// edited\n",
      );
      const snap3 = await snapshotAgencyTestGraders({ test: loaded(suiteDir), suite });
      expect(snap3.revision!.sha256).not.toBe(snap1.revision!.sha256);
      expect(snap3.revision!.sourceIdentity).toBe(snap1.revision!.sourceIdentity);
    },
  );

  test(
    "swapping contents between two named harnesses changes the revision",
    { timeout: 60_000 },
    async () => {
      const suiteDir = makeEvalTestDir();
      const filesDir = path.join(suiteDir, "mytest", "files");
      const otherAgency = "export node t(): number {\n  return 2\n}\n";
      fs.writeFileSync(path.join(filesDir, "other-tests.agency"), otherAgency);
      fs.writeFileSync(path.join(filesDir, "other-tests.test.json"), harnessJson());
      const before = await snapshotAgencyTestGraders({ test: loaded(suiteDir), suite: undefined });
      // The content MULTISET is unchanged; only which name holds which
      // content flips — an anonymous sorted-hash revision would miss this.
      fs.writeFileSync(path.join(filesDir, "suite-tests.agency"), otherAgency);
      fs.writeFileSync(path.join(filesDir, "other-tests.agency"), HARNESS_AGENCY);
      const after = await snapshotAgencyTestGraders({ test: loaded(suiteDir), suite: undefined });
      expect(after.revision!.sha256).not.toBe(before.revision!.sha256);
    },
  );

  test(
    "a recorded revision survives a fresh snapshot load, including a copied directory",
    { timeout: 60_000 },
    async () => {
      const suiteDir = makeEvalTestDir();
      const snap = await snapshotAgencyTestGraders({
        test: loaded(suiteDir),
        suite: { source: "s" },
      });
      const writeStore = (snapshot: GradersSnapshot): string => {
        const dir = makeDir("sgm-store-");
        for (const file of snapshot.files) {
          fs.writeFileSync(path.join(dir, file.name), file.content);
        }
        return dir;
      };
      const store = writeStore(snap);
      const recorded = {
        source: snap.source,
        bundleFile: snap.bundleFile,
        judgeFiles: snap.judgeFiles,
        revision: snap.revision!,
      };
      const graders = await loadGradingSnapshot(store, recorded);
      const expected = `${snap.revision!.sourceIdentity}@${snap.revision!.sha256}`;
      expect(graders.map((g) => g.revision)).toEqual([expected]);

      // The contract this metadata serves: a copied run directory grades
      // under the SAME revision.
      const copy = makeDir("sgm-copy-");
      fs.cpSync(store, copy, { recursive: true });
      const copied = await loadGradingSnapshot(copy, recorded);
      expect(copied.map((g) => g.revision)).toEqual([expected]);

      // Legacy shape (no revision): the code-only identity, untouched.
      const legacy = await loadGradingSnapshot(store, {
        source: snap.source,
        bundleFile: snap.bundleFile,
        judgeFiles: snap.judgeFiles,
      });
      expect(legacy[0].revision).toMatch(new RegExp(`^${snap.source}@`));
      expect(legacy[0].revision).not.toBe(expected);
    },
  );

  test(
    "preflight refuses approve answers and non-sibling sourceFiles by name",
    { timeout: 60_000 },
    async () => {
      const approveDir = makeEvalTestDir();
      fs.writeFileSync(
        path.join(approveDir, "mytest", "files", "suite-tests.test.json"),
        harnessJson({ interruptHandlers: [{ action: "approve" }] }),
      );
      await expect(
        snapshotAgencyTestGraders({ test: loadOne(approveDir), suite: undefined }),
      ).rejects.toThrow(/scripted approval cannot take effect/);

      const foreignDir = makeEvalTestDir();
      fs.writeFileSync(
        path.join(foreignDir, "mytest", "files", "suite-tests.test.json"),
        JSON.stringify({
          sourceFile: "other.agency",
          tests: [
            {
              nodeName: "t",
              input: "",
              expectedOutput: "1",
              evaluationCriteria: [{ type: "exact" }],
            },
          ],
        }),
      );
      await expect(
        snapshotAgencyTestGraders({ test: loadOne(foreignDir), suite: undefined }),
      ).rejects.toThrow(/sibling harness/);
    },
  );

  test(
    "editing a file the sibling graders.ts imports changes the revision",
    { timeout: 60_000 },
    async () => {
      const suiteDir = makeEvalTestDir({
        gradersTs:
          'import { grader } from "agency-lang/eval";\n' +
          'import { threshold } from "./gradersHelper.ts";\n' +
          'export default grader(() => threshold > 0, { name: "sibling-check" });\n',
      });
      const helperPath = path.join(suiteDir, "mytest", "gradersHelper.ts");
      fs.writeFileSync(helperPath, "export const threshold = 1;\n");
      const before = await snapshotAgencyTestGraders({ test: loaded(suiteDir), suite: undefined });
      // Only the transitively imported helper changes; the entry file text
      // is untouched, so an entry-only hash would keep the old revision.
      fs.writeFileSync(helperPath, "export const threshold = 2;\n");
      const after = await snapshotAgencyTestGraders({ test: loaded(suiteDir), suite: undefined });
      expect(after.revision!.sha256).not.toBe(before.revision!.sha256);
    },
  );

  test(
    "a sibling graders.ts composes into the snapshot with distinct names",
    { timeout: 60_000 },
    async () => {
      const suiteDir = makeEvalTestDir({
        gradersTs:
          'import { grader } from "agency-lang/eval";\n' +
          'export default grader(() => true, { name: "sibling-check" });\n',
      });
      const snap = await snapshotAgencyTestGraders({
        test: loadOne(suiteDir),
        suite: undefined,
      });
      expect(snap.bundleFile).toMatch(/\.mjs$/);
      // The harness pair rode along as external files.
      expect(Object.keys(snap.judgeFiles).sort()).toEqual(
        expect.arrayContaining([expect.stringContaining("suite-tests")]),
      );
    },
  );

  test(
    "preflight clearly refuses external files from a sibling grader",
    { timeout: 60_000 },
    async () => {
      const suiteDir = makeEvalTestDir({
        gradersTs: `
          export default {
            run: async () => 1,
            name: () => "sibling-check",
            mustPass: () => false,
            externalFiles: () => ["judge.txt"],
          };
        `,
      });
      fs.writeFileSync(path.join(suiteDir, "mytest", "judge.txt"), "judge prompt");
      await expect(
        snapshotAgencyTestGraders({ test: loaded(suiteDir), suite: undefined }),
      ).rejects.toThrow(/combined with Agency test graders cannot use externalFiles/);
    },
  );
});
