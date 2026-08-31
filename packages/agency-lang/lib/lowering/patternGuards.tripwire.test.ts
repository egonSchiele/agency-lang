/**
 * Tripwire for the rule `collectChecks` must uphold.
 *
 * A pattern's job is to answer "does this value match". So the boolean
 * condition it lowers to has to be a TOTAL function of the value: safe to
 * evaluate on anything, and true only for values the pattern matches. Most
 * cases get that for free — `resultPattern` asks via `isSuccess(v)`,
 * `typePattern` via `__coarseTypeTest(v, kind)`, a literal via `v == lit`, and
 * all three are total on any input. Raw member access is the one non-total
 * operation available, and it is exactly what `objectPattern` and
 * `arrayPattern` use.
 *
 * The rule that makes them total: a case must assert the shape it is about to
 * destructure BEFORE destructuring it, and `patternToCondition` joins checks
 * with `&&` in order, so an earlier conjunct short-circuits a later read.
 *
 * Stated as an invariant this file can check:
 *
 *   In a lowered pattern condition, every member access is preceded in the
 *   `&&` chain by a shape check on each of its prefixes.
 *
 * A new pattern kind that reads a field without guarding it fails here rather
 * than waiting for someone to hit the crash. Patterns come from the corpus —
 * real ones the compiler already handles — so nothing is hand-enumerated
 * except the kind list, whose exhaustiveness the type system checks below.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { lowerPatterns } from "./patternLowering.js";
import { desugarComprehensionsInBody } from "./comprehensionDesugar.js";
import { parseAgency } from "../parser.js";
import type { AgencyNode, Expression, IfElse, MatchBlock } from "../types.js";
import type { MatchPattern } from "../types/pattern.js";
import type { BinOpExpression } from "../types/binop.js";
import type { ValueAccess } from "../types/access.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");

// ---------------------------------------------------------------------------
// The kind list, tied to the union so it cannot drift
// ---------------------------------------------------------------------------

/** Every `type` a `MatchPattern` node can carry. */
const PATTERN_KINDS = [
  "objectPattern",
  "arrayPattern",
  "restPattern",
  "wildcardPattern",
  "variableName",
  "resultPattern",
  "effectPattern",
  "typePattern",
  "number",
  "unitLiteral",
  "multiLineString",
  "string",
  "boolean",
  "null",
] as const;

// Adding a member to `MatchPattern` without listing it here is a COMPILE
// error, so the coverage test below can never silently stop covering a kind.
type MissingKind = Exclude<MatchPattern["type"], (typeof PATTERN_KINDS)[number]>;
const _kindListIsExhaustive: MissingKind extends never ? true : never = true;
void _kindListIsExhaustive;

/**
 * Kinds the corpus does not exercise, so the invariant below never sees them.
 * Keyed by kind, valued with why. The staleness guard asserts each entry is
 * STILL absent, so a corpus that grows to cover one fails until its entry is
 * deleted — the list cannot rot into a permanent excuse.
 */
const KNOWN_UNCOVERED_KINDS: Record<string, string> = {
  unitLiteral: "no stdlib/fixture match arm matches on a unit literal (30s, $5)",
  multiLineString: 'no match arm matches on a """..."""  literal',
};

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function collectAgencyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectAgencyFiles(full));
    else if (entry.endsWith(".agency")) out.push(full);
  }
  return out;
}

function* walkEveryNode(value: unknown): Generator<Record<string, unknown>> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkEveryNode(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string") yield record;
  for (const key of Object.keys(record)) {
    if (key === "loc") continue;
    yield* walkEveryNode(record[key]);
  }
}

/**
 * One UNLOWERED parse of the whole corpus, shared by every test in this file.
 * Parsing is ~98% of this file's cost (lowering the entire corpus in memory is
 * ~2% of a single parse), so we parse once here and derive both the pattern
 * list and the post-lowering leak check from these same trees. Trees are kept
 * unlowered; the leak check clones before running the lowering passes so this
 * cache is never mutated.
 */
let parsedCorpusCache: { file: string; nodes: AgencyNode[] }[] | null = null;

