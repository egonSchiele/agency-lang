import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgency } from "../parser.js";
import { EXPRESSION_NODE_TYPES } from "../types.js";
import type { AgencyNode } from "../types.js";
import {
  expressionSlots,
  isRegisteredExpressionKind,
  HANDLED_KINDS,
  NO_EXPRESSION_SLOTS,
} from "./expressionSlots.js";
import { expressionChildren, walkNodesArray } from "./node.js";
import { bodySlots } from "./bodySlots.js";
import {
  EXTRACTED_STATEMENT_KINDS,
  STATEMENT_CASE_KINDS,
  NON_EXTRACTED_STATEMENT_KINDS,
  SKIP_TYPES,
} from "../preprocessors/hoistCalls.js";

function bodyOf(src: string): any[] {
  const parsed = parseAgency(src, {}, true);
  if (!parsed.success) throw new Error(parsed.message);
  const fn = (parsed.result.nodes as any[]).find(
    (n) => n.type === "function" || n.type === "graphNode",
  );
  return fn.body.filter((n: any) => n.type !== "comment" && n.type !== "newLine");
}

describe("expressionSlots: per-family slots and writers", () => {
  it("assignment: target chain slots come before the value slot, in evaluation order", () => {
    const [assign] = bodyOf(`
def f(arr: number[], i: number): number {
  arr[pick(i)] = compute(i)
  return arr[0]
}`);
    const slots = expressionSlots(assign);
    expect(slots.map((s: any) => s.expr.functionName)).toEqual(["pick", "compute"]);
    expect(slots.map((s) => s.mode)).toEqual(["once", "once"]);
  });

  it("write returns a fresh owner and leaves the original untouched", () => {
    const [ret] = bodyOf(`
def f(): number {
  return compute(1)
}`);
    const before = JSON.stringify(ret);
    const [valueSlot] = expressionSlots(ret);
    const replacement = { type: "variableName", value: "__tmp" } as unknown as AgencyNode;
    const rebuilt: any = valueSlot.write(ret, replacement);
    expect(rebuilt).not.toBe(ret);
    expect(rebuilt.value.value).toBe("__tmp");
    expect(JSON.stringify(ret)).toBe(before);
  });

  it("while conditions are perIteration; if conditions are once", () => {
    const [wl, ife] = bodyOf(`
def f(n: number): number {
  while (check(n) < 5) { n = n + 1 }
  if (score(n) > 3) { return 1 }
  return 0
}`);
    expect(expressionSlots(wl).map((s) => s.mode)).toEqual(["perIteration"]);
    expect(expressionSlots(ife).map((s) => s.mode)).toEqual(["once"]);
  });

  it("operator table: short-circuit right is conditional, catch is opaque/conditional, pipe stages opaque", () => {
    const [a, b, c] = bodyOf(`
def f(x: any): any {
  const gated = probe(1) > 0 && probe(2) > 1
  const caught = risky(x) catch fallback(x)
  const piped = load(x) |> clean
  return gated
}`);
    expect(expressionSlots(a.value).map((s) => s.mode)).toEqual(["once", "conditional"]);
    expect(expressionSlots(b.value).map((s) => s.mode)).toEqual(["opaque", "conditional"]);
    expect(expressionSlots(c.value).map((s) => s.mode)).toEqual(["once", "opaque"]);
  });

  it("try operands and with-modified statements are opaque but still readable", () => {
    const [t, w] = bodyOf(`
def f(url: string): any {
  const t = try parse(fetchBody(url))
  const text = dangerous(url) with approve
  return t
}`);
    const trySlots = expressionSlots(t.value);
    expect(trySlots.map((s) => s.mode)).toEqual(["opaque"]);
    expect((trySlots[0].expr as any).functionName).toBe("parse");
    const withSlots = expressionSlots(w);
    expect(withSlots.map((s) => s.mode)).toEqual(["opaque"]);
  });

  it("goto arguments are slots that write back through the node call", () => {
    const parsed = parseAgency(`
node main() {
  goto second(wrap(1))
}

node second(x: number) {
  return x
}`, {}, true);
    if (!parsed.success) throw new Error(parsed.message);
    const main = (parsed.result.nodes as any[]).find(
      (n) => n.type === "graphNode" && n.nodeName !== "second",
    );
    const g = main.body.find((n: any) => n.type === "gotoStatement");
    const slots = expressionSlots(g);
    expect(slots).toHaveLength(1);
    expect((slots[0].expr as any).functionName).toBe("wrap");
    const replacement = { type: "variableName", value: "__tmp" } as unknown as AgencyNode;
    const rebuilt: any = slots[0].write(g, replacement);
    expect(rebuilt.nodeCall.functionName).toBe("second");
    expect(rebuilt.nodeCall.arguments[0].value).toBe("__tmp");
  });

  it("isExpression / typeTestExpression carry their tested expression (parser bars calls there today)", () => {
    const body = bodyOf(`
def f(x: number): number {
  const pv = x + 1
  if (pv is number) { return 1 }
  return 0
}`);
    const ife = body.find((n: any) => n.type === "ifElse");
    const cond = ife.condition;
    expect(cond.type).toBe("typeTestExpression");
    const slots = expressionSlots(cond);
    expect(slots).toHaveLength(1);
    expect(slots[0].mode).toBe("once");
    expect((slots[0].expr as any).value).toBe("pv");
  });
});

