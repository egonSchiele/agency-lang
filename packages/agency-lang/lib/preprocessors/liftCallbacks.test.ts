import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { liftCallbackBlocks } from "./liftCallbacks.js";
import type { AgencyProgram, AgencyNode } from "@/types.js";
import type { FunctionDefinition, FunctionCall } from "@/types/function.js";

function parse(src: string): AgencyProgram {
  const r = parseAgency(src, {}, true);
  if (!r.success) throw new Error(r.message ?? "parse failed");
  return r.result;
}

function lift(src: string): AgencyProgram {
  // No counter reset needed — `liftCallbackBlocks` closes over a fresh
  // counter per invocation, so each call to `lift()` produces stable
  // `__cb_<scope>_0`, `__cb_<scope>_1`, ... names regardless of prior runs.
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
        n.type === "function" && typeof n.functionName === "string" && n.functionName.startsWith("__cb_"),
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

  it("throws if a callback block survives in a non-statement (expression) position", () => {
    // `print(...)` takes any expression. If a `callback("...") { ... }` block
    // sneaks in as a function argument the statement-oriented transformer
    // won't descend into it; the post-pass assertion should catch it
    // rather than silently emit a closure that would re-introduce the
    // resume bug.
    expect(() =>
      lift(`node main() {\n  print(callback("onNodeStart") { 1 })\n}\n`),
    ).toThrow(/statement position/);
  });

  it("synthesizes a `data` param for the bare-body callback form (no `as` clause)", () => {
    // The runtime hook dispatch always invokes the lifted AgencyFunction
    // with the event data as a positional arg; without a declared
    // parameter that data would land in the synthesized `__state` slot
    // and silently corrupt state. The preprocessor must therefore
    // synthesize a `data: any` param even when the source omits `as`.
    const out = lift(`callback("onNodeStart") { print("hi") }\n`);
    const lifted = findFn(out, "__cb_top_0");
    expect(lifted).toBeDefined();
    expect(lifted!.parameters).toHaveLength(1);
    expect(lifted!.parameters[0].name).toBe("data");
  });

  it("rejects a top-level callback registration wrapped in `with` modifier", () => {
    // Wrapping a top-level callback registration with a `with` modifier
    // (`callback(...) with approve`) is unsupported: the wrap only covers
    // the synchronous registration call (which never fails) and the
    // wrapped form does not survive interrupt + resume because it falls
    // through to globalInitStatements instead of the rerunnable
    // topLevelCallbackStatements bucket. Fail loudly with the source
    // location instead of silently regressing on resume.
    expect(() =>
      lift(
        `def myFn(data: any) { print(data) }\n` +
          `callback("onNodeStart", myFn) with approve\n`,
      ),
    ).toThrow(/cannot be wrapped in `with approve`/);
  });

  it("issues distinct names across separate liftCallbackBlocks invocations", () => {
    // The counter must be per-invocation, not module-level. Two
    // independent lift() calls each get a fresh counter; both should
    // produce `__cb_top_0` rather than the second one drifting to
    // `__cb_top_1`. This protects against concurrent compile sessions
    // sharing the counter and producing identifier collisions.
    const a = lift(`callback("onNodeStart") as data { print(data) }\n`);
    const b = lift(`callback("onNodeEnd") as data { print(data) }\n`);
    expect(findFn(a, "__cb_top_0")).toBeDefined();
    expect(findFn(b, "__cb_top_0")).toBeDefined();
  });
});
