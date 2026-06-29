import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { Scope } from "./scope.js";
import { typeAt, type FlowEnvironment, type FlowNode } from "./flow.js";
import { buildFlowGraph } from "./flowBuilder.js";
import { walkNodes } from "../utils/node.js";
import type { AgencyNode, VariableType } from "../types.js";

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
  return { scope, flowOf: new WeakMap(), typeAliases, memo: new WeakMap() };
}

const ref = (variable: string) => ({ variable, chain: [] as string[] });

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