describe("expressionSlots: completeness against EXPRESSION_NODE_TYPES", () => {
  // Scope caveat: EXPRESSION_NODE_TYPES mirrors the Expression union
  // only. Statement kinds that carry expression positions (assignment,
  // gotoStatement, messageThread, ifElse, forLoop, ...) are outside
  // this guarantee — and those are the kinds the three original drift
  // holes were in. The statement-position corpus test at the bottom of
  // this file covers that half: every statement kind observed in the
  // corpus must have a recorded ruling in hoistCalls.ts.
  it("every expression kind is enumerated or explicitly empty, never both", () => {
    for (const kind of EXPRESSION_NODE_TYPES) {
      const enumerated = HANDLED_KINDS.includes(kind);
      const declaredEmpty = Object.hasOwn(NO_EXPRESSION_SLOTS, kind);
      expect(
        enumerated || declaredEmpty,
        `unregistered expression kind: ${kind} — add it to expressionSlots.ts`,
      ).toBe(true);
      expect(
        enumerated && declaredEmpty,
        `${kind} is both enumerated and declared empty`,
      ).toBe(false);
      expect(isRegisteredExpressionKind(kind)).toBe(true);
    }
  });
});

// ── Corpus invariants ───────────────────────────────────────────────
// Parse the real language corpus (all stdlib plus the generator fixture
// programs, which contain deliberately odd shapes) and enforce three
// properties on every node. A file that fails to parse FAILS the test:
// a tolerated-skip path would let the corpus quietly shrink to nothing.

function collectAgencyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectAgencyFiles(full));
    else if (entry.endsWith(".agency")) out.push(full);
  }
  return out;
}

function* walkEveryNode(value: any): Generator<any> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkEveryNode(item);
    return;
  }
  if (typeof value.type === "string") yield value;
  for (const key of Object.keys(value)) {
    if (key === "loc") continue;
    yield* walkEveryNode(value[key]);
  }
}

// Parsed once per mode and cached — the walker-coverage invariants below
// re-read the corpus several times, and re-parsing hundreds of files per
// test would make this the slowest file in the repo.
const corpusCache: Record<string, { file: string; nodes: AgencyNode[] }[]> = {};

