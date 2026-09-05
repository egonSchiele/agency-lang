import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { _read, _write, _readBinary, _writeBinary } from "./builtins.js";
import { _multiedit, _mkdir, _copy, _move, _remove } from "./fs.js";
import { _ls, _glob, _grep } from "./shell.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

/**
 * The window between an interrupt and its approval. A wrapper realpaths
 * the directory before raising, so the approver sees "base/approved". If
 * that directory is renamed and a link planted in its place while the
 * prompt is pending, the primitive that runs after approval must refuse
 * the link rather than treat its target as the approved root.
 */
type Fixture = { base: string; approved: string; outside: string };

function build(prefix: string): Fixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), `.approved-${prefix}-`)));
  const approved = path.join(base, "approved");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(approved, "sub"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(approved, "a.txt"), "inside");
  fs.writeFileSync(path.join(approved, "sub", "s.txt"), "inside");
  fs.writeFileSync(path.join(outside, "a.txt"), "secret");
  return { base, approved, outside };
}

/** The swap: the approved directory becomes a link to outside. */
function swap(fixture: Fixture): void {
  fs.renameSync(fixture.approved, path.join(fixture.base, "approved.moved"));
  fs.symlinkSync(fixture.outside, fixture.approved);
}

function outsideUntouched(fixture: Fixture): void {
  expect(fs.readdirSync(fixture.outside)).toEqual(["a.txt"]);
  expect(fs.readFileSync(path.join(fixture.outside, "a.txt"), "utf8")).toBe("secret");
}

const grepQuery = {
  pattern: "secret",
  flags: "",
  ignoreCase: false,
  wholeWord: false,
  filesOnly: false,
  invert: false,
};

/** Each primitive called the way its wrapper calls it after approval,
 *  with the canonical directory the approver saw. */
const CASES: Record<string, (f: Fixture) => Promise<unknown>> = {
  _read: (f) => _read(f.approved, "a.txt"),
  _readBinary: (f) => _readBinary(f.approved, "a.txt"),
  _write: (f) => _write(f.approved, "a.txt", "payload"),
  _writeBinary: (f) => _writeBinary(f.approved, "a.txt", Buffer.from("payload").toString("base64")),
  _multiedit: (f) =>
    _multiedit(f.approved, "a.txt", [{ oldText: "secret", newText: "x", replaceAll: false }]),
  _mkdir: (f) => _mkdir(path.join(f.approved, "made")),
  _copy: (f) => _copy(path.join(f.approved, "a.txt"), path.join(f.approved, "b.txt")),
  _move: (f) => _move(path.join(f.approved, "a.txt"), path.join(f.approved, "b.txt")),
  _remove: (f) => _remove(path.join(f.approved, "a.txt")),
  _ls: (f) => _ls(f.approved, ".", false),
  _glob: (f) => _glob(f.approved, ".", "*.txt", 10),
  _grep: (f) => _grep(f.approved, ".", grepQuery, 10),
};

describe.each(Object.keys(CASES))("%s after the approved directory became a link", (name) => {
  test("refuses and leaves outside untouched", async () => {
    const fixture = build(name.replace("_", ""));
    try {
      // The approved spelling works before the swap.
      expect(fs.existsSync(path.join(fixture.approved, "a.txt"))).toBe(true);
      swap(fixture);
      // Plain fs would now follow the link to the outside file.
      expect(fs.readFileSync(path.join(fixture.approved, "a.txt"), "utf8")).toBe("secret");
      await expect(CASES[name](fixture)).rejects.toThrow(/symlink/);
      outsideUntouched(fixture);
    } finally {
      expect(safeDeleteDirectoryWithin(process.cwd(), fixture.base).success).toBe(true);
    }
  });
});
