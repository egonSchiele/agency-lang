import { describe, it, expect } from "vitest";
import { formatErrors, typeCheck } from "./index.js";
import { diagnostic } from "./diagnostics.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";

// Strip real ANSI escapes (ESC byte + bracket sequence). color.red/yellow
// color UNCONDITIONALLY (termcolors createColorFunction), so test output
// always contains them.
const plain = (formatted: string) => formatted.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatErrors", () => {
  it("prints file:line:col - severity CODE: message (1-indexed display)", () => {
    // loc.line and loc.col are 0-indexed (docs/dev/locations.md); display
    // adds 1 to both.
    const err = {
      ...diagnostic(
        "reassignToConst",
        { name: "c" },
        { line: 12, col: 8, start: 100, end: 110 },
      ),
      file: "main.agency",
    };
    expect(plain(formatErrors([err]))).toBe(
      "main.agency:13:9 - error AG4005: Cannot reassign to constant 'c'.",
    );
  });

  it("a warning renders the word warning and its code", () => {
    const err = {
      ...diagnostic("reassignToConst", { name: "c" }, null, {
        severity: "warning",
      }),
      file: "main.agency",
    };
    expect(plain(formatErrors([err]))).toBe(
      "main.agency - warning AG4005: Cannot reassign to constant 'c'.",
    );
  });

  it("file-level (loc null) prints without position", () => {
    const err = {
      ...diagnostic("reassignToConst", { name: "c" }, null),
      file: "main.agency",
    };
    expect(plain(formatErrors([err]))).toBe(
      "main.agency - error AG4005: Cannot reassign to constant 'c'.",
    );
  });

  it("no file falls back to severity CODE: message", () => {
    const err = diagnostic("reassignToConst", { name: "c" }, null);
    expect(plain(formatErrors([err]))).toBe(
      "error AG4005: Cannot reassign to constant 'c'.",
    );
  });
});

describe("end-to-end file stamping + formatting", () => {
  // THE file-stamping test: TypeChecker.check() stamps ctx.currentFile onto
  // every diagnostic. An explicit fromFile keeps the output deterministic.
  it("a compiled file formats with its path, line, col, and code", () => {
    const source = [
      "node main() {",
      '  const x: number = "not a number"',
      "  return x",
      "}",
      "",
    ].join("\n");
    const parsed = parseAgency(source);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("unreachable");
    }
    const unit = buildCompilationUnit(
      parsed.result,
      undefined,
      "/tmp/stamp-test.agency",
      source,
    );
    const { errors } = typeCheck(parsed.result, {}, unit);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const formatted = plain(formatErrors(errors));
    const lines = formatted.split("\n");
    expect(lines[0]).toMatch(
      /^\/tmp\/stamp-test\.agency:\d+:\d+ - error AG\d{4}: /,
    );
  });
});