function corpusPrograms(lower: boolean): { file: string; nodes: AgencyNode[] }[] {
  const cacheKey = lower ? "lowered" : "unlowered";
  if (corpusCache[cacheKey]) return corpusCache[cacheKey];
  const root = join(__dirname, "../..");
  const files = [
    ...collectAgencyFiles(join(root, "stdlib")),
    ...collectAgencyFiles(join(root, "tests/typescriptGenerator")),
  ];
  expect(files.length).toBeGreaterThan(50);
  const out: { file: string; nodes: AgencyNode[] }[] = [];
  for (const file of files) {
    const parsed = parseAgency(readFileSync(file, "utf8"), {}, true, lower);
    if (!parsed.success) {
      throw new Error(
        `corpus file failed to parse (lower: ${lower}): ${file}: ${parsed.message}`,
      );
    }
    out.push({ file, nodes: parsed.result.nodes as AgencyNode[] });
  }
  corpusCache[cacheKey] = out;
  return out;
}

function corpusNodes(): { file: string; node: any }[] {
  const out: { file: string; node: any }[] = [];
  for (const { file, nodes } of corpusPrograms(true)) {
    for (const node of walkEveryNode(nodes)) out.push({ file, node });
  }
  return out;
}

describe("expressionSlots: corpus invariants", () => {
  const nodes = corpusNodes();

  it("write-fold round trip: folding each slot's own expr back through write is identity", () => {
    // Catches every mis-wired write (reads field A, writes field B) and
    // enforces slot non-overlap, across every node in the corpus.
    for (const { file, node } of nodes) {
      const slots = expressionSlots(node);
      if (slots.length === 0) continue;
      const rebuilt = slots.reduce((owner, s) => s.write(owner, s.expr), node);
      expect(rebuilt, `${file}: ${node.type}`).toEqual(node);
    }
  });

  it("mode liveness: every EvalMode occurs somewhere in the corpus", () => {
    const seen: Record<string, boolean> = {};
    for (const { node } of nodes) {
      for (const s of expressionSlots(node)) seen[s.mode] = true;
    }
    expect(Object.keys(seen).sort()).toEqual(
      ["conditional", "once", "opaque", "perIteration"].sort(),
    );
  });

  it("parity: the derived expressionChildren matches slot exprs (order-sensitive, with the recorded exceptions)", () => {
    // This proves the derived view will not regress the type checker —
    // it is NOT the coverage argument (the completeness test above is).
    // Exceptions, each a deliberate recorded divergence between flow
    // order (what expressionChildren historically returned, load-bearing
    // for flowBuilder) and evaluation order (what slots return,
    // load-bearing for hoisting). node.ts carries the matching shims.
    //  - assignment: children are [value, ...targetChain]; slots are
    //    [targetChain..., value].
    //  - comprehension: children are [expression, iterable, condition?];
    //    slots are [iterable, expression, condition?].
    //  - gotoStatement: children expose the WHOLE node call (flow
    //    attaches to the call node); slots expose only its arguments
    //    (the call is control flow, not a rewritable position).
    //  - messageThread: children historically returned [] (the named
    //    args were reached via walkNodes instead); slots expose them.
    for (const { file, node } of nodes) {
      const derived = expressionSlots(node).map((s) => s.expr);
      const viaChildren = expressionChildren(node);
      switch (node.type) {
        case "assignment":
          expect(viaChildren, `${file}: assignment order shim`).toEqual(
            derived.length === 0
              ? []
              : [derived[derived.length - 1], ...derived.slice(0, -1)],
          );
          break;
        case "comprehension": {
          const [iterable, expression, ...cond] = derived;
          expect(viaChildren, `${file}: comprehension order shim`).toEqual(
            [expression, iterable, ...cond],
          );
          break;
        }
        case "gotoStatement":
          expect(viaChildren, `${file}: goto exposes the call node`).toEqual([node.nodeCall]);
          break;
        case "messageThread":
          expect(viaChildren, `${file}: messageThread children historically empty`).toEqual([]);
          break;
        case "isExpression":
        case "typeTestExpression":
          // The shared blind spot that motivated the completeness test:
          // old expressionChildren had no case for either, so the type
          // checker never reached these expressions through it (its own
          // flow rules handle narrowing). The derived view preserves
          // that until the suites prove inclusion safe.
          expect(viaChildren, `${file}: ${node.type} historically empty`).toEqual([]);
          break;
        default:
          expect(viaChildren, `${file}: ${node.type}`).toEqual(derived);
      }
    }
  });

  it("statement-position completeness: every statement kind in the corpus has a recorded ruling in hoistCalls", () => {
    // The expression-side completeness test above is type-checked
    // against EXPRESSION_NODE_TYPES; statement kinds have no type
    // mirror, so this is the statement-side half of the guarantee. A
    // new statement kind that reaches stdlib or the generator fixtures
    // without a ruling fails here BY NAME instead of silently falling
    // through hoistCalls' default dispatch unextracted.
    const known = [
      ...EXTRACTED_STATEMENT_KINDS,
      ...STATEMENT_CASE_KINDS,
      ...NON_EXTRACTED_STATEMENT_KINDS,
      ...SKIP_TYPES,
    ];
    const seen: Record<string, string> = {};
    for (const { file, node } of nodes) {
      const bodies: any[][] = [];
      if (node.type === "function" || node.type === "graphNode") {
        bodies.push((node as any).body ?? []);
      }
      for (const slot of bodySlots(node)) bodies.push(slot.body);
      for (const body of bodies) {
        for (const stmt of body) {
          if (stmt && typeof stmt === "object" && typeof stmt.type === "string") {
            seen[stmt.type] ??= file;
          }
        }
      }
    }
    // Sanity: the walk actually reaches statement positions.
    expect(Object.keys(seen).length).toBeGreaterThan(15);
    for (const [kind, file] of Object.entries(seen)) {
      expect(
        known.includes(kind),
        `statement kind "${kind}" (first seen in ${file}) has no ruling in ` +
          `hoistCalls.ts — add it to EXTRACTED_STATEMENT_KINDS, give it a ` +
          `dispatch case (and STATEMENT_CASE_KINDS), or record it in ` +
          `NON_EXTRACTED_STATEMENT_KINDS with a justification`,
      ).toBe(true);
    }
  });
});

