import { describe, it, expect, beforeEach } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "../backends/typescriptGenerator.js";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import {
  desugarParallelInBody,
  validateParallelBlock,
  collectBindings,
  collectReferences,
  resetParallelCounter,
} from "./parallelDesugar.js";
import { ParallelBlock } from "@/types/parallelBlock.js";
import { AgencyNode, AgencyProgram, GraphNodeDefinition } from "@/types.js";
import { generateAgency } from "../backends/agencyGenerator.js";
import { desugarAsyncInProgram } from "./asyncDesugar.js";

function parse(src: string): AgencyProgram {
  const result = parseAgency(src);
  if (!result.success) {
    throw new Error(`parse failed: ${result.message ?? "unknown"}\n${result.rest}`);
  }
  return result.result;
}

function getMainBody(src: string): AgencyNode[] {
  const program = parse(src);
  const main = program.nodes.find(
    (n): n is GraphNodeDefinition => n.type === "graphNode" && n.nodeName === "main",
  );
  if (!main) throw new Error("no `main` node found in test source");
  return main.body;
}

function findParallelBlock(body: AgencyNode[]): ParallelBlock {
  const pb = body.find((n) => n.type === "parallelBlock") as ParallelBlock | undefined;
  if (!pb) throw new Error("no parallel block found in body");
  return pb;
}

describe("collectBindings", () => {
  it("collects let/const declarations in a flat body", () => {
    const body = getMainBody(`
      node main() {
        let a = 1
        let b = 2
      }
    `);
    const binds = new Set<string>();
    for (const n of body) {
      for (const name of collectBindings(n)) binds.add(name);
    }
    expect(binds).toEqual(new Set(["a", "b"]));
  });

  it("descends into seq and parallel blocks", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          let a = foo()
          seq {
            let b = bar()
            let c = baz(b)
          }
        }
      }
    `);
    const pb = findParallelBlock(body);
    const binds = collectBindings(pb);
    expect(binds).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("collectReferences", () => {
  it("collects variable refs and function-name refs", () => {
    const body = getMainBody(`
      node main() {
        let r = foo(x)
      }
    `);
    const refs = collectReferences(body[0]);
    expect(refs.has("foo")).toBe(true);
    expect(refs.has("x")).toBe(true);
    // An assignment target counts too: a name is mentioned whether it is
    // read or written. The cross-arm check subtracts the arm's own bindings.
    expect(refs.has("r")).toBe(true);
  });

  it("finds a name inside a with statement, a match arm, and a cast", () => {
    const body = getMainBody(`
      node main() {
        print(a) with approve
        match (mode) {
          "x" => print(b)
          _ => print(1)
        }
        const n = c as number
      }
    `);
    const refs = new Set(body.flatMap((node) => [...collectReferences(node)]));
    expect(refs.has("a")).toBe(true);
    expect(refs.has("b")).toBe(true);
    expect(refs.has("c")).toBe(true);
  });
});

describe("validateParallelBlock", () => {
  it("accepts a valid two-arm parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          let a = foo()
          let b = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).not.toThrow();
  });

  it("accepts a `destructive { }` region as a direct parallel arm", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          destructive { rm() }
          let b = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).not.toThrow();
  });

  it("accepts a `destructive { }` region nested inside a `seq` arm", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          seq {
            destructive { rm() }
          }
          let b = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).not.toThrow();
  });

  it("rejects cross-arm references", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          let x = foo()
          let y = bar(x)
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /Parallel arm references `x`, which is declared by a sibling arm/,
    );
  });

  it("does NOT flag references to outer-scope bindings", () => {
    const body = getMainBody(`
      node main() {
        let id = "abc"
        parallel {
          let a = fetchA(id)
          let b = fetchB(id)
        }
      }
    `);
    const pb = findParallelBlock(body);
    expect(() => validateParallelBlock(pb)).not.toThrow();
  });

  it("does NOT flag refs within a single seq arm", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          let a = foo()
          seq {
            let b = bar()
            let c = baz(b)
          }
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).not.toThrow();
  });

  it("rejects `if` at the top level of a parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          if (cond) {
            foo()
          }
          bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /not allowed at the top level of a `parallel` block/,
    );
  });

  it("rejects `for` at the top level of a parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          for (x in xs) {
            foo(x)
          }
          bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /not allowed at the top level of a `parallel` block/,
    );
  });

  it("rejects `while` at the top level of a parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          while (cond) {
            foo()
          }
          bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /not allowed at the top level of a `parallel` block/,
    );
  });

  it("rejects reassignment (no declKind) at the top level", () => {
    const body = getMainBody(`
      node main() {
        let x = 0
        parallel {
          x = 1
          let y = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /Reassignment to `x` is not allowed at the top level of a `parallel` block/,
    );
  });

  it("rejects `return` at the top level of a parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          return 1
          let y = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /not allowed at the top level of a `parallel` block/,
    );
  });

  it("rejects `break` at the top level of a parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          break
          let y = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /not allowed at the top level of a `parallel` block/,
    );
  });

  it("rejects `continue` at the top level of a parallel block", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          continue
          let y = bar()
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /not allowed at the top level of a `parallel` block/,
    );
  });
});

