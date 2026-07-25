import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateDoc } from "../cli/doc.js";
import { manyFunctions } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";

const SMALL = 100;
const LARGE = 800;

// generateDoc reads the input file and writes markdown to an output dir each
// call, so it is re-runnable (it re-reads and overwrites). File I/O is part of
// the doc command's real cost — this is the one test here whose timing isn't
// pure CPU, so if any line proves flaky during the informational period, the
// disk write is the likely reason.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perf-doc-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function docBuild(n: number): () => void {
  const inFile = path.join(tmp, `in-${n}.agency`);
  fs.writeFileSync(inFile, manyFunctions(n), "utf-8");
  const outDir = path.join(tmp, `out-${n}`);
  fs.mkdirSync(outDir, { recursive: true });
  return () => generateDoc({}, inFile, outDir);
}

describe("doc scaling", () => {
  it("scales linearly in file size", () => {
    docBuild(LARGE)(); // work-happened: produces output without throwing
    expect(fs.readdirSync(path.join(tmp, `out-${LARGE}`)).length).toBeGreaterThan(0);

    expectPerf("doc:generateDoc", growthFactor(docBuild, SMALL, LARGE), GROWTH_BOUND);
  });
});
