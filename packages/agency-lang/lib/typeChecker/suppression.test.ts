import { describe, it, expect } from "vitest";
import { applySuppressions, parseSuppressions } from "./suppression.js";
import { diagnostic } from "./diagnostics.js";
import { dedupeErrors } from "./index.js";
import type { TypeCheckError } from "./types.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

describe("parseSuppressions", () => {
  it("returns empty defaults for source with no directives", () => {
    const r = parseSuppressions(`def foo() {}\n`);
    expect(r.nocheck).toBe(false);
    expect(Object.keys(r.ignoreLines)).toHaveLength(0);
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
    expect(r.ignoreLines[2]).toBe("all");
    expect(r.ignoreLines[1]).toBeUndefined();
  });

  it("supports multiple @tc-ignore directives", () => {
    // lines: 0=ignore, 1=x, 2=y, 3=ignore, 4=z → suppress 1 and 4
    const src = `// @tc-ignore\nlet x = 1\nlet y = 2\n// @tc-ignore\nlet z = 3\n`;
    const r = parseSuppressions(src);
    expect(r.ignoreLines[1]).toBe("all");
    expect(r.ignoreLines[4]).toBe("all");
  });

  it("does not honor @tc-ignore on a trailing comment", () => {
    // TS rule: only standalone comment lines suppress.
    const src = `let x = 1 // @tc-ignore\nlet y = 2\n`;
    const r = parseSuppressions(src);
    expect(r.ignoreLines[1]).toBeUndefined();
  });
});

describe("applySuppressions", () => {
  const err = (line: number, message = "boom"): TypeCheckError => ({
    ...diagnostic("reassignToConst", { name: "x" }, { line, col: 0, start: 0, end: 0 }),
    message,
  });

  it("returns the input unchanged when no suppressions apply", () => {
    const errs = [err(1), err(5)];
    const r = applySuppressions(errs, { nocheck: false, ignoreLines: {} });
    expect(r).toEqual(errs);
  });

  it("drops every error when nocheck is set", () => {
    const errs = [err(1), err(5)];
    const r = applySuppressions(errs, { nocheck: true, ignoreLines: { 3: "all" as const } });
    expect(r).toEqual([]);
  });

  it("drops errors on ignored lines only", () => {
    const errs = [err(2), err(3), err(4)];
    const r = applySuppressions(errs, { nocheck: false, ignoreLines: { 3: "all" as const } });
    expect(r.map((e) => e.loc!.line)).toEqual([2, 4]);
  });

  it("never drops errors with no loc", () => {
    const fileLevel: TypeCheckError = {
      ...diagnostic("reassignToConst", { name: "x" }, null),
      message: "global",
    };
    const errs: TypeCheckError[] = [fileLevel, err(3)];
    const r = applySuppressions(errs, { nocheck: false, ignoreLines: { 3: "all" as const } });
    expect(r).toEqual([fileLevel]);
  });
});

describe("@tc-ignore code-scoped directives", () => {
  const locOnLine1 = { line: 1, col: 0, start: 30, end: 40 };
  const errWith = (code: string): TypeCheckError => ({
    ...diagnostic("reassignToConst", { name: "x" }, locOnLine1),
    code,
  });

  it("with codes suppresses only those codes on the next line", () => {
    const sup = parseSuppressions("// @tc-ignore AG2001, AG4005\nconst x = 1\n");
    expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
    expect(applySuppressions([errWith("AG4005")], sup)).toEqual([]);
    expect(applySuppressions([errWith("AG9999")], sup)).toHaveLength(1);
  });

  it("bare directive still suppresses everything on the next line", () => {
    const sup = parseSuppressions("// @tc-ignore\nconst x = 1\n");
    expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
  });

  it("trailing prose keeps the suppress-all meaning (back-compat)", () => {
    const sup = parseSuppressions("// @tc-ignore known false positive\nconst x = 1\n");
    expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
  });

  it("a malformed code attempt suppresses NOTHING (fail closed)", () => {
    for (const bad of ["AG201", "ag2001", "Ag12345"]) {
      const sup = parseSuppressions(`// @tc-ignore ${bad}\nconst x = 1\n`);
      expect(applySuppressions([errWith("AG2001")], sup)).toHaveLength(1);
    }
  });

  it("mixed valid codes and prose suppresses the valid codes only", () => {
    const sup = parseSuppressions("// @tc-ignore AG2001 because reasons\nconst x = 1\n");
    expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
    expect(applySuppressions([errWith("AG4005")], sup)).toHaveLength(1);
  });

  it("a file-level (loc null) diagnostic is immune to @tc-ignore", () => {
    const sup = parseSuppressions("// @tc-ignore\nconst x = 1\n");
    const fileLevel = diagnostic("reassignToConst", { name: "x" }, null);
    expect(applySuppressions([fileLevel], sup)).toHaveLength(1);
  });
});

describe("dedupeErrors", () => {
  const at = (code: string, message: string): TypeCheckError => ({
    ...diagnostic("reassignToConst", { name: "x" }, { line: 1, col: 0, start: 30, end: 40 }),
    code,
    message,
  });

  it("two different codes at the same position both survive", () => {
    const first = at("AG2001", "same message");
    const second = at("AG4005", "same message");
    expect(dedupeErrors([first, second])).toHaveLength(2);
  });

  it("same code with different messages at one position both survive", () => {
    // Regression guard for the key-lossiness bug the plan review caught:
    // one code can render different params at the same position.
    const first = at("AG2001", "Type 'string' is not assignable to type 'number'.");
    const second = at("AG2001", "Type 'string' is not assignable to type 'boolean'.");
    expect(dedupeErrors([first, second])).toHaveLength(2);
  });

  it("identical code, message, and position collapse to one", () => {
    const first = at("AG2001", "same");
    const second = at("AG2001", "same");
    expect(dedupeErrors([first, second])).toHaveLength(1);
  });
});

describe("typeCheck honors suppressions end-to-end", () => {
  function check(source: string, applyTemplate: boolean = true) {
    const parseResult = parseAgency(source, {}, applyTemplate);
    if (!parseResult.success) throw new Error(`Parse failed: ${parseResult.message}`);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, undefined, undefined, source);
    // Silence the undefined-function diagnostic — these tests don't supply a
    // SymbolTable, so stdlib calls (print, …) would warn as unresolved.
    return typeCheck(program, { typechecker: { undefinedFunctions: "silent" } }, info);
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