// ── Walker coverage ─────────────────────────────────────────────────
// Template hygiene's free-name analysis (freeNamesOf, hygiene.ts) is
// exactly as complete as walkNodes' descent: a position the walker
// misses under-reports free names, no test fails, and a filler silently
// captures a template binder — capture avoidance failing OPEN. walkNodes
// also backs the symbol table, codegen scope resolution, and the LSP, so
// these invariants guard far more than templates. They run in BOTH parse
// modes: lowered (the compile pipeline's view) and unlowered (the
// template/hygiene view, with patterns and comprehensions intact).
//
// POLICY: fixing walkNodes is never done in the same PR that discovers a
// gap — its consumers (scope resolution → codegen) make every descent
// change a compiler change. A discovered gap gets a KNOWN_WALKER_GAPS
// entry naming a follow-up issue; the fix PR must delete the entry or
// the staleness guard below fails, so the gap cannot be silently
// forgotten in either direction.

// Fields whose expression-typed contents the walker deliberately does
// not yield, keyed "ownerType.field" — a bare field name would silently
// cover every node kind sharing the spelling ("pattern" is also a field
// of isExpression and typePattern). Every entry is a recorded ruling.
const WALKER_EXCLUDED_FIELDS: Record<string, string> = {
  "*.loc": "positions, not nodes",
  "assignment.matchSource":
    "cloned, body-free arm snapshot for the type checker (lib/types.ts) — not live AST; " +
    "the executable guard/arm expressions are walked in their lowered if-chain form",
  "assignment.pattern": "binding pattern: variableName members are binders, not uses",
  "forLoop.itemVar": "for-loop binder (string or pattern), not a use",
  "comprehension.itemVar": "comprehension binder, same shape and ruling as forLoop.itemVar",
  "matchYield.typeSource":
    "type-checker view of the arm expression (lib/types/matchYield.ts); the executable " +
    "copy flows through the hoisted temp assignment, which is walked",
  "objectPatternProperty.value":
    "pattern property content: a literal matcher or a binder, not a use",
  "typePattern.pattern": "type-pattern binder, not a use",
  "functionCall.block":
    "the blockArgument wrapper node is not itself yielded; its BODY is walked through " +
    "bodySlots (blockAncestor) and its params are binders. Body coverage rides on the " +
    "generic bodySlots descent, not on this exclusion",
};

