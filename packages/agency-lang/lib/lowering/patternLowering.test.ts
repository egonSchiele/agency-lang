/**
 * Tests for the pattern lowering pass.
 *
 * Inputs are built by parsing real Agency source where possible (more readable
 * and exercises the actual AST shapes the parser emits). For lowering details
 * not naturally expressible in source, we hand-build small AST fragments.
 */

import { describe, it, expect } from "vitest";
import { lowerPatterns, PatternLoweringError } from "./patternLowering.js";
import { parseAgency } from "../parser.js";
import type {
  AgencyNode,
  Assignment,
  ForLoop,
  IfElse,
  MatchBlock,
  WhileLoop,
} from "../types.js";
import type { BinOpExpression } from "../types/binop.js";
import type { ValueAccess } from "../types/access.js";
import { walkNodesArray } from "../utils/node.js";
import { liftCallbackBlocks } from "../preprocessors/liftCallbacks.js";
import type { ResultPattern } from "../types/pattern.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Parse Agency source and return the body of `node main()`. Throws on parse failure. */
function parseMainBody(source: string): AgencyNode[] {
  const wrapped = `node main() {\n${source}\n}`;
  // Pass lower=false so we receive the un-lowered AST and can apply lowering
  // explicitly under test.
  const result = parseAgency(wrapped, {}, false, false);
  if (!result.success) {
    throw new Error(`parse failed: ${result.message ?? "unknown"}\nSource:\n${wrapped}`);
  }
  const program = result.result;
  const node = program.nodes.find((n) => n.type === "graphNode");
  if (!node || node.type !== "graphNode") {
    throw new Error(`expected graphNode, got ${program.nodes.map((n) => n.type).join(", ")}`);
  }
  return node.body;
}

/** Lower the body of a parsed `node main()`. */
function lower(source: string): AgencyNode[] {
  return lowerPatterns(parseMainBody(source));
}

/** Lower a parsed program (full file source, returning all top-level nodes). */
function lowerProgram(source: string): AgencyNode[] {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) {
    throw new Error(`parse failed: ${result.message ?? "unknown"}`);
  }
  return lowerPatterns(result.result.nodes);
}

// ---------------------------------------------------------------------------
// Array destructuring
// ---------------------------------------------------------------------------

describe("array destructuring", () => {
  it("lowers `let [a, b] = items` to tmp + two index bindings", () => {
    const lowered = lower(`let items = [1, 2, 3]\nlet [a, b] = items`);
    // [items assignment, __tmp assignment, a binding, b binding]
    expect(lowered).toHaveLength(4);
    const tmp = lowered[1] as Assignment;
    expect(tmp.type).toBe("assignment");
    expect(tmp.declKind).toBe("const");
    expect(tmp.variableName).toMatch(/^__tmp_/);

    const aBind = lowered[2] as Assignment;
    expect(aBind.variableName).toBe("a");
    expect(aBind.declKind).toBe("let");
    expect(aBind.value.type).toBe("valueAccess");
    expect(((aBind.value as ValueAccess).chain[0] as { kind: string; index: { value: string } })).toMatchObject({
      kind: "index",
      index: { type: "number", value: "0" },
    });

    const bBind = lowered[3] as Assignment;
    expect(bBind.variableName).toBe("b");
    expect(bBind.declKind).toBe("let");
  });

  it("skips wildcard `_` in array pattern", () => {
    const lowered = lower(`let items = [1, 2, 3]\nconst [first, _, third] = items`);
    // [items, __tmp, first, third] — no `_` binding
    expect(lowered).toHaveLength(4);
    expect((lowered[2] as Assignment).variableName).toBe("first");
    expect((lowered[3] as Assignment).variableName).toBe("third");
    // `third` should index [2]
    const thirdAccess = (lowered[3] as Assignment).value as ValueAccess;
    expect(thirdAccess.chain[0]).toMatchObject({
      kind: "index",
      index: { type: "number", value: "2" },
    });
  });

  it("lowers rest in array pattern to slice", () => {
    const lowered = lower(`let items = [1, 2, 3]\nlet [head, ...rest] = items`);
    expect(lowered).toHaveLength(4);
    const restBind = lowered[3] as Assignment;
    expect(restBind.variableName).toBe("rest");
    expect(restBind.value.type).toBe("valueAccess");
    expect((restBind.value as ValueAccess).chain[0]).toMatchObject({
      kind: "slice",
      start: { type: "number", value: "1" },
    });
  });
});

