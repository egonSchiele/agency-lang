import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgency, replaceBlankLines } from "../parser.js";
import { generateAgency } from "./agencyGenerator.js";

// The formatter gate. Code literals commit `fmt` to reformatting template
// bodies, which rests on the canonical generator being clean on UNLOWERED
// template-mode nodes: holes as nodes, patterns unlowered, comprehensions
// intact. The template feature already leans on the print/re-parse cycle,
// but nothing sweeps the whole corpus through the unlowered parse->print
// cycle. This suite is that sweep. If it finds a generator gap, fixing it
// precedes the rest of the code-literal work.

function collectAgencyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectAgencyFiles(full));
    else if (entry.endsWith(".agency")) out.push(full);
  }
  return out;
}

// The format-path parse: no prelude template, no lowering — the exact mode
// `loadTemplate` and a code-literal body use.
function parseTemplateMode(source: string) {
  const parsed = parseAgency(replaceBlankLines(source), {}, false, false);
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.result;
}

// The comparison contract, stated so the gate pins CONTENT while
// allowing the formatter's documented reflow POLICIES:
//  - code nodes (everything except imports, comments, blank lines)
//    compare IN ORDER, deep-structurally, locs stripped;
//  - import statements compare as a SORTED MULTISET (the printer sorts
//    and regroups them; losing or duplicating one still fails);
//  - comments compare as a SORTED MULTISET of their text (import
//    hoisting relocates attached comments; losing one still fails);
//  - inside nodes: import-name order compares sorted (printer sorts),
//    and docstring text compares whitespace-collapsed (printer
//    re-indents docstrings). String LITERAL content is untouched —
//    a changed string is corruption, not policy.
// Vertical-whitespace STABILITY is the idempotence invariant's job.
type Partitioned = { code: unknown[]; imports: string[]; comments: string[] };

function normalized(nodes: unknown): Partitioned {
  const stripped = JSON.parse(
    JSON.stringify(nodes, (key, value) => (key === "loc" ? undefined : value)),
  ) as { type?: string }[];
  for (const node of stripped) normalizePolicyFields(node);
  const code: unknown[] = [];
  const imports: string[] = [];
  const comments: string[] = [];
  for (const node of stripped) {
    if (node.type === "newLine") continue;
    if (node.type === "importStatement" || node.type === "importNodeStatement") {
      imports.push(JSON.stringify(node));
      continue;
    }
    if (node.type === "comment" || node.type === "multiLineComment") {
      comments.push(JSON.stringify(node));
      continue;
    }
    code.push(node);
  }
  imports.sort();
  comments.sort();
  return { code, imports, comments };
}

function normalizePolicyFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizePolicyFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown> & { type?: string };
  if (node.type === "namedImport" && Array.isArray(node.importedNames)) {
    node.importedNames = [...(node.importedNames as unknown[])].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  if (typeof node.docString === "object" && node.docString !== null) {
    const doc = node.docString as { segments?: { type?: string; value?: string }[] };
    for (const seg of doc.segments ?? []) {
      if (seg.type === "text" && typeof seg.value === "string") {
        seg.value = seg.value.replace(/\s+/g, " ").trim();
      }
    }
  }
  for (const key of Object.keys(node)) normalizePolicyFields(node[key]);
}

describe("formatter gate: unlowered template-mode round-trip", () => {
  const root = join(__dirname, "../..");
  // Fixtures that are INTENTIONALLY unparseable (expectedCompileError
  // tests) cannot round-trip by definition. Each exclusion names its
  // reason; an unexplained entry here is how the corpus quietly shrinks.
  const INTENTIONALLY_UNPARSEABLE = [
    "literalBadBody.agency", // expectedCompileError: malformed literal body
  ];
  const files = [
    ...collectAgencyFiles(join(root, "stdlib")),
    ...collectAgencyFiles(join(root, "tests/typescriptGenerator")),
    ...collectAgencyFiles(join(root, "tests/agency/templates")),
  ].filter((file) => !INTENTIONALLY_UNPARSEABLE.some((name) => file.endsWith(name)));
  expect(files.length).toBeGreaterThan(50);

  it("print -> re-parse is structurally identity on the whole corpus", { timeout: 120_000 }, () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const first = parseTemplateMode(source);
      // generateAgency partitions program.nodes IN PLACE (header eating,
      // import extraction) — printing `first` would corrupt the very
      // baseline the comparison needs. Parse fresh for the print.
      const printed = generateAgency(parseTemplateMode(source));
      const second = parseTemplateMode(printed);
      expect(normalized(second.nodes), file).toEqual(normalized(first.nodes));
    }
  });

  it("printing is idempotent on the whole corpus", { timeout: 120_000 }, () => {
    for (const file of files) {
      const once = generateAgency(parseTemplateMode(readFileSync(file, "utf8")));
      const twice = generateAgency(parseTemplateMode(once));
      expect(twice, file).toBe(once);
    }
  });
});

