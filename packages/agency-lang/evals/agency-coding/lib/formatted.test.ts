import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import type { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { loadedRun } from "@/eval/grading/testUtils.js";
import { formatted } from "./formatted.js";

async function gradeSource(source: string) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "formatted-"));
  fs.writeFileSync(path.join(workdir, "solution.agency"), source);
  const grader = formatted() as { run(input: unknown): Promise<{ score: { pass?: boolean } }> };
  const grade = await grader.run({
    test: { id: "t", input: { assignment: "", outFile: "solution.agency" } },
    run: { ...loadedRun(""), workdir },
    runAgency: {} as AgencyRunner,
  });
  return grade.score.pass;
}

describe("formatted", () => {
  it("passes a file the formatter would leave alone", async () => {
    expect(await gradeSource("export def f(x: number): number {\n  return x + 1\n}\n")).toBe(true);
  });

  it("fails a file the formatter would change", async () => {
    expect(await gradeSource("export def f(x:number):number { return x+1 }\n")).toBe(false);
  });

  it("fails a file that does not parse", async () => {
    expect(await gradeSource("def (")).toBe(false);
  });
});
