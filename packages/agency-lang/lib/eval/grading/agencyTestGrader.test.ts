import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgencyTestGrader, RunWrapper } from "./agencyTestGrader.js";
import { parseReportEnvelope, ReportEnvelope } from "./reportEnvelope.js";
import type { GraderInput } from "./types.js";

function makeWorkdir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atg-workdir-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function makeHarnessPair(): { harnessAgency: string; harnessJson: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atg-harness-"));
  const harnessAgency = path.join(dir, "suite-tests.agency");
  const harnessJson = path.join(dir, "suite-tests.test.json");
  fs.writeFileSync(harnessAgency, "export node t(): number {\n  return 1\n}\n");
  fs.writeFileSync(
    harnessJson,
    JSON.stringify({
      sourceFile: "suite-tests.agency",
      tests: [
        { nodeName: "t", input: "", expectedOutput: "1", evaluationCriteria: [{ type: "exact" }] },
      ],
    }),
  );
  return { harnessAgency, harnessJson };
}

function graderInput(workdir: string): GraderInput {
  return {
    test: { id: "t" },
    run: { workdir },
    runAgency: () => {
      throw new Error("not used");
    },
  } as unknown as GraderInput;
}

/** Stub wrapper writing a fixed envelope; records its calls. */
function stubWrapper(envelope: ReportEnvelope | "skip-write" | "malformed"): {
  runWrapper: RunWrapper;
  calls: Parameters<RunWrapper>[0][];
} {
  const calls: Parameters<RunWrapper>[0][] = [];
  const runWrapper: RunWrapper = (args) => {
    calls.push(args);
    if (envelope === "skip-write") return { stdout: "no report today" };
    if (envelope === "malformed") {
      fs.writeFileSync(args.reportPath, "{ nope");
      return { stdout: "" };
    }
    fs.writeFileSync(args.reportPath, JSON.stringify(envelope));
    return { stdout: "" };
  };
  return { runWrapper, calls };
}

const TESTED = (cases: { node: string; pass: boolean; feedback: string }[]): ReportEnvelope => ({
  status: "tested",
  report: { pass: cases.every((c) => c.pass), cases },
});

describe("parseReportEnvelope", () => {
  test("accepts both branches exactly", () => {
    expect(parseReportEnvelope(JSON.stringify(TESTED([]))).status).toBe("tested");
    expect(
      parseReportEnvelope(JSON.stringify({ status: "could-not-test", feedback: "why" })).status,
    ).toBe("could-not-test");
  });

  test.each([
    ["junk text", "not json"],
    ["unknown discriminant", JSON.stringify({ status: "meh", feedback: "x" })],
    ["extra field", JSON.stringify({ status: "could-not-test", feedback: "x", extra: 1 })],
    [
      "bad nested case",
      JSON.stringify({ status: "tested", report: { pass: true, cases: [{ node: 1 }] } }),
    ],
  ])("rejects %s", (_, text) => {
    expect(() => parseReportEnvelope(text)).toThrow(/envelope/);
  });
});

