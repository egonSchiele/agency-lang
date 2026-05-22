import { describe, it, expect, beforeEach } from "vitest";
import { parseAgency } from "@/parser.js";
import { liftCallbackBlocks, resetCallbackCounter } from "./liftCallbacks.js";
import type { AgencyProgram, AgencyNode } from "@/types.js";
import type { FunctionDefinition, FunctionCall } from "@/types/function.js";

function parse(src: string): AgencyProgram {
  const r = parseAgency(src, {}, true);
  if (!r.success) throw new Error(r.message ?? "parse failed");
  return r.result;
}

function lift(src: string): AgencyProgram {
  resetCallbackCounter();
  return liftCallbackBlocks(parse(src));
}

function findFn(program: AgencyProgram, name: string): FunctionDefinition | undefined {
  return program.nodes.find(
    (n): n is FunctionDefinition => n.type === "function" && n.functionName === name,
  );
}

function findCalls(nodes: AgencyNode[], fnName: string): FunctionCall[] {
  const out: FunctionCall[] = [];
  function walk(node: AgencyNode) {
    if (node.type === "functionCall" && node.functionName === fnName) {
      out.push(node);
    }
    if (node.type === "function" || node.type === "graphNode") {
      for (const c of node.body) walk(c);
    }
  }
  for (const n of nodes) walk(n);
  return out;
}

describe("liftCallbackBlocks", () => {
  beforeEach(() => resetCallbackCounter());

  it("lifts a top-level callback block to __cb_top_0", () => {
    const out = lift(`callback("onNodeStart") as data {\n  print(data.nodeName)\n}\n`);
    const lifted = findFn(out, "__cb_top_0");
    expect(lifted).toBeDefined();
    expect(lifted!.parameters).toHaveLength(1);
    expect(lifted!.parameters[0].name).toBe("data");

    const calls = findCalls(out.nodes, "callback");
    expect(calls).toHaveLength(1);
    // Original arg "onNodeStart" plus the new variableName arg referencing the lifted def.
    expect(calls[0].arguments).toHaveLength(2);
    const fnArg = calls[0].arguments[1] as any;
    expect(fnArg.type).toBe("variableName");
    expect(fnArg.value).toBe("__cb_top_0");
    expect(calls[0].block).toBeUndefined();
  });

  it("lifts a scoped callback inside a def to __cb_<funcName>_0", () => {
    const out = lift(
      `def wrap() {\n  callback("onFunctionEnd") as data {\n    print(data.functionName)\n  }\n}\n`,
    );
    const lifted = findFn(out, "__cb_wrap_0");
    expect(lifted).toBeDefined();
    // Lifted def appears BEFORE `wrap` (preprended).
    const wrapIdx = out.nodes.findIndex(
      (n) => n.type === "function" && n.functionName === "wrap",
    );
    const liftedIdx = out.nodes.findIndex(
      (n) => n.type === "function" && n.functionName === "__cb_wrap_0",
    );
    expect(liftedIdx).toBeLessThan(wrapIdx);

    const calls = findCalls(out.nodes, "callback");
    expect(calls).toHaveLength(1);
    expect((calls[0].arguments[1] as any).value).toBe("__cb_wrap_0");
    expect(calls[0].block).toBeUndefined();
  });

  it("lifts a scoped callback inside a graphNode to __cb_<nodeName>_0", () => {
    const out = lift(
      `node main() {\n  callback("onNodeStart") as data {\n    print(data.nodeName)\n  }\n  return 1\n}\n`,
    );
    expect(findFn(out, "__cb_main_0")).toBeDefined();
  });

  it("leaves named-fn form `callback(name, fn)` unchanged", () => {
    const out = lift(
      `def myCb(data: any) { print(data) }\ncallback("onNodeStart", myCb)\n`,
    );
    // No lifted def beyond the user's `myCb`.
    const liftedDefs = out.nodes.filter(
      (n): n is FunctionDefinition =>
        n.type === "function" && n.functionName.startsWith("__cb_"),
    );
    expect(liftedDefs).toHaveLength(0);

    const calls = findCalls(out.nodes, "callback");
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toHaveLength(2);
    // No new arg appended; the original myCb reference is preserved.
    expect((calls[0].arguments[1] as any).type).toBe("variableName");
    expect((calls[0].arguments[1] as any).value).toBe("myCb");
  });

  it("numbers multiple callbacks in the same scope monotonically", () => {
    const out = lift(
      `def wrap() {\n  callback("onFunctionStart") as data { print(data.functionName) }\n  callback("onFunctionEnd") as data { print(data.functionName) }\n}\n`,
    );
    expect(findFn(out, "__cb_wrap_0")).toBeDefined();
    expect(findFn(out, "__cb_wrap_1")).toBeDefined();
  });

  it("preserves loc on the lifted def (from the block-arg or call)", () => {
    const out = lift(
      `callback("onNodeStart") as data { print(data.nodeName) }\n`,
    );
    const lifted = findFn(out, "__cb_top_0");
    expect(lifted!.loc).toBeDefined();
    // The original callback() call started at line 0.
    expect(lifted!.loc!.line).toBeGreaterThanOrEqual(0);
  });

  it("preserves loc on identifiers inside the lifted body", () => {
    const out = lift(
      `let log: string = ""\ncallback("onNodeStart") as data {\n  log = log + data.nodeName\n}\n`,
    );
    const lifted = findFn(out, "__cb_top_0");
    expect(lifted).toBeDefined();
    // The first body statement is the assignment `log = log + data.nodeName`.
    const stmt = lifted!.body[0] as any;
    expect(stmt.loc).toBeDefined();
    expect(stmt.loc.line).toBeGreaterThan(0);
  });

  it("recurses into nested control flow (if/for/while) inside a def", () => {
    const out = lift(
      `def wrap(items: any[]) {\n  for (item in items) {\n    if (true) {\n      callback("onFunctionEnd") as data { print(data.functionName) }\n    }\n  }\n}\n`,
    );
    expect(findFn(out, "__cb_wrap_0")).toBeDefined();
  });

  it("handles a bare-body callback form (no `as` clause)", () => {
    // Verify parser shape first — block.params may be [] for bare form.
    const out = lift(`callback("onNodeStart") { print("hi") }\n`);
    const lifted = findFn(out, "__cb_top_0");
    expect(lifted).toBeDefined();
    // No params → empty function-parameter array.
    expect(lifted!.parameters).toHaveLength(0);
  });
});
