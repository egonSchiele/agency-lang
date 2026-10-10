import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _compileFileOutputs } from "./agencyCli.js";

it("refuses an approved directory replaced by a symlink", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "agency-cli-approval-"));
  try {
    const approved = join(base, "approved");
    const outside = join(base, "outside");
    mkdirSync(approved);
    mkdirSync(outside);
    writeFileSync(join(outside, "main.agency"), 'export node main() { return "outside" }');
    renameSync(approved, join(base, "original"));
    symlinkSync(outside, approved);
    expect(() => _compileFileOutputs(approved, "main.agency")).toThrow(/symlink/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
