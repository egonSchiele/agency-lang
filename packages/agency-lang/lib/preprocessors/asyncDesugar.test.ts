import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { generateAgency } from "../backends/agencyGenerator.js";
import { desugarAsyncInProgram } from "./asyncDesugar.js";
import type { AgencyNode, AgencyProgram, GraphNodeDefinition } from "@/types.js";
import type { ParallelBlock } from "@/types/parallelBlock.js";
import { walkNodes } from "@/utils/node.js";

// The async lowering rewrites `async f()` into a `parallel` block. These
// tests run only that pass and print the result back as Agency, so each
// expected shape reads like the program the lowering writes.

const PRELUDE = `def f(n: number): string {
  return "a"
}

node other() {
  print("o")
}
`;

function lower(mainSource: string): { program: AgencyProgram; main: GraphNodeDefinition } {
  const parsed = parseAgency(PRELUDE + mainSource, {}, false);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const program = parsed.result;
  const functionNames = program.nodes.flatMap((node) =>
    node.type === "function" && typeof node.functionName === "string" ? [node.functionName] : [],
  );
  desugarAsyncInProgram(program, functionNames);
  const main = program.nodes.find(
    (node): node is GraphNodeDefinition => node.type === "graphNode" && node.nodeName === "main",
  );
  if (!main) throw new Error("no main node");
  return { program, main };
}

/** The lowered `main` node, printed as Agency. */
function lowered(mainSource: string): string {
  const { program, main } = lower(mainSource);
  return generateAgency({ ...program, nodes: [main] });
}

function parallelBlocks(nodes: AgencyNode[]): ParallelBlock[] {
  return [...walkNodes(nodes)]
    .map(({ node }) => node)
    .filter((node): node is ParallelBlock => node.type === "parallelBlock");
}

describe("snapshotting what the side call reads", () => {
  it("copies a named argument into a temporary before the block, and leaves a literal", () => {
    expect(
      lowered(`node main() {
  let n = 1
  let x = async f(n, 2)
  print("a")
  n = 2
  print(x)
}
`),
    ).toBe(`node main() {
  let n = 1
  const __async_arg_0 = n
  parallel(shared: true) {
    let x = f(__async_arg_0, 2)
    seq {
      print("a")
      n = 2
    }
  }
  print(x)
}
`);
  });

  it("copies the receiver of a method call", () => {
    expect(
      lowered(`node main() {
  const s = "abc"
  let x = async s.toUpperCase()
  print("a")
  print(x)
}
`),
    ).toBe(`node main() {
  const s = "abc"
  const __async_arg_0 = s
  parallel(shared: true) {
    let x = __async_arg_0.toUpperCase()
    seq {
      print("a")
    }
  }
  print(x)
}
`);
  });

  it("copies a callee that is a local holding a function", () => {
    expect(
      lowered(`node main() {
  const g = f
  let x = async g(1)
  print("a")
  print(x)
}
`),
    ).toBe(`node main() {
  const g = f
  const __async_arg_0 = g
  parallel(shared: true) {
    let x = __async_arg_0(1)
    seq {
      print("a")
    }
  }
  print(x)
}
`);
  });

  it("keeps a receiver that is a call in the arm, and copies that call's arguments", () => {
    expect(
      lowered(`node main() {
  const tag = "x"
  let x = async client(tag).toUpperCase()
  print("a")
  print(x)
}
`),
    ).toBe(`node main() {
  const tag = "x"
  const __async_arg_0 = tag
  parallel(shared: true) {
    let x = client(__async_arg_0).toUpperCase()
    seq {
      print("a")
    }
  }
  print(x)
}
`);
  });

  it("copies a callee that is a module-level variable holding a function", () => {
    expect(
      lowered(`const g = f
node main() {
  let x = async g(1)
  print("a")
  print(x)
}
`),
    ).toBe(`node main() {
  const __async_arg_0 = g
  parallel(shared: true) {
    let x = __async_arg_0(1)
    seq {
      print("a")
    }
  }
  print(x)
}
`);
  });

  it("does not copy a known function's name, even when a local elsewhere shares it", () => {
    const out = lowered(`node main() {
  let x = async f(1)
  print("a")
  print(x)
  if (true) {
    const f = 2
    print(f)
  }
}
`);
    expect(out).toContain("    let x = f(1)\n");
    expect(out).not.toContain("__async_arg");
  });
});