describe("AgencyTestGrader (seam-injected)", () => {
  const pair = makeHarnessPair();

  test("scores the passing fraction; threshold 1 gates partial credit", async () => {
    const { runWrapper } = stubWrapper(
      TESTED([
        { node: "a", pass: true, feedback: "" },
        { node: "b", pass: true, feedback: "" },
        { node: "c", pass: true, feedback: "" },
        { node: "d", pass: false, feedback: "off by one" },
      ]),
    );
    const grader = new AgencyTestGrader({ ...pair, name: "suite-tests" }, runWrapper);
    const workdir = makeWorkdir({ "fib.agency": "export def f(): number {\n  return 1\n}\n" });
    const grade = await grader.run(graderInput(workdir));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.75 });
    expect(grader.passes(grade)).toBe(false);
    expect(grade.feedback).toContain("off by one");

    const green = new AgencyTestGrader(
      { ...pair, name: "suite-tests" },
      stubWrapper(TESTED([{ node: "a", pass: true, feedback: "" }])).runWrapper,
    );
    const g = await green.run(graderInput(workdir));
    expect(g.score).toEqual({ kind: "scalar", value: 1 });
    expect(green.passes(g)).toBe(true);
  });

  test("could-not-test scores 0 with the feedback verbatim", async () => {
    const { runWrapper } = stubWrapper({ status: "could-not-test", feedback: "compile exploded" });
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    const grade = await grader.run(graderInput(makeWorkdir({})));
    expect(grade.score).toEqual({ kind: "scalar", value: 0 });
    expect(grade.feedback).toBe("compile exploded");
  });

  test("missing and malformed envelopes score 0 with the stdout tail", async () => {
    const missing = new AgencyTestGrader(
      { ...pair, name: "n" },
      stubWrapper("skip-write").runWrapper,
    );
    const g1 = await missing.run(graderInput(makeWorkdir({})));
    expect(g1.score).toEqual({ kind: "scalar", value: 0 });
    expect(g1.feedback).toContain("no report");

    const malformed = new AgencyTestGrader(
      { ...pair, name: "n" },
      stubWrapper("malformed").runWrapper,
    );
    const g2 = await malformed.run(graderInput(makeWorkdir({})));
    expect(g2.score).toEqual({ kind: "scalar", value: 0 });
    expect(g2.feedback).toMatch(/envelope/);
  });

  test("no workdir fails without running the wrapper", async () => {
    const { runWrapper, calls } = stubWrapper(TESTED([]));
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    const grade = await grader.run(graderInput(""));
    expect(grade.score).toEqual({ kind: "scalar", value: 0 });
    expect(grade.feedback).toContain("no workdir");
    expect(calls.length).toBe(0);
  });

  test("copies the workdir wholesale, overwrites both harness files from the snapshot, preserves symlinks", async () => {
    const observed: Record<string, string> = {};
    let sawSymlink = false;
    const runWrapper: RunWrapper = (args) => {
      for (const name of fs.readdirSync(args.scratchDir)) {
        const p = path.join(args.scratchDir, name);
        if (fs.lstatSync(p).isSymbolicLink()) {
          sawSymlink = true;
          continue;
        }
        observed[name] = fs.readFileSync(p, "utf-8");
      }
      fs.writeFileSync(args.reportPath, JSON.stringify(TESTED([])));
      return { stdout: "" };
    };
    const workdir = makeWorkdir({
      "fib.agency": "the solution",
      "extra.agency": "another file",
      // The agent tampered with its seeded harness copy.
      "suite-tests.agency": "export node t(): number {\n  return 999\n}\n",
    });
    fs.symlinkSync("/nowhere-real", path.join(workdir, "link.agency"));
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    await grader.run(graderInput(workdir));
    expect(observed["fib.agency"]).toBe("the solution");
    expect(observed["extra.agency"]).toBe("another file");
    expect(observed["suite-tests.agency"]).toBe(fs.readFileSync(pair.harnessAgency, "utf-8"));
    expect(observed["suite-tests.test.json"]).toBe(fs.readFileSync(pair.harnessJson, "utf-8"));
    expect(sawSymlink).toBe(true);
  });

  test("a symlink planted at a harness destination never clobbers its target", async () => {
    // The attack: the solution ships suite-tests.agency as a symlink to a
    // writable host file; a following copy would overwrite that file with
    // the snapshot harness.
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "atg-host-"));
    const targetAgency = path.join(hostDir, "precious-a.txt");
    const targetJson = path.join(hostDir, "precious-b.txt");
    fs.writeFileSync(targetAgency, "HOST CONTENT A");
    fs.writeFileSync(targetJson, "HOST CONTENT B");
    const workdir = makeWorkdir({ "fib.agency": "the solution" });
    fs.symlinkSync(targetAgency, path.join(workdir, "suite-tests.agency"));
    fs.symlinkSync(targetJson, path.join(workdir, "suite-tests.test.json"));

    const observed: Record<string, string> = {};
    const links: string[] = [];
    const runWrapper: RunWrapper = (args) => {
      for (const name of fs.readdirSync(args.scratchDir)) {
        const p = path.join(args.scratchDir, name);
        if (fs.lstatSync(p).isSymbolicLink()) links.push(name);
        else observed[name] = fs.readFileSync(p, "utf-8");
      }
      fs.writeFileSync(args.reportPath, JSON.stringify(TESTED([])));
      return { stdout: "" };
    };
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    await grader.run(graderInput(workdir));
    expect(fs.readFileSync(targetAgency, "utf-8")).toBe("HOST CONTENT A");
    expect(fs.readFileSync(targetJson, "utf-8")).toBe("HOST CONTENT B");
    // The scratch copies became fresh regular files holding the snapshot.
    expect(links).toEqual([]);
    expect(observed["suite-tests.agency"]).toBe(fs.readFileSync(pair.harnessAgency, "utf-8"));
    expect(observed["suite-tests.test.json"]).toBe(fs.readFileSync(pair.harnessJson, "utf-8"));
  });

  test("a directory planted at a harness destination is replaced by the snapshot file", async () => {
    const workdir = makeWorkdir({ "fib.agency": "the solution" });
    fs.mkdirSync(path.join(workdir, "suite-tests.agency"));
    fs.writeFileSync(path.join(workdir, "suite-tests.agency", "inner.txt"), "x");
    fs.mkdirSync(path.join(workdir, "suite-tests.test.json"));

    const observed: Record<string, string> = {};
    const runWrapper: RunWrapper = (args) => {
      for (const name of fs.readdirSync(args.scratchDir)) {
        const p = path.join(args.scratchDir, name);
        if (fs.lstatSync(p).isFile()) observed[name] = fs.readFileSync(p, "utf-8");
      }
      fs.writeFileSync(args.reportPath, JSON.stringify(TESTED([])));
      return { stdout: "" };
    };
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    await grader.run(graderInput(workdir));
    expect(observed["suite-tests.agency"]).toBe(fs.readFileSync(pair.harnessAgency, "utf-8"));
    expect(observed["suite-tests.test.json"]).toBe(fs.readFileSync(pair.harnessJson, "utf-8"));
  });

  test("forwards sourceFilename and maxCost; cleans up scratch and report dirs", async () => {
    const { runWrapper, calls } = stubWrapper(TESTED([]));
    const grader = new AgencyTestGrader({ ...pair, name: "n", maxCost: 0.25 }, runWrapper);
    await grader.run(graderInput(makeWorkdir({})));
    expect(calls[0].sourceFilename).toBe("suite-tests.agency");
    expect(calls[0].maxCost).toBe(0.25);
    expect(fs.existsSync(calls[0].scratchDir)).toBe(false);
    expect(fs.existsSync(path.dirname(calls[0].reportPath))).toBe(false);
  });

  test("cleanup runs when the wrapper throws", async () => {
    let seenScratch = "";
    const runWrapper: RunWrapper = (args) => {
      seenScratch = args.scratchDir;
      throw new Error("boom");
    };
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    const grade = await grader.run(graderInput(makeWorkdir({})));
    expect(grade.score).toEqual({ kind: "scalar", value: 0 });
    expect(fs.existsSync(seenScratch)).toBe(false);
  });

  test("rebindExternalFile points harness copies at the snapshot", async () => {
    const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "atg-snap-"));
    const snapAgency = path.join(snapDir, "stored-agency");
    const snapJson = path.join(snapDir, "stored-json");
    fs.writeFileSync(snapAgency, "SNAPSHOT AGENCY");
    fs.writeFileSync(snapJson, "SNAPSHOT JSON");
    const observed: Record<string, string> = {};
    const runWrapper: RunWrapper = (args) => {
      for (const name of fs.readdirSync(args.scratchDir)) {
        observed[name] = fs.readFileSync(path.join(args.scratchDir, name), "utf-8");
      }
      fs.writeFileSync(args.reportPath, JSON.stringify(TESTED([])));
      return { stdout: "" };
    };
    const grader = new AgencyTestGrader({ ...pair, name: "n" }, runWrapper);
    grader.rebindExternalFile(pair.harnessAgency, snapAgency);
    grader.rebindExternalFile(pair.harnessJson, snapJson);
    await grader.run(graderInput(makeWorkdir({})));
    expect(observed["suite-tests.agency"]).toBe("SNAPSHOT AGENCY");
    expect(observed["suite-tests.test.json"]).toBe("SNAPSHOT JSON");
  });
});
