import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { Scope } from "./scope.js";
import { typeAt, freshMemo, type FlowEnvironment, type FlowNode, type PathSegment } from "./flow.js";
import { buildFlowGraph, buildFlowGraphs } from "./flowBuilder.js";
import { walkNodes } from "../utils/node.js";
import type { AgencyNode, VariableType } from "../types.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";

const NUM: VariableType = { type: "primitiveType", value: "number" };
const STR: VariableType = { type: "primitiveType", value: "string" };

// Wrap snippets in a function so `return` is valid and we exercise a real
// per-scope body. Tests hand-build the Scope, so the wrapper's emptiness is fine.
function parseBody(src: string): AgencyNode[] {
  const r = parseAgency(`def __f() {\n${src}\n}`);
  if (!r.success) {
    throw new Error(`parse failed: ${r.message}`);
  }
  const fn = r.result.nodes.find((n) => n.type === "function");
  if (!fn || fn.type !== "function") {
    throw new Error("expected a function");
  }
  return fn.body;
}

// `typeAliases` defaults to {} for forward-compat: real `buildFlowGraphs`
// passes `ctx.getTypeAliases()`, so alias-typed tests can too.
function freshEnv(
  scope: Scope,
  typeAliases: FlowEnvironment["typeAliases"] = {},
): FlowEnvironment {
  return { scope, flowOf: new WeakMap(), typeAliases, memo: freshMemo() };
}

const ref = (variable: string) => ({ variable, chain: [] as PathSegment[] });

function find(body: AgencyNode[], pred: (n: AgencyNode) => boolean): AgencyNode {
  for (const { node } of walkNodes(body)) {
    if (pred(node)) {
      return node;
    }
  }
  throw new Error("node not found");
}

/** True if a `loop` node is reachable from `f` via the prev-chain. */
function reachesLoop(f: FlowNode): boolean {
  if (f.kind === "loop") {
    return true;
  }
  if (f.kind === "join") {
    return f.prev.some(reachesLoop);
  }
  if (f.kind === "start" || f.kind === "exit") {
    return false;
  }
  return reachesLoop(f.prev);
}

describe("buildFlowGraph — linear", () => {
  it("assign nodes carry the scope's type at the end of a straight-line body", () => {
    const body = parseBody(`let x = 5\nlet y = "hi"`);
    const scope = new Scope("t");
    scope.declare("x", NUM);
    scope.declare("y", STR);
    const env = freshEnv(scope);
    const end = buildFlowGraph(body, { kind: "start", scope }, env);
    expect(typeAt(ref("x"), end, env)).toEqual(NUM);
    expect(typeAt(ref("y"), end, env)).toEqual(STR);
  });

  it("a return statement ends the body in an exit node", () => {
    const body = parseBody(`return x`);
    const scope = new Scope("t");
    const env = freshEnv(scope);
    const end = buildFlowGraph(body, { kind: "start", scope }, env);
    expect(end.kind).toBe("exit");
  });

  it("`return interrupt effect(...)` falls through — later statements stay reachable", () => {
    // The gated-work idiom (stdlib git/wikipedia/memory): `return interrupt`
    // resumes past itself on approval, so the statements after it are live.
    // Before this fix the flow builder treated it as `exit`, so refs after it
    // got no flow node and narrowing silently degraded to bare scope.lookup.
    const body = parseBody(`return interrupt confirm("sure?")\nlet x = 5\nprint(x)`);
    const scope = new Scope("t");
    scope.declare("x", NUM);
    const env = freshEnv(scope);
    const end = buildFlowGraph(body, { kind: "start", scope }, env);
    expect(end.kind).not.toBe("exit");
    const xRef = find(body, (n) => n.type === "variableName" && n.value === "x");
    expect(env.flowOf.get(xRef)).toBeDefined();
  });

  it("stops at unreachable code after a return (no throw, even with a later loop)", () => {
    const body = parseBody(`return x\nwhile (c) {\n  y = 1\n}`);
    const scope = new Scope("t");
    scope.declare("c", { type: "primitiveType", value: "boolean" });
    scope.declare("y", NUM);
    const env = freshEnv(scope);
    expect(() => buildFlowGraph(body, { kind: "start", scope }, env)).not.toThrow();
  });

  it("INVARIANT: every variableName / valueAccess gets a flowOf entry", () => {
    const body = parseBody(`let x = 5\nprint(x)\nlet z = x`);
    const scope = new Scope("t");
    scope.declare("x", NUM);
    scope.declare("z", NUM);
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    for (const { node } of walkNodes(body)) {
      if (node.type === "variableName" || node.type === "valueAccess") {
        expect(env.flowOf.get(node), `flowOf missing for ${node.type}`).toBeDefined();
      }
    }
  });

  it("REGRESSION (M1): a property-access valueAccess (obj.field) gets a flowOf entry", () => {
    // synthValueAccess's member-path narrowing gate silently degrades to "no
    // narrowing" if a `.property` valueAccess stops being attached to the flow
    // graph. Pin it: the `obj.field` node must have a flowOf entry.
    const body = parseBody(`let obj = { field: 1 }\nprint(obj.field)`);
    const scope = new Scope("t");
    scope.declare("obj", { type: "objectType", properties: [{ key: "field", value: NUM }] });
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    const access = find(
      body,
      (n) => n.type === "valueAccess" && n.base.type === "variableName" && n.base.value === "obj",
    );
    expect(env.flowOf.get(access)).toBeDefined();
  });

  it("REGRESSION: a valueAccess inside an expression-position block body gets a flowOf entry", () => {
    // A block on a call used as an EXPRESSION (assignment value) must have its
    // body flow-walked, so a `.property` access inside it narrows. Pins the
    // mechanism (flowOf attached), not just the outcome.
    const body = parseBody(`let n = wrap(3) as value {\n  let inner = obj.field\n  return inner\n}`);
    const scope = new Scope("t");
    scope.declare("obj", { type: "objectType", properties: [{ key: "field", value: NUM }] });
    scope.declare("wrap", { type: "primitiveType", value: "any" });
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    const access = find(
      body,
      (n) => n.type === "valueAccess" && n.base.type === "variableName" && n.base.value === "obj",
    );
    expect(env.flowOf.get(access)).toBeDefined();
  });

  it("REGRESSION (M2): an index valueAccess (arr[0]) gets a flowOf entry", () => {
    const body = parseBody(`let arr = [1, 2]\nprint(arr[0])`);
    const scope = new Scope("t");
    scope.declare("arr", { type: "arrayType", elementType: NUM });
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    const access = find(
      body,
      (n) => n.type === "valueAccess" && n.base.type === "variableName" && n.base.value === "arr",
    );
    expect(env.flowOf.get(access)).toBeDefined();
  });

  it("INVARIANT holds across slice / computed-key / index positions", () => {
    // `lo`/`hi` live inside a slice; `key` inside a computed key — both were
    // missed before expressionChildren covered slice + computedKey.
    const body = parseBody(
      `let arr = [10, 20, 30]\nlet lo = 0\nlet hi = 2\nlet part = arr[lo:hi]\nlet key = "k"\nlet obj = { [key]: part }\nprint(obj[key])`,
    );
    const scope = new Scope("t");
    for (const name of ["arr", "lo", "hi", "part", "key", "obj"]) {
      scope.declare(name, NUM);
    }
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    for (const { node } of walkNodes(body)) {
      if (node.type === "variableName" || node.type === "valueAccess") {
        expect(env.flowOf.get(node), `flowOf missing for ${node.type}`).toBeDefined();
      }
    }
  });
});

