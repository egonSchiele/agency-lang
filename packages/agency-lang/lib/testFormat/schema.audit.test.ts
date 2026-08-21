/** Repo-wide fixture audit: every .test.json must parse under the strict
 *  full profile, so a schema tightening that would break a shipped fixture
 *  fails HERE instead of at someone's test run. */
import { describe, test, expect } from "vitest";
import * as fs from "fs";
import { execSync } from "child_process";
import { parseTestFileFull } from "./schema.js";

describe("strict full profile vs shipped fixtures", () => {
  test("every fixture in tests/, evals/, and examples/ parses", () => {
    const files = execSync("find tests evals examples -name '*.test.json'", {
      cwd: process.cwd(),
    })
      .toString()
      .trim()
      .split("\n");
    expect(files.length).toBeGreaterThan(500);
    const failures: string[] = [];
    for (const file of files) {
      try {
        parseTestFileFull(fs.readFileSync(file, "utf-8"), file);
      } catch (e) {
        failures.push(`${file}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
