import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

// A `tools:` argument must be an ARRAY of tools. A lone tool value is not
// assignable, and the type checker should say so at compile time instead of
// letting it reach runPrompt, which does `rawTools.map(...)` and crashes with
// the opaque "rawTools.map is not a function". These tests lock in that a tool
// value — whether a bare function, a `.partial()`/`.describe()` chain, or an
// imported function — is caught when passed to `tools:` without brackets, and
// is accepted once wrapped in an array.

function check(source: string): TypeCheckError[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors;
}

// Cross-module variant so imported functions resolve to real signatures.
function checkImporter(
  files: Record<string, string>,
  entry: string,
): TypeCheckError[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-toolarg-"));
  try {
    for (const [name, src] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), src);
    }
    const entryPath = path.join(dir, entry);
    const src = files[entry];
    const parsed = parseAgency(src);
    if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
    const symbols = SymbolTable.build(entryPath);
    const info = buildCompilationUnit(parsed.result, symbols, entryPath, src);
    return typeCheck(parsed.result, {}, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// AG6014 is the named-argument type mismatch; `params.name` is the argument
// that failed to type-check. Keying off the code + param is stabler than
// matching the rendered message text.
const toolsArrayError = (e: TypeCheckError) =>
  e.code === "AG6014" && e.params.name === "tools";

describe("tools: argument must be an array — locally-defined tools", () => {
  it("rejects a lone .partial() result", () => {
    const errs = check(`
def weather(city: string, unit: string): string { return city }
node main() {
  const r = llm("hi", tools: weather.partial(unit: "C"))
}
`);
    expect(errs.some(toolsArrayError)).toBe(true);
  });

  it("accepts the same .partial() result inside an array", () => {
    const errs = check(`
def weather(city: string, unit: string): string { return city }
node main() {
  const r = llm("hi", tools: [weather.partial(unit: "C")])
}
`);
    expect(errs.some(toolsArrayError)).toBe(false);
  });

  it("rejects a lone .describe() result", () => {
    const errs = check(`
def weather(city: string): string { return city }
node main() {
  const r = llm("hi", tools: weather.describe("looks up weather"))
}
`);
    expect(errs.some(toolsArrayError)).toBe(true);
  });

  it("accepts a chained .partial().describe().rename() inside an array", () => {
    const errs = check(`
def weather(city: string, unit: string): string { return city }
node main() {
  const r = llm("hi", tools: [weather.partial(unit: "C").describe("d").rename("w")])
}
`);
    expect(errs.some(toolsArrayError)).toBe(false);
  });
});

describe("tools: argument must be an array — imported tools", () => {
  const libSrc = "export def weather(city: string, unit: string): string { return city }\n";

  it("rejects a lone imported tool", () => {
    const errs = checkImporter(
      {
        "lib.agency": libSrc,
        "main.agency":
          'import { weather } from "./lib.agency"\n' +
          'node main() {\n  const r = llm("hi", tools: weather)\n}\n',
      },
      "main.agency",
    );
    expect(errs.some(toolsArrayError)).toBe(true);
  });

  it("rejects a lone imported .partial() result (the reported crash)", () => {
    const errs = checkImporter(
      {
        "lib.agency": libSrc,
        "main.agency":
          'import { weather } from "./lib.agency"\n' +
          'node main() {\n  const r = llm("hi", tools: weather.partial(unit: "C"))\n}\n',
      },
      "main.agency",
    );
    expect(errs.some(toolsArrayError)).toBe(true);
  });

  it("accepts an imported tool inside an array", () => {
    const errs = checkImporter(
      {
        "lib.agency": libSrc,
        "main.agency":
          'import { weather } from "./lib.agency"\n' +
          'node main() {\n  const r = llm("hi", tools: [weather.partial(unit: "C")])\n}\n',
      },
      "main.agency",
    );
    expect(errs.some(toolsArrayError)).toBe(false);
  });
});

describe(".partial() drops bound params so higher-order use still type-checks", () => {
  // Regression guard: reducing the signature must not break `filter`,
  // `map`, etc. that expect a `(any) -> any` callback. `_match(name, needle)`
  // partially applied on `needle` is a `(name) -> boolean`, which satisfies
  // the one-argument callback — a full two-argument signature would not.
  it("a .partial() tool with one remaining param satisfies a filter callback", () => {
    const errs = check(`
def _match(name: string, needle: string): boolean { return name.includes(needle) }
def pick(names: string[], needle: string): string[] {
  return filter(names, _match.partial(needle: needle))
}
`);
    // AG6019 is the call-argument assignability error the full 2-arg
    // signature would trigger against filter's (any) -> any callback.
    expect(errs.filter((e) => e.code === "AG6019")).toEqual([]);
  });
});
