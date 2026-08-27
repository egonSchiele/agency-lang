// A source string checked "as if it were a file in dir": its relative
// imports resolve against dir's files, and the draft itself never touches
// the disk. This is what std::agency typecheck(source, dir) does for the
// coding agent, whose draft imports a seeded sibling before it is saved.
import { afterEach, describe, expect, test } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { typeCheckSource } from "./typecheck.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const HELPER = "export def helperValue(): number { return 7 }\n";
const DRAFT =
  'import { helperValue } from "./helper.agency"\nexport node main(): number { return helperValue() }\n';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
  }
});

function dirWithHelper(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tc-draft-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
  return dir;
}

describe("typeCheckSource with an override path inside a directory", () => {
  test("resolves the draft's relative import against the directory, writing nothing", () => {
    const dir = dirWithHelper();
    const draftPath = path.join(dir, "draft.agency");
    const report = typeCheckSource(DRAFT, draftPath, {}, { [draftPath]: DRAFT });
    expect(report.errors).toEqual([]);
    expect(fs.existsSync(draftPath)).toBe(false);
  });

  test("without a directory the same draft cannot resolve its import", () => {
    expect(() => typeCheckSource(DRAFT)).toThrow(/helper\.agency/);
  });
});