describe("desugarParallelInBody", () => {
  beforeEach(() => resetParallelCounter());

  it("rewrites a parallel block into a fork-let plus destructuring lets", () => {
    const src = `
      def foo(): string { return "f" }
      def bar(): string { return "b" }
      node main() {
        parallel {
          let a = foo()
          let b = bar()
        }
        return "${"${a},${b}"}"
      }
    `;
    const program = parse(src);
    // Run only the parallel desugar (skip other preprocessor passes for unit-test focus).
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);

    // First statement should be `let __arms_0 = fork(...)`.
    const first = main.body[0] as any;
    expect(first.type).toBe("assignment");
    expect(first.declKind).toBe("let");
    expect(first.variableName).toBe("__arms_0");
    expect(first.value.type).toBe("functionCall");
    expect(first.value.functionName).toBe("fork");

    // Two destructuring lets follow.
    const second = main.body[1] as any;
    expect(second.type).toBe("assignment");
    expect(second.variableName).toBe("a");
    expect(second.value.type).toBe("valueAccess");

    const third = main.body[2] as any;
    expect(third.variableName).toBe("b");
  });

  /** The statements of arm `index` after desugaring: the body of the
   *  `if (__arm == "arm_<index>")` branch inside the fork's block. */
  function armBody(main: GraphNodeDefinition, index: number): AgencyNode[] {
    const forkAssign = main.body[0] as any;
    const branch = forkAssign.value.block.body[index];
    expect(branch.type).toBe("ifElse");
    return branch.thenBody;
  }

  it("keeps the flip of a `destructive { }` region written directly as an arm", () => {
    const src = `
      def rm(): string { return "r" }
      node main() {
        parallel {
          destructive { rm() }
          let b = rm()
        }
      }
    `;
    const program = parse(src);
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);
    const first = armBody(main, 0);
    expect(first[0].type).toBe("markDestructiveRan");
    expect(first[1].type).toBe("functionCall");
    const second = armBody(main, 1);
    expect(second.some((n) => n.type === "markDestructiveRan")).toBe(false);
  });

  it("keeps the flip of a `destructive { }` region nested in a `seq` arm", () => {
    const src = `
      def rm(): string { return "r" }
      node main() {
        parallel {
          seq {
            let a = rm()
            destructive { rm() }
          }
        }
      }
    `;
    const program = parse(src);
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);
    const stmts = armBody(main, 0);
    expect(stmts[0].type).toBe("assignment");
    expect(stmts[1].type).toBe("markDestructiveRan");
  });

  it("inlines a seq block at the top level of a body", () => {
    const src = `
      def foo(): string { return "f" }
      node main() {
        seq {
          let a = foo()
          let b = a
        }
      }
    `;
    const program = parse(src);
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);

    // The seq's body (two assignments) should be present at the top level
    // — no seqBlock node remaining.
    expect(main.body.find((n) => n.type === "seqBlock")).toBeUndefined();
    const lets = main.body.filter((n) => n.type === "assignment") as any[];
    expect(lets).toHaveLength(2);
    expect(lets[0].variableName).toBe("a");
    expect(lets[1].variableName).toBe("b");
  });

  it("uses fresh suffixes for nested parallel blocks", () => {
    const src = `
      def f(): string { return "x" }
      node main() {
        parallel {
          let a = f()
          parallel {
            let b = f()
            let c = f()
          }
        }
      }
    `;
    const program = parse(src);
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);

    // Outer __arms variable is at index 0 of main.body.
    const outer = main.body[0] as any;
    expect(outer.variableName).toBe("__arms_0");

    // Inner __arms variable is somewhere inside the outer fork's if-chain.
    // Walk to find a `__arms_1` declaration.
    function findArmsVar(node: any, depth = 0): string[] {
      if (!node || depth > 20) return [];
      const results: string[] = [];
      if (
        node.type === "assignment" &&
        typeof node.variableName === "string" &&
        node.variableName.startsWith("__arms_")
      ) {
        results.push(node.variableName);
      }
      for (const key of Object.keys(node)) {
        const v = (node as any)[key];
        if (Array.isArray(v)) for (const item of v) results.push(...findArmsVar(item, depth + 1));
        else if (v && typeof v === "object") results.push(...findArmsVar(v, depth + 1));
      }
      return results;
    }
    const allArmsVars = findArmsVar(outer);
    // Should include both "__arms_0" (the outer) and "__arms_1" (the inner).
    expect(allArmsVars).toContain("__arms_0");
    expect(allArmsVars).toContain("__arms_1");
  });
});