// Temporary entries: reachability gaps found by the invariants below,
// awaiting their own walker-fix PR. Keyed like WALKER_EXCLUDED_FIELDS;
// the value names the follow-up issue. The staleness guard asserts each
// entry still IS a gap, so the fix PR cannot land without deleting it.
// Every entry is a place template hygiene currently under-reports free
// names (capture avoidance fails open there) and the symbol table never
// visits — which is exactly why the fix is a compiler change that gets
// its own PR and review.
const KNOWN_WALKER_GAPS: Record<string, string> = {
  "functionParameter.defaultValue":
    "#668: parameter default expressions are never walked",
  "function.docString":
    "#668: docstring interpolations are evaluated by the builder " +
    "(hasDocStringInterpolation) but the segments are never walked",
  "assignment.accessChain":
    "#668: slice-assignment bounds (arr[a:b] = x) are not walked; " +
    "index and methodCall chain entries are",
  "matchBlockCase.guard":
    "#668: unlowered match-arm guard expressions are not walked " +
    "(the lowered if-chain form is)",
  "tag.arguments":
    "#668: @validate/@tag annotation arguments reference validator " +
    "functions and values but are never walked",
};

function isExcluded(ownerType: string, key: string): boolean {
  return (
    Object.hasOwn(WALKER_EXCLUDED_FIELDS, `*.${key}`) ||
    Object.hasOwn(WALKER_EXCLUDED_FIELDS, `${ownerType}.${key}`)
  );
}

function isKnownGap(ownerType: string, key: string): boolean {
  return Object.hasOwn(KNOWN_WALKER_GAPS, `${ownerType}.${key}`);
}

type StructuralVia = "clear" | "excluded" | "knownGap";

function* structuralNodes(
  value: any,
  ownerType: string,
  via: StructuralVia,
): Generator<{ node: any; via: StructuralVia }> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* structuralNodes(item, ownerType, via);
    return;
  }
  const selfType = typeof value.type === "string" ? value.type : ownerType;
  if (typeof value.type === "string") yield { node: value, via };
  for (const key of Object.keys(value)) {
    const childVia: StructuralVia =
      via !== "clear"
        ? via
        : isExcluded(selfType, key)
          ? "excluded"
          : isKnownGap(selfType, key)
            ? "knownGap"
            : "clear";
    yield* structuralNodes(value[key], selfType, childVia);
  }
}

