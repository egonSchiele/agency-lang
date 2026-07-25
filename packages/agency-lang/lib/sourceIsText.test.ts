import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Every source file must be text that git will diff.
 *
 * One NUL byte is enough to break this. `cache.ts` picked one up inside a
 * template literal, git classified the whole file as binary, and none of
 * its 146 lines appeared in the pull request. The code shipped unreviewed
 * and GitHub refused inline comments on it. `escaping.test.ts` had the
 * same problem and nobody noticed for months.
 *
 * A NUL is invisible in an editor, so only a test catches this. Write it
 * as `\0`, which is readable and has the identical runtime value.
 */

/**
 * A NUL byte, which is the exact thing git looks for.
 *
 * Git scans the start of a file and calls it binary if it finds a NUL.
 * Other control characters are fine: two test files in this repo contain
 * raw escape characters for ANSI colour output and diff normally.
 */
const NUL = /\0/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(full);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".mts") ? [full] : [];
  });
}

describe("source files stay text", () => {
  it("contains no raw NUL bytes", () => {
    const offenders = sourceFiles(path.join(process.cwd(), "lib"))
      .filter((file) => NUL.test(fs.readFileSync(file, "utf-8")))
      .map((file) => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});
