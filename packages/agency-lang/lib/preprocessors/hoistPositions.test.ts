import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { hoistCallsInProgram } from "./hoistCalls.js";
import { desugarGuardsInBody } from "./guardDesugar.js";
import { desugarParallelInBody, resetParallelCounter } from "./parallelDesugar.js";
import { hoistPositions } from "./hoistPositions.js";
import type { AgencyNode, AgencyProgram } from "../types.js";

// One call named `target` per program. The pass lifts it exactly when
// hoistPositions says its position is liftable.
const PROGRAMS: [string, string][] = [
  ["a call argument", "const r = use(target())"],
  ["the left of &&", "const r = target() && a"],
  ["the right of &&", "const r = a && use(target())"],
  ["the right of ||", "const r = a || use(target())"],
  ["the right of ??", "const r = a ?? use(target())"],
  ["the left of catch", "const r = use(target()) catch 0"],
  ["a pipe stage", "const r = a |> use(target())"],
  ["a statement under with", "use(target()) with approve"],
  ["an if statement body", "if (a) {\n    const r = use(target())\n  }"],
  ["a block body the pass reaches", "const r = map(a) as x {\n    return use(target())\n  }"],
  ["a block body under &&", "const r = a && map(b) as x {\n    return use(target())\n  }"],
  ["an argument of a bare method-call statement", "xs.push(target())"],
  ["a bare expression statement", "use(a) + target()"],
  ["a while condition", "while (target()) {\n    step()\n  }"],
  ["an if-expression branch", "const r = if a then use(target()) else 0"],
  ["a statement inside a handle block", "handle {\n    const r = use(target())\n  } with approve"],
  [
    "a handler body",
    "handle {\n    step()\n  } with (intr) {\n    const r = use(target())\n    return approve()\n  }",
  ],
];

// Statements the type checker sees before desugaring, and the pass sees after.
const DESUGARED_FIRST: [string, string][] = [
  [
    "a statement in a guard body",
    "const g = guard(cost: 1) {\n    const r = use(target())\n    return r\n  }",
  ],
  [
    "a statement in a parallel block",
    "parallel {\n    const r = use(target())\n    const q = use(a)\n  }",
  ],
  [
    "a statement in a seq block",
    "parallel {\n    seq {\n      const r = use(target())\n    }\n    const q = use(a)\n  }",
  ],
];

// A top-level initializer is outside every node, so it has its own shape.
const TOP_LEVEL = "const top = use(target())\nnode main() {\n  return top\n}\n";

const isTarget = (node: AgencyNode | undefined): boolean =>
  node?.type === "functionCall" && node.functionName === "target";

/** True when the pass lifted the `target()` call into a `__hoist_N` temp.
 *  Read from the tree rather than printed source: a lowered if-expression
 *  contains a matchYield, which the Agency printer does not print. */
function liftedTarget(program: AgencyProgram): boolean {
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) {
      return node.some(visit);
    }
    if (node === null || typeof node !== "object") {
      return false;
    }
    const record = node as Record<string, unknown>;
    const isTemp =
      record.type === "assignment" &&
      typeof record.variableName === "string" &&
      /^__hoist_\d+$/.test(record.variableName) &&
      isTarget(record.value as AgencyNode);
    return isTemp || Object.entries(record).some(([key, value]) => key !== "loc" && visit(value));
  };
  return visit(program.nodes);
}

function parsed(source: string): AgencyProgram {
  const result = parseAgency(source, {}, false);
  if (!result.success) {
    throw new Error(result.message);
  }
  return result.result;
}

/** The program as the type checker holds it: guards desugared, nothing else. */
const asTheCheckerSeesIt = (program: AgencyProgram): AgencyNode[] =>
  desugarGuardsInBody(program.nodes) as AgencyNode[];

/** The program as the pass meets it in TypescriptPreprocessor.preprocess():
 *  guards desugared, then parallel blocks, in function and node bodies. */
function asThePassSeesIt(program: AgencyProgram): AgencyProgram {
  resetParallelCounter();
  const nodes = (desugarGuardsInBody(program.nodes) as AgencyNode[]).map((node) => {
    if (node.type !== "function" && node.type !== "graphNode") {
      return node;
    }
    return { ...node, body: desugarParallelInBody(node.body) } as AgencyNode;
  });
  return { ...program, nodes } as AgencyProgram;
}

const statusOf = (nodes: AgencyNode[]) =>
  hoistPositions(nodes).find((found) => isTarget(found.node))?.status;

describe("hoistPositions agrees with the hoist pass", () => {
  it.each([...PROGRAMS, ...DESUGARED_FIRST])("%s", (_name, line) => {
    const program = parsed(`node main() {\n  ${line}\n}\n`);
    const status = statusOf(asTheCheckerSeesIt(program));
    expect(status).toBeDefined();

    const lifted = liftedTarget(hoistCallsInProgram(asThePassSeesIt(program)));
    expect(status === "liftable").toBe(lifted);
  });

  // Liftable, and still not lifted: the tail of a statement is its own step.
  it("the tail call of an assignment is liftable and is not lifted", () => {
    const program = parsed("node main() {\n  const r = target()\n}\n");
    expect(statusOf(program.nodes as AgencyNode[])).toBe("liftable");
    expect(liftedTarget(hoistCallsInProgram(program))).toBe(false);
  });

  it("an expression inside a parameter default is outside every body", () => {
    const program = parsed("def f(xs: any = [target()]): any {\n  return xs\n}\n");
    expect(statusOf(program.nodes as AgencyNode[])).toBe("outsideBodies");
    expect(liftedTarget(hoistCallsInProgram(program))).toBe(false);
  });

  it("a module-level initializer is outside every body, and the pass leaves it alone", () => {
    const program = parsed(TOP_LEVEL);
    expect(statusOf(program.nodes as AgencyNode[])).toBe("outsideBodies");
    expect(liftedTarget(hoistCallsInProgram(program))).toBe(false);
  });

  it("a handler body has its own status", () => {
    const program = parsed(
      "node main() {\n  handle {\n    step()\n  } with (intr) {\n    const r = use(target())\n    return approve()\n  }\n}\n",
    );
    expect(statusOf(program.nodes as AgencyNode[])).toBe("handlerBody");
  });

  it("lists each node once", () => {
    const program = parsed("node main() {\n  use(target()) with approve\n}\n");
    const targets = hoistPositions(program.nodes as AgencyNode[]).filter((found) =>
      isTarget(found.node),
    );
    expect(targets).toHaveLength(1);
  });
});
