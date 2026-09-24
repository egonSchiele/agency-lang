import { describe, expect, test } from "vitest";
import fs from "fs";
import path from "path";
import { COMPILE_PIPELINE_ENTRY } from "./manifestTracker.js";
import { DOC_GENERATOR_ENTRY } from "../cli/docLedger.js";

// The compiler stamps walk imports from these entries. If one is renamed,
// computeCompilerStamp falls back to hashing every module: builds stay
// correct, but an edit anywhere rebuilds every .agency file again. This
// test turns the rename into a failure. Update the constant with the file.
describe("compiler stamp entries", () => {
  const libDir = path.resolve(__dirname, "..");
  test.each([COMPILE_PIPELINE_ENTRY, DOC_GENERATOR_ENTRY])("%s has a source file", (entry) => {
    const source = path.join(libDir, entry.replace(/\.js$/, ".ts"));
    expect(fs.existsSync(source)).toBe(true);
  });
});