// ---------------------------------------------------------------------------
// Object destructuring
// ---------------------------------------------------------------------------

describe("object destructuring", () => {
  it("lowers `let { name, age } = person` to tmp + two field bindings", () => {
    const lowered = lower(`let person = { name: "Bob", age: 30 }\nlet { name, age } = person`);
    // [person, __tmp, name, age] — no explicit null check; native JS throws naturally.
    expect(lowered).toHaveLength(4);
    expect((lowered[1] as Assignment).variableName).toMatch(/^__tmp_/);

    const nameBind = lowered[2] as Assignment;
    expect(nameBind.variableName).toBe("name");
    expect(nameBind.value.type).toBe("valueAccess");
    expect((nameBind.value as ValueAccess).chain[0]).toMatchObject({
      kind: "property",
      name: "name",
    });
  });

  it("lowers renamed key `const { name: n }`", () => {
    const lowered = lower(`const person = { name: "Bob" }\nconst { name: n } = person`);
    const nBind = lowered[2] as Assignment;
    expect(nBind.variableName).toBe("n");
    expect((nBind.value as ValueAccess).chain[0]).toMatchObject({
      kind: "property",
      name: "name",
    });
  });

  it("lowers object rest to a __objectRest call (handled by TS builder)", () => {
    const lowered = lower(`const person = { name: "B", age: 30, city: "NY" }\nconst { name, ...rest } = person`);
    // [person, __tmp, name, rest]
    expect(lowered).toHaveLength(4);
    const restBind = lowered[3] as Assignment;
    expect(restBind.variableName).toBe("rest");
    expect(restBind.value.type).toBe("functionCall");
    const call = restBind.value as { type: "functionCall"; functionName: string; arguments: unknown[] };
    expect(call.functionName).toBe("__objectRest");
    expect(call.arguments).toHaveLength(2);
    // First arg is the source (varRef to __tmp_X)
    expect((call.arguments[0] as { type: string; value: string }).type).toBe("variableName");
    // Second arg is the array of excluded keys
    const keysArr = call.arguments[1] as { type: string; items: { segments: { value: string }[] }[] };
    expect(keysArr.type).toBe("agencyArray");
    expect(keysArr.items[0].segments[0].value).toBe("name");
  });

  it("lowers nested object/array pattern", () => {
    const lowered = lower(`let loc = { coords: [1, 2] }\nlet { coords: [x, y] } = loc`);
    // [loc, __tmp, x, y]
    expect(lowered).toHaveLength(4);
    const xBind = lowered[2] as Assignment;
    expect(xBind.variableName).toBe("x");
    const xAccess = xBind.value as ValueAccess;
    // chain should be [.coords, [0]]
    expect(xAccess.chain).toHaveLength(2);
    expect(xAccess.chain[0]).toMatchObject({ kind: "property", name: "coords" });
    expect(xAccess.chain[1]).toMatchObject({ kind: "index" });
  });
});

// ---------------------------------------------------------------------------
// `is` operator in pure-boolean context
// ---------------------------------------------------------------------------

describe("`is` operator in boolean context", () => {
  it("lowers `const r = x is { type: \"foo\" }` to equality check", () => {
    const lowered = lower(`let x = { type: "foo" }\nconst r = x is { type: "foo" }`);
    // [x, r = (x.type == "foo")]
    expect(lowered).toHaveLength(2);
    const rAssign = lowered[1] as Assignment;
    expect(rAssign.variableName).toBe("r");
    const value = rAssign.value as BinOpExpression;
    expect(value.type).toBe("binOpExpression");
    expect(value.operator).toBe("==");
  });

  it("throws on shorthand binder in pure-boolean `is` context", () => {
    expect(() => lower(`let x = { type: "foo", val: 1 }\nconst r = x is { type: "foo", val }`)).toThrow(
      PatternLoweringError,
    );
  });
});

// ---------------------------------------------------------------------------
// `if (x is pattern)` with bindings
// ---------------------------------------------------------------------------

describe("if with `is`", () => {
  it("emits condition + bindings in then-body", () => {
    const lowered = lower(`let x = { type: "foo", val: 1 }\nif (x is { type: "foo", val }) { print(val) }`);
    // [x, ifElse]
    expect(lowered).toHaveLength(2);
    const ifNode = lowered[1] as IfElse;
    expect(ifNode.type).toBe("ifElse");
    // condition is x.type == "foo"
    expect(ifNode.condition.type).toBe("binOpExpression");
    // thenBody starts with `const val = x.val`
    const valBind = ifNode.thenBody[0] as Assignment;
    expect(valBind.type).toBe("assignment");
    expect(valBind.variableName).toBe("val");
    expect(valBind.declKind).toBe("const");
  });
});

