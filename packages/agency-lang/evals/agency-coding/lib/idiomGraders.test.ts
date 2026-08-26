import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { toGrader } from "agency-lang/eval";

import { handlerIdiomGraders } from "./idiomGraders.js";

const idiomatic = fs.readFileSync(
  path.join(__dirname, "fixtures/uses-match-idiomatic.agency"),
  "utf8",
);
const ifChain = fs.readFileSync(
  path.join(__dirname, "fixtures/uses-match-if-chain.agency"),
  "utf8",
);

async function gradeSource(source: string | null): Promise<Record<string, boolean>> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "idiom-"));
  if (source !== null) fs.writeFileSync(path.join(workdir, "solution.agency"), source);
  const test = { input: { assignment: "", outFile: "solution.agency" } };
  const out: Record<string, boolean> = {};
  const run = { output: null, traceId: "t", workdir, record: {} as never };
  for (const g of handlerIdiomGraders().map(toGrader)) {
    const grade = await g.run({ test: test as never, run, runAgency: {} as never });
    out[g.name()] = grade.score.kind === "binary" && grade.score.pass;
  }
  return out;
}

describe("handlerIdiomGraders", () => {
  it("passes the match-with-guard solution on every grader", async () => {
    expect(await gradeSource(idiomatic)).toEqual({
      "match-on-effect": true,
      "no-if-chain-on-effect": true,
      "guard-arm": true,
      "match-on-result": true,
    });
  });

  it("fails the if-chain solution on every grader", async () => {
    expect(await gradeSource(ifChain)).toEqual({
      "match-on-effect": false,
      "no-if-chain-on-effect": false,
      "guard-arm": false,
      "match-on-result": false,
    });
  });

  it("fails everything when the solution is missing", async () => {
    expect(Object.values(await gradeSource(null))).toEqual([false, false, false, false]);
  });
});