describe("end-to-end through TypescriptPreprocessor", () => {
  beforeEach(() => resetParallelCounter());

  it("preprocesses a parallel block without throwing", () => {
    const src = `
      def foo(): string { return "f" }
      def bar(): string { return "b" }
      node main() {
        parallel {
          let a = foo()
          let b = bar()
        }
        return "${"${a},${b}"}"
      }
    `;
    const program = parse(src);
    const pp = new TypescriptPreprocessor(program);
    expect(() => pp.preprocess()).not.toThrow();
  });

  it("propagates the cross-arm error through the full pipeline", () => {
    const src = `
      def foo(): string { return "f" }
      def bar(s: string): string { return "b-${"${s}"}" }
      node main() {
        parallel {
          let x = foo()
          let y = bar(x)
        }
      }
    `;
    const program = parse(src);
    const pp = new TypescriptPreprocessor(program);
    expect(() => pp.preprocess()).toThrow(
      /Parallel arm references `x`, which is declared by a sibling arm/,
    );
  });
});

describe("desugar → codegen snapshot", () => {
  beforeEach(() => resetParallelCounter());

  // This snapshot captures the contract of the preprocessor + codegen pipeline
  // for parallel/seq blocks. It exists to catch unintended regressions in:
  //   - the desugar shape (fork over arm name strings, if-chain dispatch,
  //     binding return objects, post-fork destructuring),
  //   - the existing fork lowering's handling of branch-divergent bodies,
  //   - upstream codegen changes that affect how let/fork/return are emitted.
  // If the assertions below fail, that means one of those layers changed
  // shape — either intentionally (update the snapshot) or accidentally.
  it("emits fork+if-chain shape for a parallel block with seq arm", () => {
    const src = `
      def foo(): string { return "f" }
      def bar(): string { return "b" }
      def baz(s: string): string { return s }
      node main() {
        parallel {
          let a = foo()
          seq {
            let b = bar()
            let c = baz(b)
          }
        }
        return "done"
      }
    `;
    const result = parseAgency(src, {}, false);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const ts = generateTypeScript(result.result, undefined, undefined, "snapshot.agency");

    // Structural assertions — looser than a full snapshot file but specific
    // enough to catch regressions in any layer. Codegen uses backtick
    // template literals for string args, so arm names show up as `arm_N`.
    // 1. The preprocessor introduced an __arms_0 binding fed by a fork call
    //    over the arm name strings.
    expect(ts).toMatch(/runner\d*\.fork\(\s*\d+\s*,\s*__run\s*,\s*\[\s*`arm_0`\s*,\s*`arm_1`\s*\]/);
    // 2. Each arm is dispatched by a string-equality check on the arm param.
    //    Equality lowers to the __eq runtime helper (nullish unification).
    expect(ts).toMatch(/__eq\(\s*[^,]*__arm_0\s*,\s*`arm_0`\s*\)/);
    expect(ts).toMatch(/__eq\(\s*[^,]*__arm_0\s*,\s*`arm_1`\s*\)/);
    // 3. Bindings (a from arm 0, b and c from the seq arm) are hoisted and
    //    assigned from __arms_0 indexed access.
    expect(ts).toMatch(/__arms_0\[0\]\.a/);
    expect(ts).toMatch(/__arms_0\[1\]\.b/);
    expect(ts).toMatch(/__arms_0\[1\]\.c/);
    // 4. parallelBlock and seqBlock should have no representation in the
    //    generated TS — they're pure preprocessor sugar.
    expect(ts).not.toMatch(/parallelBlock|seqBlock/);
  });
});

describe("with statements in seq arms", () => {
  beforeEach(() => resetParallelCounter());

  it("refuses a seq arm that reads a sibling's binding inside a with statement", () => {
    // The reference sits inside `print(x) with approve`. Before the walk
    // reached with statements this compiled and printed `undefined`.
    const body = getMainBody(`
      node main() {
        parallel {
          let x = foo()
          seq {
            print(x) with approve
          }
        }
      }
    `);
    expect(() => validateParallelBlock(findParallelBlock(body))).toThrow(
      /Parallel arm references `x`, which is declared by a sibling arm/,
    );
  });

  it("hoists a binding declared by `let x = f() with approve` in a seq arm", () => {
    const src = `
      def foo(): string { return "f" }
      def bar(): string { return "b" }
      node main() {
        parallel {
          let a = foo()
          seq {
            let x = bar() with approve
          }
        }
        print(x)
      }
    `;
    const program = parse(src);
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);
    expect(generateAgency({ ...program, nodes: [main] })).toContain(
      "  let a = __arms_0[0].a\n  let x = __arms_0[1].x\n  print(x)\n",
    );
  });
});

