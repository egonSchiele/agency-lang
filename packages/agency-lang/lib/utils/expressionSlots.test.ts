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
import { expressionChildren } from "./node.js";
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

function corpusNodes(): { file: string; node: any }[] {
  const root = join(__dirname, "../..");
  const files = [
    ...collectAgencyFiles(join(root, "stdlib")),
    ...collectAgencyFiles(join(root, "tests/typescriptGenerator")),
  ];
  expect(files.length).toBeGreaterThan(50);
  const out: { file: string; node: any }[] = [];
  for (const file of files) {
    const parsed = parseAgency(readFileSync(file, "utf8"), {}, true);
    if (!parsed.success) {
      throw new Error(`corpus file failed to parse: ${file}: ${parsed.message}`);
    }
    for (const node of walkEveryNode(parsed.result.nodes)) out.push({ file, node });
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