describe("buildFlowGraph — ifElse", () => {
  const memberA: VariableType = {
    type: "objectType",
    properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "a" } },
      { key: "v", value: STR },
    ],
  };
  const memberB: VariableType = {
    type: "objectType",
    properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "b" } },
      { key: "v", value: NUM },
    ],
  };
  const ab: VariableType = { type: "unionType", types: [memberA, memberB] };

  it("narrows inside the then-branch at the access site", () => {
    const body = parseBody(`if (u.kind == "a") {\n  print(u)\n}`);
    const scope = new Scope("t");
    scope.declare("u", ab);
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    const insidePrint = find(body, (n) => n.type === "functionCall" && n.functionName === "print");
    const uRef = find([insidePrint], (n) => n.type === "variableName" && n.value === "u");
    expect(typeAt(ref("u"), env.flowOf.get(uRef)!, env)).toEqual(memberA);
  });

  it("post-guard: after a returning then-branch, the tail sees the complement member", () => {
    const body = parseBody(`if (r.kind == "b") {\n  return r\n}\nprint(r)`);
    const scope = new Scope("t");
    scope.declare("r", ab);
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    const tailPrint = find(body, (n) => n.type === "functionCall" && n.functionName === "print");
    const rRef = find([tailPrint], (n) => n.type === "variableName" && n.value === "r");
    expect(typeAt(ref("r"), env.flowOf.get(rRef)!, env)).toEqual(memberA);
  });
});

describe("buildFlowGraph — loops", () => {
  it("a while loop builds a loop node on the back-edge", () => {
    // Red under Task 1/2 (linear recursion → no loop node); green after Step 7.
    const body = parseBody(`while (cond) {\n  x = 1\n}\nprint(x)`);
    const scope = new Scope("t");
    scope.declare("cond", { type: "primitiveType", value: "boolean" });
    scope.declare("x", NUM);
    const env = freshEnv(scope);
    const end = buildFlowGraph(body, { kind: "start", scope }, env);
    expect(reachesLoop(end)).toBe(true);
  });
});

describe("attachExpressionsToFlow — short-circuit", () => {
  const memberA: VariableType = {
    type: "objectType",
    properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "a" } },
      { key: "v", value: STR },
    ],
  };
  const memberB: VariableType = {
    type: "objectType",
    properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "b" } },
      { key: "v", value: NUM },
    ],
  };
  const ab: VariableType = { type: "unionType", types: [memberA, memberB] };

  it("RHS of && sees the LHS's then-narrowing", () => {
    const body = parseBody(`let z = u.kind == "a" && u.kind == "a"`);
    const scope = new Scope("t");
    scope.declare("u", ab);
    scope.declare("z", { type: "primitiveType", value: "boolean" });
    const env = freshEnv(scope);
    buildFlowGraph(body, { kind: "start", scope }, env);
    const andExpr = find(
      body,
      (n) => n.type === "binOpExpression" && n.operator === "&&",
    ) as Extract<AgencyNode, { type: "binOpExpression" }>;
    const rightU = find([andExpr.right as AgencyNode], (n) => n.type === "valueAccess");
    expect(typeAt(ref("u"), env.flowOf.get(rightU)!, env)).toEqual(memberA);
  });
});

it("rejects a detached child scope as a flow root", () => {
  const detachedScope = new Scope("fn").child();
  const info = {
    scope: detachedScope,
    body: [],
    name: "f",
    scopeKey: "fn:f",
    file: "",
  } as ScopeInfo;
  const ctx = { getTypeAliases: () => ({}) } as unknown as TypeCheckerContext;
  expect(() => buildFlowGraphs([info], ctx)).toThrow(/detached/);
});
