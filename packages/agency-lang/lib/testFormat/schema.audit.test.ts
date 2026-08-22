/** Repo-wide fixture audit: every .test.json must parse under the strict
 *  full profile, so a schema tightening that would break a shipped fixture
 *  fails HERE instead of at someone's test run. */
import { describe, test, expect } from "vitest";
import * as fs from "fs";
import { findRecursively } from "../utils/findRecursively.js";
import { parseTestFileFull } from "./schema.js";

describe("strict full profile vs shipped fixtures", () => {
  test("every fixture in tests/, evals/, and examples/ parses", () => {
    const files = ["tests", "evals", "examples"]
      .filter((dir) => fs.existsSync(dir))
      .flatMap((dir) => [...findRecursively(dir, ".test.json")].map((f) => f.path));
    expect(files.length).toBeGreaterThan(0);
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