function parsedCorpus(): { file: string; nodes: AgencyNode[] }[] {
  if (parsedCorpusCache) return parsedCorpusCache;
  const root = join(__dirname, "../..");
  const files = [
    ...collectAgencyFiles(join(root, "stdlib")),
    ...collectAgencyFiles(join(root, "tests/typescriptGenerator")),
    ...collectAgencyFiles(join(root, "tests/agency")),
  ];
  expect(files.length).toBeGreaterThan(50);

  const out: { file: string; nodes: AgencyNode[] }[] = [];
  for (const file of files) {
    // Some corpus files are deliberate compile-error fixtures
    // (tests/agency/expectedCompileError). They fail two ways: a returned
    // failure, and a THROW — the array-pattern arity check throws so its
    // message survives the surrounding `or` combinators. Skip both.
    let parsed;
    try {
      parsed = parseAgency(readFileSync(file, "utf8"), {}, true, false);
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    out.push({ file, nodes: parsed.result.nodes });
  }
  parsedCorpusCache = out;
  return out;
}

/**
 * Every pattern the corpus actually writes, taken from the two positions that
 * feed `patternToCondition`: a match arm's `caseValue` and the pattern after
 * `is`. Read off the UNLOWERED trees — lowering is what we are about to run
 * ourselves.
 */
let corpusCache: { file: string; pattern: MatchPattern }[] | null = null;

function corpusPatterns(): { file: string; pattern: MatchPattern }[] {
  if (corpusCache) return corpusCache;
  const out: { file: string; pattern: MatchPattern }[] = [];
  for (const { file, nodes } of parsedCorpus()) {
    for (const node of walkEveryNode(nodes)) {
      if (node.type === "matchBlock") {
        for (const c of (node as unknown as MatchBlock).cases) {
          if (c.type === "matchBlockCase" && c.caseValue !== "_") {
            out.push({ file, pattern: c.caseValue as MatchPattern });
          }
        }
      }
      if (node.type === "isExpression") {
        out.push({ file, pattern: node.pattern as MatchPattern });
      }
    }
  }
  corpusCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

/** Flatten a left-associated `&&` chain into its conjuncts, in evaluation order. */
function conjuncts(expr: Expression): Expression[] {
  if (expr.type === "binOpExpression" && (expr as BinOpExpression).operator === "&&") {
    const bin = expr as BinOpExpression;
    return [...conjuncts(bin.left), ...conjuncts(bin.right)];
  }
  return [expr];
}

/**
 * A dotted/indexed path for the access expressions patterns build, or null for
 * anything else. `__scrutinee_1.redirect` and `__scrutinee_1[0]` are paths; a
 * function call is not.
 */
function pathOf(expr: Expression): string | null {
  if (expr.type === "variableName") return (expr as { value: string }).value;
  if (expr.type !== "valueAccess") return null;
  const access = expr as ValueAccess;
  const base = pathOf(access.base as Expression);
  if (base === null) return null;
  let path = base;
  for (const link of access.chain) {
    if (link.kind === "property") path += `.${link.name}`;
    else if (link.kind === "index") path += `[${JSON.stringify(link.index)}]`;
    else return null;
  }
  return path;
}

/** Every path a conjunct READS THROUGH — the proper prefixes of its accesses. */
function readThrough(expr: Expression): string[] {
  const out: string[] = [];
  for (const node of walkEveryNode(expr)) {
    if (node.type !== "valueAccess") continue;
    const access = node as unknown as ValueAccess;
    const base = pathOf(access.base as Expression);
    if (base === null) continue;
    // Reading `a.b.c` reads through `a` and `a.b`, but not `a.b.c` itself.
    let path = base;
    out.push(path);
    for (const link of access.chain.slice(0, -1)) {
      if (link.kind === "property") path += `.${link.name}`;
      else if (link.kind === "index") path += `[${JSON.stringify(link.index)}]`;
      else break;
      out.push(path);
    }
  }
  return out;
}

/** The path a conjunct PROVES safe to read through, if it is a shape check. */
function proves(expr: Expression): string | null {
  if (expr.type === "typeTestExpression") {
    return pathOf((expr as { expression: Expression }).expression);
  }
  if (expr.type === "binOpExpression") {
    const bin = expr as BinOpExpression;
    const nullSide =
      bin.right.type === "null" ? bin.left : bin.left.type === "null" ? bin.right : null;
    if ((bin.operator === "!=" || bin.operator === "!==") && nullSide) {
      return pathOf(nullSide);
    }
  }
  return null;
}

/** Paths read before anything proved them safe. Empty means the rule holds. */
function unguardedReads(condition: Expression): string[] {
  const proven = new Set<string>();
  const violations: string[] = [];
  for (const conjunct of conjuncts(condition)) {
    for (const path of readThrough(conjunct)) {
      if (!proven.has(path)) violations.push(path);
    }
    const provedPath = proves(conjunct);
    if (provedPath !== null) proven.add(provedPath);
  }
  return violations;
}

/** Lower `pattern` as the only arm of a match and return every arm condition. */
function conditionsFor(pattern: MatchPattern): Expression[] {
  const matchBlock = {
    type: "matchBlock",
    expression: { type: "variableName", value: "__src" },
    cases: [
      { type: "matchBlockCase", caseValue: pattern, body: [] },
      { type: "matchBlockCase", caseValue: "_", body: [] },
    ],
  } as unknown as AgencyNode;
  const lowered = lowerPatterns([matchBlock]);
  const out: Expression[] = [];
  for (const node of walkEveryNode(lowered)) {
    if (node.type === "ifElse") out.push((node as unknown as IfElse).condition);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pattern conditions never read through an unguarded value", () => {
  it("every corpus pattern guards each value it destructures", { timeout: 60_000 }, () => {
    const failures: string[] = [];
    for (const { file, pattern } of corpusPatterns()) {
      for (const condition of conditionsFor(pattern)) {
        for (const path of unguardedReads(condition)) {
          failures.push(`${file}: ${pattern.type} reads through ${path} unguarded`);
        }
      }
    }
    expect(
      failures.slice(0, 10),
      `A pattern case reads a field off a value nothing established the shape of. ` +
        `That value can be null (the condition throws instead of failing the arm) or the ` +
        `wrong type (the condition is vacuously true and the arm matches something it ` +
        `should not). Push a shapeCheck at the head of the case in collectChecks.`,
    ).toEqual([]);
  });

  it("the corpus exercises every pattern kind", { timeout: 60_000 }, () => {
    const seen = new Set<string>();
    for (const { pattern } of corpusPatterns()) {
      for (const node of walkEveryNode(pattern)) seen.add(node.type as string);
    }
    const uncovered = PATTERN_KINDS.filter(
      (kind) => !seen.has(kind) && !Object.hasOwn(KNOWN_UNCOVERED_KINDS, kind),
    );
    expect(
      uncovered,
      `These pattern kinds appear nowhere in the corpus, so the invariant above ` +
        `never sees them. Add a corpus program that uses one, or record it in ` +
        `KNOWN_UNCOVERED_KINDS with the reason.`,
    ).toEqual([]);
  });

  it("known-uncovered kinds are still uncovered (staleness guard)", { timeout: 60_000 }, () => {
    const seen = new Set<string>();
    for (const { pattern } of corpusPatterns()) {
      for (const node of walkEveryNode(pattern)) seen.add(node.type as string);
    }
    const nowCovered = Object.keys(KNOWN_UNCOVERED_KINDS).filter((kind) => seen.has(kind));
    expect(
      nowCovered,
      `The corpus now exercises these kinds, so their KNOWN_UNCOVERED_KINDS entries ` +
        `are stale. Delete the entries — the invariant covers them for real now.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The module's own stated invariant, checked
// ---------------------------------------------------------------------------

/**
 * Node kinds pattern lowering is supposed to eliminate. `patternLowering.ts`
 * opens by claiming "After this pass, the AST contains NO pattern-specific
 * nodes"; nothing checked it, and an `isExpression` surviving in a match-arm
 * guard is what reached codegen as "Unhandled Agency node type: isExpression".
 */
const MUST_NOT_SURVIVE = [
  "objectPattern",
  "arrayPattern",
  "restPattern",
  "wildcardPattern",
  "objectPatternProperty",
  "objectPatternShorthand",
  "resultPattern",
  "effectPattern",
  "typePattern",
  "isExpression",
];

/**
 * Walk a lowered tree, skipping `matchSource`: the scrutinee assignment keeps a
 * deliberate cloned snapshot of the un-lowered arms there for the
 * exhaustiveness pass, so pattern nodes inside it are expected, not leaks.
 */
function* walkSkippingMatchSource(value: unknown): Generator<Record<string, unknown>> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkSkippingMatchSource(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string") yield record;
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "matchSource") continue;
    yield* walkSkippingMatchSource(record[key]);
  }
}

describe("lowering leaves no pattern-specific nodes behind", () => {
  it("no corpus program keeps a pattern node after lowering", { timeout: 60_000 }, () => {
    const failures: string[] = [];
    for (const { file, nodes } of parsedCorpus()) {
      // parsedCorpus() is cached UNLOWERED and shared with the tests above, so
      // clone before lowering in place. This runs the same two passes
      // `parseAgency(..., lower: true)` runs (comprehension desugar then
      // pattern lowering, in that order) without a second full corpus parse.
      // A few deliberate compile-error fixtures parse but THROW during
      // lowering. The previous version of this test skipped them because it
      // wrapped `parseAgency(..., lower: true)` in a try/catch; the try/catch
      // here preserves that (see corpusPatterns/parsedCorpus).
      let lowered: AgencyNode[];
      try {
        lowered = desugarComprehensionsInBody(structuredClone(nodes)) as AgencyNode[];
        lowered = lowerPatterns(lowered);
      } catch {
        continue;
      }
      for (const node of walkSkippingMatchSource(lowered)) {
        if (MUST_NOT_SURVIVE.includes(node.type as string)) {
          failures.push(`${file}: ${node.type as string} survived lowering`);
        }
      }
    }
    expect(
      failures.slice(0, 10),
      `Pattern lowering is supposed to remove these (see the header of ` +
        `patternLowering.ts). Anything left reaches the TypeScript builder, which ` +
        `has no case for it and throws "Unhandled Agency node type".`,
    ).toEqual([]);
  });
});
