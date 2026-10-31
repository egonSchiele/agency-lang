import { it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { lintSource } from "./registry.js";

/** Rules the repo's own Agency code must satisfy. AL0004 guards a safety
 *  property: a rebuilt failure loses its `rejected` flag, and the user's
 *  "no" then reaches the model as a tool error it may retry. A hint-level
 *  finding never fails `agency lint`, so this test is what keeps the
 *  stdlib and the agents clean of it. */
const ENFORCED_CODES = ["AL0004"];
const ROOTS = ["stdlib", "lib/agents"];

function agencyFilesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return agencyFilesUnder(full);
      return entry.isFile() && entry.name.endsWith(".agency") ? [full] : [];
    })
    .sort();
}

it("the stdlib and the agents have no enforced lint findings", () => {
  const files = ROOTS.flatMap(agencyFilesUnder);
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.flatMap((file) =>
    lintSource(fs.readFileSync(file, "utf8"), file, {})
      .filter((f) => ENFORCED_CODES.includes(f.code))
      .map((f) => `${file}:${f.loc.line + 1}:${f.loc.col + 1} ${f.code} ${f.message}`),
  );
  expect(offenders).toEqual([]);
});