describe("a parallel block from the async lowering", () => {
  beforeEach(() => resetParallelCounter());

  function lowerAsync(): { program: AgencyProgram; main: GraphNodeDefinition } {
    const program = parse(`
      def f(n: number): string { return "a" }
      node main() {
        let x = async f(1)
        let y = f(2)
        print(x)
      }
    `);
    desugarAsyncInProgram(program, ["f"]);
    const main = program.nodes.find(
      (n) => n.type === "graphNode" && n.nodeName === "main",
    ) as GraphNodeDefinition;
    main.body = desugarParallelInBody(main.body);
    return { program, main };
  }

  it("gives the fork mainThread 1, so arm 1 keeps the conversation thread", () => {
    const { main } = lowerAsync();
    const forkAssign = main.body[0] as any;
    expect(forkAssign.value.functionName).toBe("fork");
    expect(forkAssign.value.mainThread).toBe(1);
  });

  it("marks arm 1's completion and checks it between the fork and the hoists", () => {
    const { program, main } = lowerAsync();
    expect(generateAgency({ ...program, nodes: [main] })).toBe(`node main() {
  let __arms_0 = fork(["arm_0", "arm_1"], shared: true) as __arm_0 {
    if (__arm_0 == "arm_0") {
      let x = f(1)
      return {
        x: x
      }
    }
    if (__arm_0 == "arm_1") {
      let y = f(2)
      return __asyncDone({
        y: y
      })
    }
  }
  if (!__asyncFinished(__arms_0[1])) {
    return __arms_0[1]
  }
  let x = __arms_0[0].x
  let y = __arms_0[1].y
  print(x)
}
`);
  });

  it("leaves a hand-written parallel block without mainThread or the join check", () => {
    const body = getMainBody(`
      node main() {
        parallel {
          let a = foo()
          let b = bar()
        }
      }
    `);
    const out = desugarParallelInBody(body);
    const forkAssign = out[0] as any;
    expect(forkAssign.value.mainThread).toBeUndefined();
    const names = out.flatMap((node) => [...collectReferences(node)]);
    expect(names).not.toContain("__asyncDone");
    expect(names).not.toContain("__asyncFinished");
  });
});