describe("walker coverage: walkNodes reaches every expression position", () => {
  for (const lower of [true, false]) {
    const label = lower ? "lowered" : "unlowered";

    it(`${label}: slot-table agreement — every expression slot of a walked node is itself walked`, () => {
      // A CONSISTENCY check, not reachability: both sides start from a
      // node the walker already yielded, so this can never prove a node
      // reachable. What it pins is that expressionSlots and walkNodes
      // agree about the children of everything walked. Reachability is
      // the structural invariant below. Slot exprs sitting inside a
      // KNOWN_WALKER_GAPS field are skipped for the same reason the
      // structural invariant shields them: the fix is a deferred walker
      // change, and the staleness guard keeps the entry honest.
      for (const { file, nodes } of corpusPrograms(lower)) {
        const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
        const shielded = new Set(
          [...structuralNodes(nodes, "(root)", "clear")]
            .filter((entry) => entry.via === "knownGap")
            .map((entry) => entry.node),
        );
        for (const node of walked) {
          for (const slot of expressionSlots(node as AgencyNode)) {
            if (shielded.has(slot.expr)) continue;
            expect(
              walked.has(slot.expr),
              `${file}: walkNodes does not descend into a ${(node as any).type} expression slot ` +
                `(slot expr type: ${(slot.expr as any).type}) — template hygiene cannot see names there`,
            ).toBe(true);
          }
        }
      }
    });

    it(`${label}: structural reachability — every expression node in the AST is walked`, () => {
      for (const { file, nodes } of corpusPrograms(lower)) {
        const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
        for (const { node, via } of structuralNodes(nodes, "(root)", "clear")) {
          if (via !== "clear") continue;
          if (!EXPRESSION_NODE_TYPES.includes(node.type)) continue;
          expect(
            walked.has(node),
            `${file}: a ${node.type} node is reachable in the AST but never yielded by walkNodes. ` +
              `Do NOT fix walkNodes in this PR — add a KNOWN_WALKER_GAPS entry naming a follow-up ` +
              `issue, or, if the non-walk is deliberate, a WALKER_EXCLUDED_FIELDS ruling.`,
          ).toBe(true);
        }
      }
    });

    it(`${label}: known gaps are still gaps (staleness guard)`, () => {
      // Each KNOWN_WALKER_GAPS entry must still shield at least one
      // unwalked expression node somewhere in this corpus mode. When the
      // follow-up PR fixes walkNodes, this fails until the entry is
      // deleted — the gap cannot be forgotten in either direction. (An
      // entry only one mode exercises is fine: the guard requires each
      // entry to be live in at least one mode, checked jointly below.)
      const entries = Object.keys(KNOWN_WALKER_GAPS);
      if (entries.length === 0) return;
      for (const key of entries) {
        let stillAGap = false;
        const [ownerType, field] = key.split(".");
        for (const { nodes } of corpusPrograms(lower)) {
          const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
          // Find owner nodes STRUCTURALLY — a gap's owner may itself be
          // a node the walker never yields (functionParameter is).
          for (const owner of walkEveryNode(nodes)) {
            if ((owner as any).type !== ownerType) continue;
            for (const { node, via } of structuralNodes(
              (owner as any)[field],
              ownerType,
              "clear",
            )) {
              // Only nodes THIS entry uniquely shields count — a node
              // under a nested excluded field (via !== "clear") is
              // already ruled on and would not be flagged without the
              // entry either.
              if (via !== "clear") continue;
              if (EXPRESSION_NODE_TYPES.includes(node.type) && !walked.has(node)) {
                stillAGap = true;
              }
            }
          }
        }
        gapLiveness[key] ??= false;
        gapLiveness[key] = gapLiveness[key] || stillAGap;
        if (!lower) {
          // Final mode: judge each entry across both modes.
          expect(
            gapLiveness[key],
            `KNOWN_WALKER_GAPS entry "${key}" no longer shields anything in either corpus mode — ` +
              `the walker gap it recorded is fixed (or the corpus lost the shape). Delete the entry ` +
              `(and close ${KNOWN_WALKER_GAPS[key]}) or restore corpus coverage.`,
          ).toBe(true);
        }
      }
    });
  }

  // Cross-mode liveness accumulator for the staleness guard: an entry is
  // healthy if it shields something in AT LEAST one parse mode.
  const gapLiveness: Record<string, boolean> = {};

  it("liveness: the corpus actually exercises the historically-missed positions", () => {
    // A coverage invariant over kinds the corpus never contains proves
    // nothing. Pin the kinds whose walker descent was added by hand
    // during Template Agency development, in the mode each occurs in.
    const walkedKinds = (lower: boolean): Record<string, true> => {
      const seen: Record<string, true> = {};
      for (const { nodes } of corpusPrograms(lower)) {
        for (const v of walkNodesArray(nodes)) seen[(v.node as any).type] = true;
      }
      return seen;
    };
    const lowered = walkedKinds(true);
    const unlowered = walkedKinds(false);
    for (const kind of ["guardBlock", "tryExpression"]) {
      expect(lowered[kind], `corpus (lowered) never contains a ${kind}`).toBe(true);
    }
    for (const kind of ["isExpression", "comprehension"]) {
      expect(unlowered[kind], `corpus (unlowered) never contains a ${kind}`).toBe(true);
    }
  });
});