describe("the block", () => {
  it("is marked as coming from async and shares globals", () => {
    const { main } = lower(`node main() {
  let x = async f(1)
  print("a")
  print(x)
}
`);
    const [block] = parallelBlocks(main.body);
    expect(block.origin).toBe("async");
    expect(block.shared).toEqual({ type: "boolean", value: true });
  });

  it("clears the async flag on the call it runs", () => {
    const { main } = lower(`node main() {
  let x = async f(1)
  print("a")
  print(x)
}
`);
    const flagged = [...walkNodes(main.body)].filter(
      ({ node }) => (node as { async?: boolean }).async === true,
    );
    expect(flagged).toEqual([]);
  });
});

describe("where the join is", () => {
  it("is just before the first use, when that use is inside a with statement", () => {
    expect(
      lowered(`node main() {
  let x = async f(1)
  print("a")
  print(x) with approve
  print("b")
}
`),
    ).toBe(`node main() {
  parallel(shared: true) {
    let x = f(1)
    seq {
      print("a")
    }
  }
  print(x) with approve
  print("b")
}
`);
  });

  it("is just before the first use, when that use is inside a match", () => {
    expect(
      lowered(`node main() {
  const mode = "a"
  let x = async f(1)
  print("a")
  match (mode) {
    "a" => print(x)
    _ => print("z")
  }
  print("b")
}
`),
    ).toBe(`node main() {
  const mode = "a"
  parallel(shared: true) {
    let x = f(1)
    seq {
      print("a")
    }
  }
  match(mode) {
    "a" => print(x)
    _ => print("z")
  }
  print("b")
}
`);
  });

  it("is just before a top-level goto", () => {
    expect(
      lowered(`node main() {
  async f(1)
  print("a")
  goto other()
}
`),
    ).toBe(`node main() {
  parallel(shared: true) {
    f(1)
    seq {
      print("a")
    }
  }
  goto other()
}
`);
  });

  it("is just before a top-level break, with the statements after it left alone", () => {
    expect(
      lowered(`node main() {
  for (i in [1, 2]) {
    async f(i)
    print(i)
    break
    print("after")
  }
}
`),
    ).toBe(`node main() {
  for (i in [1, 2]) {
    const __async_arg_0 = i
    parallel(shared: true) {
      f(__async_arg_0)
      seq {
        print(i)
      }
    }
    break
    print("after")
  }
}
`);
  });

  it("is just before a top-level continue", () => {
    const out = lowered(`node main() {
  for (i in [1, 2]) {
    async f(i)
    print(i)
    continue
  }
}
`);
    expect(out).toContain(`      seq {
        print(i)
      }
    }
    continue
`);
  });

  it("still forms the block when nothing runs beside the call, so the call stays off the conversation thread", () => {
    expect(
      lowered(`node main() {
  let n = 1
  let x = async f(n)
  print(x)
}
`),
    ).toBe(`node main() {
  let n = 1
  const __async_arg_0 = n
  parallel(shared: true) {
    let x = f(__async_arg_0)
    seq {

    }
  }
  print(x)
}
`);
  });
});

describe("two async calls in one block", () => {
  it("nest first to last: the second runs inside the first one's seq arm", () => {
    expect(
      lowered(`node main() {
  let a = async f(1)
  let b = async f(2)
  print("mid")
  print(a)
  print(b)
}
`),
    ).toBe(`node main() {
  parallel(shared: true) {
    let a = f(1)
    seq {
      parallel(shared: true) {
        let b = f(2)
        seq {
          print("mid")
        }
      }
    }
  }
  print(a)
  print(b)
}
`);
  });
});
