import { describe, it, expect } from "vitest";
import { applySuppressions, parseSuppressions } from "./suppression.js";
import type { TypeCheckError } from "./types.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

describe("parseSuppressions", () => {
  it("returns empty defaults for source with no directives", () => {
    const r = parseSuppressions(`def foo() {}\n`);
    expect(r.nocheck).toBe(false);
    expect(r.ignoreLines.size).toBe(0);
  });

  it("recognizes @tc-nocheck at the top of the file", () => {
    const r = parseSuppressions(`// @tc-nocheck\ndef foo() {}\n`);
    expect(r.nocheck).toBe(true);
  });

  it("recognizes @tc-nocheck after blank lines and other comments", () => {
    const src = `// some banner\n\n// @tc-nocheck\ndef foo() {}\n`;
    expect(parseSuppressions(src).nocheck).toBe(true);
  });

  it("ignores @tc-nocheck once code has appeared", () => {
    const src = `def foo() {}\n// @tc-nocheck\n`;
    expect(parseSuppressions(src).nocheck).toBe(false);
  });

  it("ignores @tc-nocheck on a trailing comment of a code line", () => {
    // Trailing comments ("code // @tc-nocheck") aren't a leading directive
    // — the line containing code is what ends the directive region.
    const src = `def foo() {} // @tc-nocheck\n`;
    expect(parseSuppressions(src).nocheck).toBe(false);
  });

  it("collects @tc-ignore lines, suppressing the line that follows", () => {
    // line 0: let x = 1
    // line 1: // @tc-ignore
    // line 2: let y = 2  ← suppressed
    const src = `let x = 1\n// @tc-ignore\nlet y = 2\n`;
    const r = parseSuppressions(src);
    expect(r.ignoreLines.has(2)).toBe(true);
    expect(r.ignoreLines.has(1)).toBe(false);
  });

  it("supports multiple @tc-ignore directives", () => {
    // lines: 0=ignore, 1=x, 2=y, 3=ignore, 4=z → suppress 1 and 4
    const src = `// @tc-ignore\nlet x = 1\nlet y = 2\n// @tc-ignore\nlet z = 3\n`;
    const r = parseSuppressions(src);
    expect(r.ignoreLines.has(1)).toBe(true);
    expect(r.ignoreLines.has(4)).toBe(true);
  });

  it("does not honor @tc-ignore on a trailing comment", () => {
    // TS rule: only standalone comment lines suppress.
    const src = `let x = 1 // @tc-ignore\nlet y = 2\n`;
    const r = parseSuppressions(src);
    expect(r.ignoreLines.has(1)).toBe(false);
  });
});

describe("applySuppressions", () => {
  const err = (line: number, message = "boom"): TypeCheckError => ({
    message,
    loc: { line, col: 0, start: 0, end: 0 },
  });

  it("returns the input unchanged when no suppressions apply", () => {
    const errs = [err(1), err(5)];
    const r = applySuppressions(errs, { nocheck: false, ignoreLines: new Set() });
    expect(r).toEqual(errs);
  });

  it("drops every error when nocheck is set", () => {
    const errs = [err(1), err(5)];
    const r = applySuppressions(errs, { nocheck: true, ignoreLines: new Set([3]) });
    expect(r).toEqual([]);
  });

  it("drops errors on ignored lines only", () => {
    const errs = [err(2), err(3), err(4)];
    const r = applySuppressions(errs, { nocheck: false, ignoreLines: new Set([3]) });
    expect(r.map((e) => e.loc!.line)).toEqual([2, 4]);
  });

  it("never drops errors with no loc", () => {
    const errs: TypeCheckError[] = [{ message: "global" }, err(3)];
    const r = applySuppressions(errs, { nocheck: false, ignoreLines: new Set([3]) });
    expect(r).toEqual([{ message: "global" }]);
  });
});

describe("typeCheck honors suppressions end-to-end", () => {
  function check(source: string, applyTemplate: boolean = true) {
    const parseResult = parseAgency(source, {}, applyTemplate);
    if (!parseResult.success) throw new Error(`Parse failed: ${parseResult.message}`);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, undefined, undefined, source);
    return typeCheck(program, {}, info);
  }

  it("@tc-ignore suppresses the next-line error", () => {
    const src = `def take(x: number): void { print(x) }\n\nnode main() {\n  // @tc-ignore\n  take("not a number")\n}\n`;
    expect(check(src).errors).toEqual([]);
  });

  it("without @tc-ignore the same error fires", () => {
    const src = `def take(x: number): void { print(x) }\n\nnode main() {\n  take("not a number")\n}\n`;
    expect(check(src).errors.length).toBeGreaterThan(0);
  });

  it("@tc-nocheck at top of file silences every error", () => {
    const src = `// @tc-nocheck\ndef take(x: number): void { print(x) }\n\nnode main() {\n  take("a")\n  take(true)\n}\n`;
    expect(check(src).errors).toEqual([]);
  });

  it("@tc-nocheck mid-file is not honored", () => {
    const src = `def take(x: number): void { print(x) }\n\n// @tc-nocheck\nnode main() {\n  take("a")\n}\n`;
    expect(check(src).errors.length).toBeGreaterThan(0);
  });

  it("@tc-ignore works when source is parsed without the template (LSP path)", () => {
    // LSP calls parseAgency(source, config, false). The parser shifts
    // loc.line by -AGENCY_TEMPLATE_OFFSET in this mode, so suppression
    // line numbers must be aligned with that shift to actually filter.
    const src = `def take(x: number): void { print(x) }\n\nnode main() {\n  // @tc-ignore\n  take("not a number")\n}\n`;
    expect(check(src, false).errors).toEqual([]);
  });

  it("@tc-nocheck works in LSP-mode parsing", () => {
    const src = `// @tc-nocheck\ndef take(x: number): void { print(x) }\n\nnode main() {\n  take("a")\n}\n`;
    expect(check(src, false).errors).toEqual([]);
  });
});