// ---------------------------------------------------------------------------
// `while (x is pattern)`
// ---------------------------------------------------------------------------

describe("while with `is`", () => {
  it("emits bindings at top of body", () => {
    const lowered = lower(`let x = { v: 1 }\nwhile (x is { v }) { print(v) }`);
    expect(lowered).toHaveLength(2);
    const whileNode = lowered[1] as WhileLoop;
    expect(whileNode.type).toBe("whileLoop");
    // body[0] should be const v = x.v
    const vBind = whileNode.body[0] as Assignment;
    expect(vBind.variableName).toBe("v");
  });
});

// ---------------------------------------------------------------------------
// Match block
// ---------------------------------------------------------------------------

describe("match block lowering", () => {
  it("binds scrutinee once and emits if/else chain for object pattern arms", () => {
    const lowered = lower(`let x = { type: "a", v: 1 }\nmatch(x) { { type: "a", v } => print(v); _ => print(0) }`);
    // [x, scrutineeAssign, ifElse]
    expect(lowered).toHaveLength(3);
    const scrutinee = lowered[1] as Assignment;
    expect(scrutinee.variableName).toMatch(/^__scrutinee_/);
    expect(scrutinee.declKind).toBe("const");

    const ifNode = lowered[2] as IfElse;
    expect(ifNode.type).toBe("ifElse");
    expect(ifNode.condition.type).toBe("binOpExpression");
    // thenBody starts with const v = __scrutinee.v
    const vBind = ifNode.thenBody[0] as Assignment;
    expect(vBind.variableName).toBe("v");
    // elseBody for default
    expect(ifNode.elseBody).toBeDefined();
  });

  it("lowers mixed literal + pattern arms", () => {
    const lowered = lower(`let x = 1\nmatch(x) { 1 => print("one"); { type: "b" } => print("b") }`);
    // [x, scrutineeAssign, ifElse]
    expect(lowered).toHaveLength(3);
    const ifNode = lowered[2] as IfElse;
    // First arm: __scrutinee == 1
    const cond = ifNode.condition as BinOpExpression;
    expect(cond.operator).toBe("==");
    // elseBody contains nested ifElse for next arm
    expect(ifNode.elseBody).toBeDefined();
    const nestedIf = ifNode.elseBody![0] as IfElse;
    expect(nestedIf.type).toBe("ifElse");
  });

  it("lowers match arm with guard", () => {
    const lowered = lower(`let x = { v: 10 }\nmatch(x) { { v } if (v > 5) => print(v); _ => print(0) }`);
    expect(lowered).toHaveLength(3);
    const ifNode = lowered[2] as IfElse;
    expect(ifNode.type).toBe("ifElse");
    // The arm with bindings + guard becomes:
    //   if (lengthCondTrue) { const v = __scrutinee.v; if (v > 5) { print(v) } }
    // The first thenBody item is the binding for v.
    const vBind = ifNode.thenBody[0] as Assignment;
    expect(vBind.variableName).toBe("v");
    // The guard becomes an inner if-else.
    const innerIf = ifNode.thenBody[1] as IfElse;
    expect(innerIf.type).toBe("ifElse");
    expect(innerIf.condition.type).toBe("binOpExpression");
    expect((innerIf.condition as BinOpExpression).operator).toBe(">");
  });

  it("passes through pure literal match unchanged", () => {
    const lowered = lower(`let x = "a"\nmatch(x) { "a" => print(1); _ => print(0) }`);
    // No scrutinee binding emitted; just [x, matchBlock]
    expect(lowered).toHaveLength(2);
    expect(lowered[1].type).toBe("matchBlock");
    const mb = lowered[1] as MatchBlock;
    // arms preserved
    expect(mb.cases.length).toBeGreaterThan(0);
  });

  it("lowers `match(x is pattern)` form: extract bindings once, then guards", () => {
    // The parser does not (yet) accept arbitrary expressions like `s > 5` as a
    // match-arm LHS; it accepts patterns only. We hand-build the AST to verify
    // the lowering is correct for the `match(... is ...)` form.
    const matchBlock: MatchBlock = {
      type: "matchBlock",
      expression: {
        type: "isExpression",
        expression: { type: "variableName", value: "x" } as never,
        pattern: {
          type: "objectPattern",
          properties: [
            { type: "objectPatternShorthand", name: "s" },
            { type: "objectPatternShorthand", name: "b" },
          ],
        } as never,
      } as never,
      cases: [
        {
          type: "matchBlockCase",
          // Hand-built: caseValue is a BinOpExpression `s > 5`
          // (would normally be `MatchPattern`; cast for the test).
          caseValue: {
            type: "binOpExpression",
            operator: ">",
            left: { type: "variableName", value: "s" },
            right: { type: "number", value: "5" },
          } as never,
          body: [
            {
              type: "functionCall",
              functionName: "print",
              arguments: [{ type: "variableName", value: "b" }],
            },
          ] as never,
        },
        {
          type: "matchBlockCase",
          caseValue: "_",
          body: [
            {
              type: "functionCall",
              functionName: "print",
              arguments: [{ type: "number", value: "0" }],
            },
          ] as never,
        },
      ],
    } as MatchBlock;
    const lowered = lowerPatterns([matchBlock]);
    // [scrutinee, assert (object pattern), s = __scrutinee.s, b = __scrutinee.b, ifElse]
    const sIdx = lowered.findIndex((n) => n.type === "assignment" && (n as Assignment).variableName === "s");
    const bIdx = lowered.findIndex((n) => n.type === "assignment" && (n as Assignment).variableName === "b");
    expect(sIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(sIdx);
    const ifNode = lowered[lowered.length - 1] as IfElse;
    expect(ifNode.type).toBe("ifElse");
    // The first arm condition is the guard `s > 5`
    expect((ifNode.condition as BinOpExpression).operator).toBe(">");
  });
});

// ---------------------------------------------------------------------------
// For loop
// ---------------------------------------------------------------------------

describe("for loop with destructuring", () => {
  it("lowers for ([k, v] in entries) to plain itemVar + bindings prepended to body", () => {
    const lowered = lower(`let entries = [[1, 2], [3, 4]]\nfor ([k, v] in entries) { print(k) }`);
    // [entries, forLoop]
    expect(lowered).toHaveLength(2);
    const forNode = lowered[1] as ForLoop;
    expect(forNode.type).toBe("forLoop");
    expect(typeof forNode.itemVar).toBe("string");
    expect(forNode.itemVar as string).toMatch(/^__item_/);
    // body[0] should be const k = __item[0]
    const kBind = forNode.body[0] as Assignment;
    expect(kBind.variableName).toBe("k");
  });

  it("lowers for ({ name, age } in users) similarly", () => {
    const lowered = lower(`let users = [{ name: "a", age: 1 }]\nfor ({ name, age } in users) { print(name) }`);
    expect(lowered).toHaveLength(2);
    const forNode = lowered[1] as ForLoop;
    expect(typeof forNode.itemVar).toBe("string");
    // body should start with: const name = __item.name; const age = __item.age
    const nameBind = forNode.body[0] as Assignment;
    expect(nameBind.variableName).toBe("name");
    const ageBind = forNode.body[1] as Assignment;
    expect(ageBind.variableName).toBe("age");
  });
});

// ---------------------------------------------------------------------------
// Temp uniqueness
// ---------------------------------------------------------------------------

describe("temp uniqueness", () => {
  it("uses distinct temp names across multiple destructurings", () => {
    const lowered = lower(`let a = [1, 2]\nlet b = [3, 4]\nlet [x, y] = a\nlet [p, q] = b`);
    // Find the two __tmp assignments
    const tmps = lowered.filter(
      (n) => n.type === "assignment" && /^__tmp_/.test((n as Assignment).variableName),
    ) as Assignment[];
    expect(tmps).toHaveLength(2);
    expect(tmps[0].variableName).not.toBe(tmps[1].variableName);
  });

  it("starts a fresh counter per top-level lowerPatterns call", () => {
    const a = lowerProgram(`node main() {\n  let xs = [1, 2]\n  let [a, b] = xs\n}\n`);
    const b = lowerProgram(`node main() {\n  let xs = [1, 2]\n  let [a, b] = xs\n}\n`);
    // Find the __tmp in each
    const find = (nodes: AgencyNode[]) => {
      const main = nodes[0] as { body: AgencyNode[] };
      const tmp = main.body.find(
        (n) => n.type === "assignment" && /^__tmp_/.test((n as Assignment).variableName),
      ) as Assignment;
      return tmp.variableName;
    };
    expect(find(a)).toBe(find(b));
  });

  it("emits a DISTINCT scrutinee node object per occurrence (flow-graph node identity)", () => {
    // The flow checker keys narrowing on AST-node identity, so each lowered
    // reference to the `__scrutinee` temp (every arm's isSuccess/isFailure guard
    // and .value/.error binding) MUST be its own node object. Sharing one node
    // collapsed all occurrences to a single flow position — see the match-over-
    // Result regression in narrowing.test.ts.
    const lowered = lower(
      `let r = success(1)\nmatch (r) {\n  success(v) => v\n  failure(e) => e\n}`,
    );
    const scrutNodes: object[] = [];
    const collect = (o: unknown): void => {
      if (!o || typeof o !== "object") return;
      const node = o as Record<string, unknown>;
      if (node.type === "variableName" && typeof node.value === "string" && node.value.startsWith("__scrutinee")) {
        scrutNodes.push(node);
      }
      for (const k of Object.keys(node)) collect(node[k]);
    };
    collect(lowered);
    // Multiple references exist (guards + bindings) and every one is unique.
    expect(scrutNodes.length).toBeGreaterThan(1);
    expect(new Set(scrutNodes).size).toBe(scrutNodes.length);
  });
});

// ---------------------------------------------------------------------------
// Recursion into bodies
// ---------------------------------------------------------------------------

describe("recursion into bodies", () => {
  it("lowers patterns inside if-then bodies", () => {
    const lowered = lower(`let xs = [1, 2]\nif (true) { let [a, b] = xs }`);
    expect(lowered).toHaveLength(2);
    const ifNode = lowered[1] as IfElse;
    // thenBody should now have the lowered destructuring (3 nodes)
    expect(ifNode.thenBody.length).toBeGreaterThanOrEqual(3);
  });

  it("lowers patterns inside for-loop bodies", () => {
    const lowered = lower(`let outer = [1, 2]\nlet inners = [[3, 4]]\nfor (item in inners) { let [x, y] = item }`);
    const forNode = lowered.find((n) => n.type === "forLoop") as ForLoop;
    expect(forNode).toBeDefined();
    // body should now contain the lowered destructuring
    const tmpInBody = forNode.body.find(
      (n) => n.type === "assignment" && /^__tmp_/.test((n as Assignment).variableName),
    );
    expect(tmpInBody).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Result patterns
// ---------------------------------------------------------------------------

describe("result patterns", () => {
  describe("is operator — boolean context (no binding)", () => {
    it("lowers `let x = r is success` to isSuccess(r) call (with the right source)", () => {
      const lowered = lower(`let r = success(1)\nlet x = r is success`);
      // [r assignment, x assignment with isSuccess call]
      expect(lowered).toHaveLength(2);
      const xAssign = lowered[1] as Assignment;
      expect(xAssign.variableName).toBe("x");
      expect(xAssign.value.type).toBe("functionCall");
      const call = xAssign.value as {
        functionName: string;
        arguments: { type: string; value?: string }[];
      };
      expect(call.functionName).toBe("isSuccess");
      // The source `r` must be passed as the single argument — guards against
      // a bug where the check is built against a wrong / constant expression.
      expect(call.arguments).toHaveLength(1);
      expect(call.arguments[0]).toMatchObject({
        type: "variableName",
        value: "r",
      });
    });

    it("lowers `let x = r is failure` to isFailure(r) call (with the right source)", () => {
      const lowered = lower(`let r = failure("err")\nlet x = r is failure`);
      expect(lowered).toHaveLength(2);
      const xAssign = lowered[1] as Assignment;
      expect(xAssign.value.type).toBe("functionCall");
      const call = xAssign.value as {
        functionName: string;
        arguments: { type: string; value?: string }[];
      };
      expect(call.functionName).toBe("isFailure");
      expect(call.arguments).toHaveLength(1);
      expect(call.arguments[0]).toMatchObject({
        type: "variableName",
        value: "r",
      });
    });
  });

  describe("is operator — binding context (if)", () => {
    it("lowers `if (r is success(v))` to isSuccess(r) guard + `const v = r.value` binding", () => {
      const lowered = lower(
        `let r = success(1)\nif (r is success(v)) {\n  print(v)\n}`,
      );
      expect(lowered).toHaveLength(2);
      const ifNode = lowered[1] as IfElse;
      expect(ifNode.type).toBe("ifElse");
      expect(ifNode.condition.type).toBe("functionCall");
      const cond = ifNode.condition as {
        functionName: string;
        arguments: { type: string; value?: string }[];
      };
      expect(cond.functionName).toBe("isSuccess");
      expect(cond.arguments[0]).toMatchObject({
        type: "variableName",
        value: "r",
      });
      // Binding must read `.value` from r (the .success field) — guards
      // against accidentally swapping .value with .error.
      const vBind = ifNode.thenBody[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      expect(vBind.declKind).toBe("const");
      expect(vBind.value.type).toBe("valueAccess");
      const va = vBind.value as ValueAccess;
      expect(va.base).toMatchObject({ type: "variableName", value: "r" });
      expect(va.chain).toEqual([{ kind: "property", name: "value" }]);
    });

    it("lowers `if (r is failure(e))` to isFailure(r) guard + `const e = r.error` binding", () => {
      const lowered = lower(
        `let r = failure("oops")\nif (r is failure(e)) {\n  print(e)\n}`,
      );
      expect(lowered).toHaveLength(2);
      const ifNode = lowered[1] as IfElse;
      expect(ifNode.condition.type).toBe("functionCall");
      const cond = ifNode.condition as {
        functionName: string;
        arguments: { type: string; value?: string }[];
      };
      expect(cond.functionName).toBe("isFailure");
      expect(cond.arguments[0]).toMatchObject({
        type: "variableName",
        value: "r",
      });
      const eBind = ifNode.thenBody[0] as Assignment;
      expect(eBind.variableName).toBe("e");
      expect(eBind.declKind).toBe("const");
      const va = eBind.value as ValueAccess;
      expect(va.base).toMatchObject({ type: "variableName", value: "r" });
      expect(va.chain).toEqual([{ kind: "property", name: "error" }]);
    });
  });

  describe("is operator — binding context (while)", () => {
    it("lowers `while (r is success(v))` to isSuccess guard + binding prepended to body", () => {
      const lowered = lower(
        `let r = success(1)\nwhile (r is success(v)) {\n  print(v)\n}`,
      );
      expect(lowered).toHaveLength(2);
      const whileNode = lowered[1] as WhileLoop;
      expect(whileNode.type).toBe("whileLoop");
      expect(whileNode.condition.type).toBe("functionCall");
      expect(
        (whileNode.condition as { functionName: string }).functionName,
      ).toBe("isSuccess");
      const vBind = whileNode.body[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      expect(vBind.declKind).toBe("const");
      expect(vBind.value.type).toBe("valueAccess");
    });
  });

  describe("nested result patterns inside other patterns", () => {
    it("lowers `[success(v), _]` arm to length+isSuccess checks and arr[0].value binding", () => {
      const lowered = lower(
        `let arr = [success(1), failure("e")]\nmatch (arr) {\n  [success(v), _] => print(v)\n  _ => print("none")\n}`,
      );
      // [arr assignment, scrutinee assignment, ifElse]
      expect(lowered).toHaveLength(3);
      const ifNode = lowered[2] as IfElse;
      // The condition is `length >= 2 && isSuccess(__scrutinee_n[0])`
      // (combined via && — top-level is a binOp).
      expect(ifNode.condition.type).toBe("binOpExpression");
      // The first binding in the then-body is the nested result-pattern
      // binding for `v`.
      const vBind = ifNode.thenBody[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      expect(vBind.declKind).toBe("const");
      expect(vBind.value.type).toBe("valueAccess");
    });
  });

  describe("is operator — binding in pure-boolean context is an error", () => {
    it("rejects `let x = r is success(v)`", () => {
      expect(() =>
        lower(`let r = success(1)\nlet x = r is success(v)`),
      ).toThrow(PatternLoweringError);
    });

    it("rejects `let x = r is failure(e)`", () => {
      expect(() =>
        lower(`let r = failure("e")\nlet x = r is failure(e)`),
      ).toThrow(PatternLoweringError);
    });
  });

  describe("match arms", () => {
    it("lowers match with success/failure arms to if/else-if chain with correct bindings on BOTH arms", () => {
      const lowered = lower(
        `let r = success(42)\nmatch (r) {\n  success(v) => print(v)\n  failure(e) => print(e)\n}`,
      );
      // [r assignment, scrutinee assignment, if/else-if chain]
      expect(lowered).toHaveLength(3);
      const scrutinee = lowered[1] as Assignment;
      expect(scrutinee.variableName).toMatch(/^__scrutinee_/);
      const scrutineeName = scrutinee.variableName;

      const ifNode = lowered[2] as IfElse;
      expect(ifNode.type).toBe("ifElse");

      // success arm: isSuccess(scrutinee) + const v = scrutinee.value
      expect(ifNode.condition.type).toBe("functionCall");
      const successCond = ifNode.condition as {
        functionName: string;
        arguments: { type: string; value?: string }[];
      };
      expect(successCond.functionName).toBe("isSuccess");
      expect(successCond.arguments[0]).toMatchObject({
        type: "variableName",
        value: scrutineeName,
      });
      const vBind = ifNode.thenBody[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      const vAccess = vBind.value as ValueAccess;
      expect(vAccess.base).toMatchObject({
        type: "variableName",
        value: scrutineeName,
      });
      expect(vAccess.chain).toEqual([{ kind: "property", name: "value" }]);

      // failure arm: isFailure(scrutinee) + const e = scrutinee.error
      expect(ifNode.elseBody).toBeDefined();
      const elseIf = ifNode.elseBody![0] as IfElse;
      expect(elseIf.condition.type).toBe("functionCall");
      const failureCond = elseIf.condition as {
        functionName: string;
        arguments: { type: string; value?: string }[];
      };
      expect(failureCond.functionName).toBe("isFailure");
      expect(failureCond.arguments[0]).toMatchObject({
        type: "variableName",
        value: scrutineeName,
      });
      const eBind = elseIf.thenBody[0] as Assignment;
      expect(eBind.variableName).toBe("e");
      expect(eBind.declKind).toBe("const");
      const eAccess = eBind.value as ValueAccess;
      expect(eAccess.base).toMatchObject({
        type: "variableName",
        value: scrutineeName,
      });
      expect(eAccess.chain).toEqual([{ kind: "property", name: "error" }]);
    });
  });
});

describe("match metadata preservation (matchSource)", () => {
  function findTaggedAssignment(nodes: AgencyNode[]): Assignment | undefined {
    const hit = walkNodesArray(nodes).find(
      ({ node }) => node.type === "assignment" && node.matchSource,
    );
    return hit?.node as Assignment | undefined;
  }

  it("tags the lowered scrutinee assignment with the original match", () => {
    const lowered = lower(`
let r = foo()
match (r) {
  success(v) => print(v)
  failure(e) => print(e)
}
`);
    const tagged = findTaggedAssignment(lowered);
    expect(tagged).toBeDefined();
    const arms = tagged?.matchSource;
    expect(arms?.length).toBe(2); // success + failure arms preserved
    // Structure carried through, not just the arm count: the first arm is a
    // `success(...)` result pattern.
    const pattern = arms?.[0]?.caseValue;
    expect(pattern !== "_" && (pattern as ResultPattern)?.kind).toBe("success");
    // Slim snapshot: arms carry only the matcher metadata, never the body.
    expect(arms?.[0]).not.toHaveProperty("body");
  });

  it("lowers a nested `is` in the match head — no isExpression survives", () => {
    // Regression: a nested `is` in a compound scrutinee must be lowered to a
    // boolean condition; if it survives raw, codegen has no isExpression
    // handler and crashes ("Unhandled Agency node type: isExpression").
    const lowered = lower(`
let r = foo()
let y = true
match ((r is success) && y) {
  success(v) => print("s")
  failure(e) => print("f")
}
`);
    const survived = walkNodesArray(lowered).some(
      ({ node }) => node.type === "isExpression",
    );
    expect(survived).toBe(false);
  });

  it("survives liftCallbackBlocks (match nested in a callback block)", () => {
    // Uses parseAgency + lowerPatterns directly rather than the `lower(...)`
    // helper: `lower` wraps its input in a `node main()` body, but we want the
    // callback block as the top-level shape fed to liftCallbackBlocks so the
    // lift actually moves it. Do NOT "simplify" this back to `lower(...)`.
    const src = `callback("onNodeStart") as data {
  let r = foo()
  match (r) {
    success(v) => print(v)
    failure(e) => print(e)
  }
}
`;
    const parsed = parseAgency(src, {}, false, false);
    if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
    const loweredProgram = {
      ...parsed.result,
      nodes: lowerPatterns(parsed.result.nodes),
    };
    const lifted = liftCallbackBlocks(loweredProgram);
    expect(findTaggedAssignment(lifted.nodes)).toBeDefined();
  });
});

describe("lowering inside thread blocks", () => {
  it("lowers `if (r is success(v))` inside a thread block — no isExpression survives", () => {
    // Regression: mapBodies had no messageThread case, so lowering never
    // descended into `thread { ... }` bodies. The raw isExpression reached
    // the TypeScriptBuilder, which crashed with
    // "Unhandled Agency node type: isExpression".
    const lowered = lower(`
thread {
  let r = foo()
  if (r is success(v)) {
    print(v)
  } else {
    print("failed")
  }
}
`);
    const survived = walkNodesArray(lowered).some(
      ({ node }) => node.type === "isExpression",
    );
    expect(survived).toBe(false);
  });
});

describe("lowering inside with-wrapped statements", () => {
  it("lowers a boolean `is` inside `stmt with approve` — no isExpression survives", () => {
    // Regression: mapBodies (now bodySlots) skipped withModifier, so the
    // wrapped statement was never lowered and a raw isExpression could
    // reach codegen.
    const lowered = lower(`
let r = foo()
print(r is success) with approve
`);
    const survived = walkNodesArray(lowered).some(
      ({ node }) => node.type === "isExpression",
    );
    expect(survived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// type patterns
// ---------------------------------------------------------------------------

describe("type pattern lowering", () => {
  function findAll(nodes: AgencyNode[], pred: (n: any) => boolean): any[] {
    return walkNodesArray(nodes)
      .map((entry) => entry.node as any)
      .filter(pred);
  }

  it("is Type in an if condition lowers to a typeTestExpression", () => {
    const body = parseMainBody(`const x: any = 1\nif (x is string) { print(x) }`);
    const lowered = lowerPatterns(body);
    const ifs = findAll(lowered, (n) => n.type === "ifElse");
    expect(ifs.length).toBeGreaterThan(0);
    expect(ifs[0].condition).toMatchObject({
      type: "typeTestExpression",
      typeHint: { type: "primitiveType", value: "string" },
    });
  });

  it("arm binder with type suffix binds the ORIGINAL scrutinee", () => {
    const body = parseMainBody(
      `const x: any = 1\nmatch (x) {\ns: string => print(s)\n_ => print("no")\n}`,
    );
    const lowered = lowerPatterns(body);
    const assigns = findAll(
      lowered,
      (n) => n.type === "assignment" && n.variableName === "s",
    );
    expect(assigns.length).toBe(1);
    // Bound from the scrutinee temp variable, not from any validation result.
    expect(assigns[0].value.type).toBe("variableName");
  });

  it("destructuring arm with type suffix emits the field binders", () => {
    const body = parseMainBody(
      `const x: any = 1\nmatch (x) {\n{name}: Person => print(name)\n_ => print("no")\n}`,
    );
    const lowered = lowerPatterns(body);
    const assigns = findAll(
      lowered,
      (n) => n.type === "assignment" && n.variableName === "name",
    );
    expect(assigns.length).toBe(1);
    expect(assigns[0].value.type).toBe("valueAccess");
    const tests = findAll(lowered, (n) => n.type === "typeTestExpression");
    expect(tests.length).toBeGreaterThan(0);
  });

  it("array pattern with type suffix emits element binders and the test", () => {
    const body = parseMainBody(
      `const x: any = 1\nmatch (x) {\n[a, b]: number[] => print(a)\n_ => print("no")\n}`,
    );
    const lowered = lowerPatterns(body);
    expect(
      findAll(lowered, (n) => n.type === "assignment" && n.variableName === "a").length,
    ).toBe(1);
    expect(findAll(lowered, (n) => n.type === "typeTestExpression").length).toBeGreaterThan(0);
  });

  it("lowered match keeps the typePattern in matchSource for exhaustiveness", () => {
    const body = parseMainBody(
      `const x: any = 1\nmatch (x) {\ns: string => print(s)\n_ => print("no")\n}`,
    );
    const lowered = lowerPatterns(body);
    const scrutinees = findAll(lowered, (n) => n.type === "assignment" && n.matchSource);
    expect(scrutinees.length).toBe(1);
    expect(
      scrutinees[0].matchSource.some((m: any) => m.caseValue?.type === "typePattern"),
    ).toBe(true);
  });

  it("is Type as a plain boolean stays legal (no binders to reject)", () => {
    const body = parseMainBody(`const x: any = 1\nconst b = x is string`);
    const lowered = lowerPatterns(body);
    const assigns = findAll(lowered, (n) => n.type === "assignment" && n.variableName === "b");
    expect(assigns[0].value.type).toBe("typeTestExpression");
  });
});
