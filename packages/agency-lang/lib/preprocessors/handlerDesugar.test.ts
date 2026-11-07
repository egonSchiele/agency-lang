import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import type { AgencyProgram } from "../types.js";
import type { HandleBlock } from "../types/handleBlock.js";
import { walkNodesArray } from "../utils/node.js";
import { desugarHandlerFunctionsInProgram, handlerFunctionBlock } from "./handlerDesugar.js";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";

function parse(source: string): AgencyProgram {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
  return parsed.result as AgencyProgram;
}

function handleBlocks(program: AgencyProgram): HandleBlock[] {
  return walkNodesArray(program.nodes)
    .map(({ node }) => node)
    .filter((node): node is HandleBlock => node.type === "handleBlock");
}

const ONE_HANDLER = `node main() {
  handle {
    f()
  } with (intr: any) {
    const a = 1
    return approve()
  }
}`;

describe("desugarHandlerFunctionsInProgram", () => {
  it("lowers an inline handler function to one block argument", () => {
    const program = parse(ONE_HANDLER);
    const [block] = handleBlocks(program);
    if (block.handler.kind !== "inline") throw new Error("expected an inline handler");
    const original = [...block.handler.body];
    const param = block.handler.param;

    desugarHandlerFunctionsInProgram(program);

    expect(block.handler.kind).toBe("inline");
    expect(block.handler.param.name).toBe("intr");
    expect(block.handler.body).toHaveLength(1);
    const lowered = block.handler.body[0];
    expect(lowered.type).toBe("blockArgument");
    if (lowered.type !== "blockArgument") return;
    expect(lowered.params).toHaveLength(1);
    expect(lowered.params[0]).toBe(param);
    expect(lowered.params[0].typeHint).toBeDefined();
    expect(lowered.body).toHaveLength(original.length);
    original.forEach((stmt, i) => expect(lowered.body[i]).toBe(stmt));
    expect(lowered.loc).toEqual(original[0].loc);
  });

  it("takes the handle block's loc when the handler function is empty", () => {
    const program = parse(`node main() {
  handle {
    f()
  } with (intr) {
  }
}`);
    const [block] = handleBlocks(program);
    desugarHandlerFunctionsInProgram(program);
    const lowered = handlerFunctionBlock(block.handler);
    expect(lowered).toBeDefined();
    expect(lowered?.body).toHaveLength(0);
    expect(lowered?.loc).toEqual(block.loc);
  });

  it("runs twice without change", () => {
    const program = parse(ONE_HANDLER);
    desugarHandlerFunctionsInProgram(program);
    const once = JSON.stringify(program);
    desugarHandlerFunctionsInProgram(program);
    expect(JSON.stringify(program)).toBe(once);
    const [block] = handleBlocks(program);
    expect(block.handler.kind).toBe("inline");
    if (block.handler.kind === "inline") {
      expect(block.handler.body).toHaveLength(1);
    }
  });

  it("leaves a function reference alone", () => {
    const program = parse(`def myHandler(intr: any) {
  return approve()
}
node main() {
  handle {
    f()
  } with myHandler
}`);
    const before = JSON.stringify(program);
    desugarHandlerFunctionsInProgram(program);
    expect(JSON.stringify(program)).toBe(before);
    const [block] = handleBlocks(program);
    expect(block.handler.kind).toBe("functionRef");
  });

  it("lowers a handler function in every nested position", () => {
    const program = parse(`node main() {
  handle {
    f()
  } with (outer) {
    handle {
      g()
    } with (inner) {
      return approve()
    }
    return approve()
  }
  const xs = map([1]) as x {
    handle {
      f()
    } with (a) {
      return approve()
    }
    return x
  }
  for (k in [1]) {
    handle {
      f()
    } with (b) {
      return approve()
    }
  }
  if (true) {
    handle {
      f()
    } with (c) {
      return approve()
    }
  }
  match (1) {
    1 => {
      handle {
        f()
      } with (d) {
        return approve()
      }
    }
    _ => {
      print("none")
    }
  }
}`);
    desugarHandlerFunctionsInProgram(program);
    const blocks = handleBlocks(program);
    expect(blocks).toHaveLength(6);
    for (const block of blocks) {
      expect(block.handler.kind).toBe("inline");
      expect(handlerFunctionBlock(block.handler)).toBeDefined();
    }
  });

  it("handlerFunctionBlock tells a lowered handler from the rest", () => {
    const program = parse(`def myHandler(intr: any) {
  return approve()
}
node main() {
  handle {
    f()
  } with myHandler
  handle {
    f()
  } with (intr) {
    return approve()
  }
}`);
    const [byName, inline] = handleBlocks(program);
    expect(handlerFunctionBlock(byName.handler)).toBeUndefined();
    expect(handlerFunctionBlock(inline.handler)).toBeUndefined();
    desugarHandlerFunctionsInProgram(program);
    expect(handlerFunctionBlock(byName.handler)).toBeUndefined();
    expect(handlerFunctionBlock(inline.handler)?.type).toBe("blockArgument");
  });

  it("gives the handler parameter block-parameter scope and a handler local block scope", () => {
    const program = parse(`node main() {
  let out = ""
  handle {
    out = f()
  } with (intr) {
    const seen = g(intr.data.n)
    out = seen
    return approve()
  }
}`);
    new TypescriptPreprocessor(program).preprocess();
    const [block] = handleBlocks(program);
    const lowered = handlerFunctionBlock(block.handler);
    expect(lowered).toBeDefined();
    if (!lowered) return;
    const inside = walkNodesArray(lowered.body).map(({ node }) => node);
    const intrRead = inside.find((n) => n.type === "variableName" && n.value === "intr");
    expect(intrRead?.type === "variableName" && intrRead.scope).toBe("blockArgs");
    const seenDecl = inside.find((n) => n.type === "assignment" && n.variableName === "seen");
    expect(seenDecl?.type === "assignment" && seenDecl.scope).toBe("block");
    const outWrite = inside.find((n) => n.type === "assignment" && n.variableName === "out");
    expect(outWrite?.type === "assignment" && outWrite.scope).toBe("local");
  });
});
