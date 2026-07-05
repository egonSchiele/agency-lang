import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function lowerBody(src: string): any[] {
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(parsed.message);
  const main: any = parsed.result.nodes.find(
    (n: any) => n.type === "graphNode" || n.type === "function",
  );
  return main.body;
}

describe("expression match lowering", () => {
  it("literal arms: temp + tagged match + consumer with matching ids", () => {
    const body = lowerBody(`node main() {
  const val = match("a") {
    "a" => 1
    _ => 2
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(matchStmt.matchExprId).toBeTypeOf("number");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    // Every single-expression arm hoists its value to a temp, then yields it.
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(y.matchId).toBe(matchStmt.matchExprId);
    // The type checker reads `typeSource` (the original literal), not the temp.
    expect(y.typeSource).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    const assign = body.find((n: any) => n.type === "assignment" && n.variableName === "val");
    expect(assign.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
    expect(assign.matchExprSource.matchId).toBe(matchStmt.matchExprId);
    expect(body.indexOf(matchStmt)).toBeLessThan(body.indexOf(assign));
  });

  it("rewrites return in block arms to matchYield with the right value", () => {
    const body = lowerBody(`node main() {
  const val = match("a") {
    "a" => {
      print("hi")
      return 1
    }
    _ => 2
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(y.value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    expect(arm.body.some((s: any) => s.type === "returnStatement")).toBe(false);
  });

  it("return match(...) lowers to statements-then-return of the temp", () => {
    const body = lowerBody(`def f(x: string): number {
  return match(x) {
    "a" => 1
    _ => 2
  }
}`);
    const ret = body[body.length - 1];
    expect(ret.type).toBe("returnStatement");
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(ret.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
  });

  it("pattern arms: scrutinee hoisted once, before the tagged chain", () => {
    const body = lowerBody(`node main(r: Result) {
  const val = match(r) {
    success(v) => v
    failure(e) => 0
  }
  return val
}`);
    const scrutinee = body.find((n: any) => n.type === "assignment" && n.matchSource);
    const chain = body.find((n: any) => n.type === "ifElse");
    expect(scrutinee.matchExprId).toBeTypeOf("number");
    expect(chain.matchExprId).toBe(scrutinee.matchExprId);
    expect(body.indexOf(scrutinee)).toBeLessThan(body.indexOf(chain));
  });

  it("guarded arms in expression position lower and yield", () => {
    const body = lowerBody(`node main(x: any) {
  const val = match(x) {
    { kind: "n", v } if (v > 0) => v
    _ => 0
  }
  return val
}`);
    expect(body.some((n: any) => n.matchExprId !== undefined)).toBe(true);
  });

  it("nested return match(...) inside an arm lowers inner-first", () => {
    const body = lowerBody(`node main(x: string) {
  const val = match(x) {
    "a" => {
      return match(x) {
        "a" => 1
        _ => 2
      }
    }
    _ => 3
  }
  return val
}`);
    const outer = body.find((n: any) => n.type === "matchBlock" && n.matchExprId !== undefined);
    const arm = outer.cases.find((c: any) => c.type === "matchBlockCase");
    // arm body: [ ...inner lowered statements..., matchYield(varRef __matchval_inner) ]
    const inner = arm.body.find((s: any) => s.type === "matchBlock" && s.matchExprId !== undefined);
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(inner.matchExprId).not.toBe(outer.matchExprId);
    expect(y.matchId).toBe(outer.matchExprId);
    expect(y.value.value).toBe(`__matchval_${inner.matchExprId}`);
    expect(arm.body.indexOf(inner)).toBeLessThan(arm.body.indexOf(y));
  });

  it("const x = match(...) inside an arm body lowers via recursion", () => {
    const body = lowerBody(`node main(x: string) {
  const val = match(x) {
    "a" => {
      const inner = match(x) {
        "a" => 1
        _ => 2
      }
      return inner
    }
    _ => 3
  }
  return val
}`);
    const outer = body.find((n: any) => n.type === "matchBlock" && n.matchExprId !== undefined);
    const arm = outer.cases.find((c: any) => c.type === "matchBlockCase");
    // The nested `const inner = match(...)` must have lowered via lowerAssignment
    // recursion: an inner tagged match, then an assignment of the inner temp,
    // then a matchYield of `inner`.
    const innerMatch = arm.body.find(
      (s: any) => s.type === "matchBlock" && s.matchExprId !== undefined,
    );
    expect(innerMatch).toBeDefined();
    const innerAssign = arm.body.find(
      (s: any) => s.type === "assignment" && s.variableName === "inner",
    );
    expect(innerAssign.matchExprSource.matchId).toBe(innerMatch.matchExprId);
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(y.matchId).toBe(outer.matchExprId);
  });
});

describe("single-expression arm interrupt hoisting (#430)", () => {
  function armStmts(arm: string): any[] {
    const body = lowerBody(`node main(x: any) {
  const val = match(x) {
    ${arm}
    _ => "other"
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    return matchStmt.cases.find((c: any) => c.type === "matchBlockCase").body;
  }

  // Every single-expression arm is hoisted the same way, regardless of what
  // the value is: the whole point is NOT to guess which values can interrupt.
  // The temp binding puts the value at statement position (where codegen emits
  // the interrupt guard); `typeSource` preserves the original expression for
  // typing so literals/narrowing survive; `value` is the temp ref for codegen.
  function expectHoisted(arm: string, valueType: string) {
    const stmts = armStmts(arm);
    const binding = stmts.find((s: any) => s.type === "assignment");
    expect(binding).toBeDefined();
    expect(binding.matchArmValueTemp).toBe(true);
    expect(binding.value.type).toBe(valueType);
    const y = stmts.find((s: any) => s.type === "matchYield");
    expect(y.value.type).toBe("variableName");
    expect(y.value.value).toBe(binding.variableName);
    // The temp binding precedes the yield of that temp.
    expect(stmts.indexOf(binding)).toBeLessThan(stmts.indexOf(y));
    // The yield carries the original expression for the type checker.
    expect(y.typeSource).toEqual(binding.value);
    return { binding, y };
  }

  it("a call arm binds to a temp, then yields the temp", () => {
    const { binding } = expectHoisted(`"a" => confirm()`, "functionCall");
    expect(binding.value.functionName).toBe("confirm");
  });

  it("a literal arm also hoists (uniform lowering, not case-detection)", () => {
    const { y } = expectHoisted(`"a" => 1`, "number");
    expect(y.typeSource).toEqual(
      expect.objectContaining({ type: "number", value: "1" }),
    );
  });

  it("a variable-ref arm also hoists", () => {
    expectHoisted(`"a" => x`, "variableName");
  });

  it("a method-call arm hoists", () => {
    expectHoisted(`"a" => x.run()`, "valueAccess");
  });
});

describe("expression match lowering errors", () => {
  function expectError(src: string, re: RegExp) {
    const parsed = parseAgency(src);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(re);
  }
  const WRAP = (arm: string) => `node main(x: any) {
  const val = match(x) {
    ${arm}
    _ => 2
  }
  return val
}`;

  it("if without else does not yield on all paths", () =>
    expectError(WRAP(`"a" => {\n      if (true) { return 1 }\n    }`), /must return a value/i));
  it("if with non-yielding else errors", () =>
    expectError(WRAP(`"a" => {\n      if (true) { return 1 } else { print("no") }\n    }`), /must return a value/i));
  it("if with both branches yielding passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      if (true) { return 1 } else { return 2 }\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("trailing yield after a non-yielding if passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      if (true) { return 1 }\n      return 2\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("loop-only return does not count (syntactic rule)", () =>
    expectError(WRAP(`"a" => {\n      for (i in x) { return 1 }\n    }`), /must return a value/i));
  it("empty block arm errors", () =>
    expectError(WRAP(`"a" => { }`), /must return a value/i));
  it("assignment is not mistaken for a yield", () =>
    expectError(WRAP(`"a" => {\n      let y = 1\n    }`), /must return a value/i));
  it("bare return errors", () =>
    expectError(WRAP(`"a" => { return }`), /must return a value/i));
  it("return inside parallel in an arm errors", () =>
    expectError(WRAP(`"a" => {\n      parallel {\n        return 1\n      }\n    }`), /parallel|concurrency/i));
  it("thread block without a return inside an expression arm passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      thread {\n        print("hi")\n      }\n      return 2\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("match(x is ...) in expression position errors", () =>
    expectError(`node main(x: any) {\n  const val = match(x is { k }) {\n    _ => 2\n  }\n  return val\n}`, /cannot be used as an expression/i));
});

describe("module-level match expression hoisting", () => {
  it("module-level match hoists to a synthesized function + a call", () => {
    const parsed = parseAgency(`const label = match("a") {
  "a" => "A"
  _ => "other"
}
node main(): string { return label }`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const nodes = parsed.result.nodes as any[];
    // The const now calls a synthesized function instead of holding the match.
    const decl = nodes.find(
      (n) => n.type === "assignment" && n.variableName === "label",
    );
    expect(decl.value.type).toBe("functionCall");
    // A matching synthesized function was added at the top level, with the
    // lowered match region ending in a `return` of the temp, and no declared
    // return type (inferred).
    const synth = nodes.find(
      (n) => n.type === "function" && n.functionName === decl.value.functionName,
    );
    expect(synth).toBeDefined();
    expect(synth.returnType).toBeNull();
    expect(synth.body.some((s: any) => s.type === "returnStatement")).toBe(true);
    // No raw match block is left at module level.
    expect(nodes.some((n) => n.type === "matchBlock")).toBe(false);
  });

  it("module-level match on a `let` also hoists and preserves declKind", () => {
    const parsed = parseAgency(`let label = match("a") {
  "a" => "A"
  _ => "other"
}
node main(): string { return label }`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const decl = (parsed.result.nodes as any[]).find(
      (n) => n.type === "assignment" && n.variableName === "label",
    );
    expect(decl.value.type).toBe("functionCall");
    expect(decl.declKind).toBe("let");
  });

  it("synthesized init function name cannot collide with user identifiers", () => {
    const parsed = parseAgency(`const label = match("a") {
  "a" => "A"
  _ => "other"
}
node main(): string { return label }`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const decl = (parsed.result.nodes as any[]).find(
      (n) => n.type === "assignment" && n.variableName === "label",
    );
    // `$` is not a legal Agency identifier char, so the name is collision-proof
    // against user code, and (not `__`-prefixed) it routes through __call.
    expect(decl.value.functionName).toContain("$");
    expect(decl.value.functionName.startsWith("__")).toBe(false);
  });
});

describe("expression match arm: seq/thread yield to the match", () => {
  const WRAPN = (arm: string) => `node main(x: any) {
  const val = match(x) {
    ${arm}
    _ => 2
  }
  return val
}`;

  function armBodyOf(src: string): any[] {
    const body = lowerBody(src);
    const m = body.find(
      (n: any) => n.type === "matchBlock" && n.matchExprId !== undefined,
    );
    const arm = m.cases.find((c: any) => c.type === "matchBlockCase");
    return arm.body;
  }

  it("standalone seq: return rewrites to a matchYield inside the seq", () => {
    const arm = armBodyOf(WRAPN(`"a" => {\n      seq {\n        return 1\n      }\n    }`));
    const seq = arm.find((s: any) => s.type === "seqBlock");
    expect(seq).toBeDefined();
    const y = seq.body.find((s: any) => s.type === "matchYield");
    expect(y).toBeDefined();
    expect(y.value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    expect(seq.body.some((s: any) => s.type === "returnStatement")).toBe(false);
  });

  it("thread: return rewrites to a matchYield inside the thread", () => {
    const arm = armBodyOf(WRAPN(`"a" => {\n      thread {\n        return 1\n      }\n    }`));
    const th = arm.find((s: any) => s.type === "messageThread");
    expect(th).toBeDefined();
    const y = th.body.find((s: any) => s.type === "matchYield");
    expect(y).toBeDefined();
    expect(y.value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
  });

  it("subthread: return rewrites to a matchYield inside the subthread", () => {
    const arm = armBodyOf(WRAPN(`"a" => {\n      subthread {\n        return 1\n      }\n    }`));
    const th = arm.find((s: any) => s.type === "messageThread");
    expect(th).toBeDefined();
    expect(th.threadType).toBe("subthread");
    expect(th.body.some((s: any) => s.type === "matchYield")).toBe(true);
  });

  it("seq nested inside an if branch yields on that path", () => {
    const parsed = parseAgency(
      WRAPN(`"a" => {\n      if (true) {\n        seq { return 1 }\n      } else {\n        return 2\n      }\n    }`),
    );
    expect(parsed.success).toBe(true);
  });

  it("thread nested in a thread: matchYield lands in the innermost body", () => {
    const arm = armBodyOf(WRAPN(`"a" => {\n      thread {\n        thread {\n          return 1\n        }\n      }\n    }`));
    const outer = arm.find((s: any) => s.type === "messageThread");
    const inner = outer.body.find((s: any) => s.type === "messageThread");
    expect(inner).toBeDefined();
    expect(inner.body.some((s: any) => s.type === "matchYield")).toBe(true);
  });

  it("seq nested in a thread (and vice versa) rewrites the innermost return", () => {
    const st = armBodyOf(WRAPN(`"a" => { thread { seq { return 1 } } }`));
    const seqInThread = st
      .find((s: any) => s.type === "messageThread")
      .body.find((s: any) => s.type === "seqBlock");
    expect(seqInThread.body.some((s: any) => s.type === "matchYield")).toBe(true);

    const ts = armBodyOf(WRAPN(`"a" => { seq { thread { return 1 } } }`));
    const threadInSeq = ts
      .find((s: any) => s.type === "seqBlock")
      .body.find((s: any) => s.type === "messageThread");
    expect(threadInSeq.body.some((s: any) => s.type === "matchYield")).toBe(true);
  });

  it("seq inside a for loop body rewrites the return (loop still needs a trailing yield)", () => {
    const arm = armBodyOf(
      WRAPN(`"a" => {\n      for (i in [1]) {\n        seq { return 1 }\n      }\n      return 2\n    }`),
    );
    const loop = arm.find((s: any) => s.type === "forLoop");
    const seqInLoop = loop.body.find((s: any) => s.type === "seqBlock");
    expect(seqInLoop.body.some((s: any) => s.type === "matchYield")).toBe(true);
  });

  it("a parallel nested inside a standalone seq is still rejected", () => {
    const parsed = parseAgency(
      WRAPN(`"a" => {\n      seq {\n        parallel {\n          return 1\n        }\n      }\n    }`),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(/parallel/i);
  });

  it("a seq arm that does not yield on every path still errors", () => {
    const parsed = parseAgency(WRAPN(`"a" => {\n      seq {\n        print("hi")\n      }\n    }`));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(/must return a value/i);
  });

  it("a seq used as a parallel arm is still rejected (concurrent branch)", () => {
    const parsed = parseAgency(
      WRAPN(`"a" => {\n      parallel {\n        seq { return 1 }\n      }\n    }`),
    );
    // The parallel block does not yield the match, so the arm has no value.
    expect(parsed.success).toBe(false);
  });
});

describe("statement-position return-in-arm errors", () => {
  function expectError(src: string, re: RegExp) {
    const parsed = parseAgency(src);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(re);
  }

  it("single-statement return arm errors with the fixit", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => return "yes"
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("return nested in an if inside a block arm errors", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => {
      if (true) { return "yes" }
      print("hm")
    }
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("bare return in a statement arm errors", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => { return }
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("return hidden in a thread block inside a statement arm errors", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => {
      thread {
        return "escaped"
      }
    }
    _ => print("no")
  }
  return "no"
}`, /thread/i));

  it("thread block without a return inside a statement arm passes", () => {
    const parsed = parseAgency(`def f(x: string): string {
  match(x) {
    "a" => {
      thread {
        print("hi")
      }
    }
    _ => print("no")
  }
  return "no"
}`);
    expect(parsed.success).toBe(true);
  });

  it("return inside a parallel branch in a statement arm stays legal (branch-local result)", () => {
    const parsed = parseAgency(`def f(x: string): string {
  match(x) {
    "a" => {
      parallel {
        return "branch result"
      }
    }
    _ => print("no")
  }
  return "no"
}`);
    expect(parsed.success).toBe(true);
  });

  it("return inside a for loop inside a statement arm errors", () =>
    expectError(`def f(xs: any): string {
  match("k") {
    "k" => {
      for (x in xs) { return "found" }
    }
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("return-free statement arms still parse", () => {
    const parsed = parseAgency(`def f(x: string): string {
  match(x) {
    "a" => print("fine")
    _ => print("also fine")
  }
  return "ok"
}`);
    expect(parsed.success).toBe(true);
  });

  it("boundary: inner EXPRESSION match returns are legal inside an outer statement match arm", () => {
    const parsed = parseAgency(`def f(x: string): string {
  match(x) {
    "a" => {
      const v = match(x) {
        "a" => {
          return "inner-yield"
        }
        _ => "other"
      }
      print(v)
    }
    _ => print("no")
  }
  return "ok"
}`);
    expect(parsed.success).toBe(true);
  });

  it("boundary: statement match nested inside an expression-match arm still errors on ITS arm returns", () =>
    expectError(`node main(x: string) {
  const val = match(x) {
    "a" => {
      match(x) {
        "b" => return "illegal"
        _ => print("ok")
      }
      return "yield"
    }
    _ => "other"
  }
  return val
}`, /return match\(/));

  it("boundary: a `return` inside a `with` handler body of a statement-arm handle parses (handler bodies are opaque)", () => {
    const parsed = parseAgency(`node main() {
  match("go") {
    "go" => {
      handle {
        interrupt("check")
      } with (data) {
        return approve()
      }
    }
    _ => {}
  }
  return "ok"
}`);
    expect(parsed.success).toBe(true);
  });

  it("boundary: a `return` directly in a statement arm (outside the handler) still errors", () =>
    expectError(`node main() {
  match("go") {
    "go" => {
      handle {
        interrupt("check")
      } with (data) {
        return approve()
      }
      return "escapes"
    }
    _ => {}
  }
  return "ok"
}`, /return match\(/));
});

describe("expression match inside a handler body lowers like anywhere else", () => {
  // The builder compiles these to a self-contained async IIFE in the handler's
  // plain-mode codegen (never touching the runner's `_matchExit` flag), so
  // lowering treats them exactly as it would in a normal body.
  function handlerBody(src: string): any[] {
    const parsed = parseAgency(src);
    if (!parsed.success) throw new Error(parsed.message);
    const main: any = parsed.result.nodes.find(
      (n: any) => n.type === "graphNode" || n.type === "function",
    );
    const handle: any = main.body.find((n: any) => n.type === "handleBlock");
    return handle.handler.body;
  }

  it("`const x = match(...)` inside a `with` handler body lowers to temp + consumer", () => {
    const body = handlerBody(`node main() {
  handle {
    interrupt("check")
  } with (data) {
    const x = match("a") {
      "a" => 1
      _ => 2
    }
    return approve()
  }
  return "ok"
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(matchStmt.matchExprId).toBeTypeOf("number");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    expect(arm.body.some((s: any) => s.type === "matchYield")).toBe(true);
    const assign = body.find(
      (n: any) => n.type === "assignment" && n.variableName === "x",
    );
    expect(assign.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
    expect(body.indexOf(matchStmt)).toBeLessThan(body.indexOf(assign));
  });

  it("`return match(...)` inside a `with` handler body lowers to temp + return", () => {
    const body = handlerBody(`node main() {
  handle {
    interrupt("check")
  } with (data) {
    return match("a") {
      "a" => approve()
      _ => propagate()
    }
  }
  return "ok"
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(matchStmt.matchExprId).toBeTypeOf("number");
    const ret = body.find((n: any) => n.type === "returnStatement");
    expect(ret.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
    expect(body.indexOf(matchStmt)).toBeLessThan(body.indexOf(ret));
  });

  it("a `match` in the guarded `handle` body (not the handler) is still allowed", () => {
    const parsed = parseAgency(`node main() {
  handle {
    const x = match("a") {
      "a" => 1
      _ => 2
    }
    print(x)
  } with (data) {
    return approve()
  }
  return "ok"
}`);
    expect(parsed.success).toBe(true);
  });
});