// ── Pinned repros for the generator bugs the corpus gate flushed out.
// Each failed before its fix; the corpus invariants above keep the
// broad net, these keep the minimal shapes readable.
describe("formatter gate: pinned repros", () => {
  it("a parenthesized compound base keeps its parens (edgar corruption)", () => {
    // Dropping them re-associates the chain onto the right operand:
    // (a ?? "").toUpperCase() vs a ?? "".toUpperCase() — different program.
    const src = `def f(a: string | null): string {\n  return (a ?? "").toUpperCase()\n}\n`;
    const printed = generateAgency(parseTemplateMode(src));
    expect(printed).toContain(`(a ?? "").toUpperCase()`);
    expect(normalized(parseTemplateMode(printed).nodes)).toEqual(
      normalized(parseTemplateMode(src).nodes),
    );
  });

  it("a zero-parameter signature never wraps to (\\n\\n) (apple corruption)", () => {
    const src = `export idempotent def listAllOfTheThingsInTheApp(): Result<SomeVeryLongTypeName[]> raises <std::notes::list> {\n  return 1\n}\n`;
    const printed = generateAgency(parseTemplateMode(src));
    expect(printed).toContain("listAllOfTheThingsInTheApp()");
    expect(parseAgency(replaceBlankLines(printed), {}, false, false).success).toBe(true);
  });

  it("a node import renders exactly once (imports.agency duplication)", () => {
    const src = `import node { foo } from "./foo.agency"\n\nnode main() {\n  return 1\n}\n`;
    const printed = generateAgency(parseTemplateMode(src));
    const count = printed.split("import node { foo }").length - 1;
    expect(count).toBe(1);
  });

  it("import hoisting converges in one pass (blank-line accumulation)", () => {
    // An import below other code hoists to the top block; the blanks it
    // leaves behind must collapse, or each fmt pass shifts them.
    const src = `export { x } from "std::ui"\n\nimport { y } from "std::ui"\n\nnode main() {\n  return y\n}\n`;
    const once = generateAgency(parseTemplateMode(src));
    const twice = generateAgency(parseTemplateMode(once));
    expect(twice).toBe(once);
  });
});

// ── Code literals join the gate: in-memory sources covering each kind,
// the end-scan corners, and formatting behavior. The corpus above picks
// up file-based literals as fixtures land in tests/.
describe("formatter gate: code literals", () => {
  const literalSources = [
    `node main() {\n  const t = [| 1 + 2 |]\n  return t\n}\n`,
    `node main() {\n  const t = [|\n    const a = 1\n    print(a)\n  |]\n}\n`,
    `node main() {\n  const t = [|\n    def g(): number {\n      return 1\n    }\n  |]\n}\n`,
    `node main() {\n  const t = [|\n    const x: number = #n\n    #steps\n  |]\n}\n`,
    `node main() {\n  const t = [| return "Pick: [x|y|]" |]\n}\n`,
  ];

  it("round-trips and prints idempotently", () => {
    for (const source of literalSources) {
      const first = parseTemplateMode(source);
      const printed = generateAgency(parseTemplateMode(source));
      const second = parseTemplateMode(printed);
      expect(normalized(second.nodes), source).toEqual(normalized(first.nodes));
      const twice = generateAgency(parseTemplateMode(printed));
      expect(twice, source).toBe(printed);
    }
  });

  it("golden: a mis-indented body comes out canonically formatted", () => {
    // Byte-for-byte, written by hand from the formatting rules: body one
    // indent level deeper than the statement, |] aligned with it. The
    // structural gate cannot catch a text-level regression; this can.
    const messy = `node main() {\n  const t = [|\n      def g(): number {\n            return 1\n      }\n  |]\n}\n`;
    const expected = [
      "node main() {",
      "  const t = [|",
      "    def g(): number {",
      "      return 1",
      "    }",
      "  |]",
      "}",
      "",
    ].join("\n");
    expect(generateAgency(parseTemplateMode(messy))).toBe(expected);
  });

  it("golden: a one-line expr literal prints inline", () => {
    const source = `node main() {\n  const t = [|   1   +   2   |]\n  return t\n}\n`;
    const expected = [
      "node main() {",
      "  const t = [| 1 + 2 |]",
      "  return t",
      "}",
      "",
    ].join("\n");
    expect(generateAgency(parseTemplateMode(source))).toBe(expected);
  });

  it("a body comment survives printing", () => {
    const source = `node main() {\n  const t = [|\n    // keep me\n    print(1)\n  |]\n}\n`;
    const printed = generateAgency(parseTemplateMode(source));
    expect(printed).toContain("// keep me");
  });
});

// The "indistinguishable from file-loaded" property, pinned as a tested
// equality rather than a claim. One printer, not two: _toSource IS
// generateAgency (lib/stdlib/template.ts), so equality here proves a
// literal-built value and a file-parsed template print identically.
describe("formatter gate: literal/file equivalence", () => {
  it("toSource of a literal-built body equals the file-template print", () => {
    const bodyText = `def g(n: number): number {\n  return n * 2\n}\n`;
    const viaLiteral = parseTemplateMode(
      `node main() {\n  const t = [|\n    def g(n: number): number {\n      return n * 2\n    }\n  |]\n}\n`,
    );
    const literal = ((): { nodes: unknown[] } => {
      const main = (viaLiteral.nodes as { type: string; body?: { type: string }[] }[]).find(
        (node) => node.type === "graphNode",
      );
      const assignment = (main?.body ?? []).find((node) => node.type === "assignment") as {
        value?: { type: string; nodes: unknown[] };
      };
      if (assignment.value?.type !== "codeLiteral") throw new Error("no literal");
      return assignment.value;
    })();
    const literalPrinted = generateAgency({
      type: "agencyProgram",
      nodes: literal.nodes,
    } as never);
    const filePrinted = generateAgency(parseTemplateMode(bodyText));
    expect(literalPrinted).toBe(filePrinted);
  });
});
