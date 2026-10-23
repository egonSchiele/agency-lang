import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import type { AgencyProgram } from "../types.js";
import type { FunctionCall, FunctionDefinition, FunctionParameter } from "../types/function.js";
import type { ReturnStatement } from "../types/returnStatement.js";
import {
  decoratorProblems,
  decoratorsAbove,
  desugarDecorators,
  loweredBody,
  type DecoratorLookup,
} from "./decoratorDesugar.js";

function parse(source: string): AgencyProgram {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  return parsed.result;
}

function defNamed(program: AgencyProgram, name: string): FunctionDefinition {
  const found = program.nodes.find(
    (node): node is FunctionDefinition => node.type === "function" && node.functionName === name,
  );
  if (!found) {
    throw new Error(`no def ${name}`);
  }
  return found;
}

function parameter(name: string): FunctionParameter {
  return { type: "functionParameter", name };
}

/** A stub lookup: `withCall` takes the call record, `plain` does not,
 *  `fromAway` is imported. Anything else is unknown. */
const lookup: DecoratorLookup = (name) => {
  if (name === "withCall") {
    return { parameters: [parameter("call"), parameter("block")], imported: false };
  }
  if (name === "plain") {
    return { parameters: [parameter("block")], imported: false };
  }
  if (name === "fromAway") {
    return { parameters: [parameter("block")], imported: true };
  }
  return undefined;
};

function outermostCall(body: ReturnType<typeof loweredBody>): FunctionCall {
  expect(body).toHaveLength(1);
  const statement = body[0] as ReturnStatement;
  expect(statement.type).toBe("returnStatement");
  return statement.value as FunctionCall;
}

describe("decoratorsAbove", () => {
  it("pairs each def with the decorator tags above it, outermost first", () => {
    const program = parse(
      `@a\n@b(1)\ndef f(): string { return "x" }\n@c\ndef g(): string { return "y" }\n`,
    );
    const found = decoratorsAbove(program.nodes);
    expect(found.map((entry) => entry.def.functionName)).toEqual(["f", "g"]);
    expect(found[0].tags.map((tag) => tag.name)).toEqual(["a", "b"]);
  });

  it("leaves reserved tags out and skips undecorated defs", () => {
    const program = parse(
      `@capabilities(terminal)\ndef f(): string { return "x" }\n@validate(positive)\n@logged\ndef g(x: number): number { return x }\n`,
    );
    const found = decoratorsAbove(program.nodes);
    expect(found.map((entry) => entry.def.functionName)).toEqual(["g"]);
    expect(found[0].tags.map((tag) => tag.name)).toEqual(["logged"]);
  });
});

describe("loweredBody", () => {
  it("wraps the body in a call to the decorator with the body as the block", () => {
    const program = parse(`@plain\ndef f(a: number): number { return a }\n`);
    const def = defNamed(program, "f");
    const original = def.body;
    const call = outermostCall(loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup));
    expect(call.functionName).toBe("plain");
    expect(call.arguments).toEqual([]);
    expect(call.block?.body).toBe(original);
    expect(call.decorator).toMatchObject({ name: "plain", target: "f", passesCallRecord: false });
    expect(call.scope).toBeUndefined();
  });

  it("passes the call record first when the decorator's first parameter is call", () => {
    const program = parse(`@withCall(3)\ndef f(a: number, b: string = "x"): number { return a }\n`);
    const def = defNamed(program, "f");
    const call = outermostCall(loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup));
    expect(call.decorator?.passesCallRecord).toBe(true);
    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[0]).toMatchObject({
      type: "agencyObject",
      entries: [
        { key: "name", value: { type: "string", segments: [{ type: "text", value: "f" }] } },
        {
          key: "args",
          value: {
            type: "agencyObject",
            entries: [
              { key: "a", value: { type: "variableName", value: "a" } },
              { key: "b", value: { type: "variableName", value: "b" } },
            ],
          },
        },
      ],
    });
    expect(call.arguments[1]).toMatchObject({ type: "number" });
  });

  it("leaves a block-typed parameter out of the call record", () => {
    const program = parse(
      `@withCall\ndef each(xs: number[], block: (number) -> number): number[] { return xs }\n`,
    );
    const def = defNamed(program, "each");
    const call = outermostCall(loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup));
    const record = call.arguments[0] as {
      entries: { key: string; value: { entries: unknown[] } }[];
    };
    expect(record.entries[1].value.entries).toHaveLength(1);
  });

  it("nests stacked decorators outermost first", () => {
    const program = parse(`@plain\n@fromAway(cost: 2)\ndef f(): string { return "x" }\n`);
    const def = defNamed(program, "f");
    const original = def.body;
    const outer = outermostCall(loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup));
    expect(outer.functionName).toBe("plain");
    const inner = outermostCall(outer.block?.body ?? []);
    expect(inner.functionName).toBe("fromAway");
    expect(inner.scope).toBe("imported");
    expect(inner.arguments[0]).toMatchObject({ type: "namedArgument", name: "cost" });
    expect(inner.block?.body).toBe(original);
  });

  it("does not write to the def", () => {
    const program = parse(`@plain\ndef f(): string { return "x" }\n`);
    const def = defNamed(program, "f");
    const before = JSON.stringify(def);
    loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup);
    expect(JSON.stringify(def)).toBe(before);
  });
});

describe("desugarDecorators", () => {
  it("moves the tags onto def.decorators and out of the program", () => {
    const program = parse(`@plain\ndef f(): string { return "x" }\n`);
    desugarDecorators(program, lookup);
    expect(program.nodes.filter((node) => node.type === "tag")).toHaveLength(0);
    const def = defNamed(program, "f");
    expect(def.decorators?.map((tag) => tag.name)).toEqual(["plain"]);
    expect(def.tags).toBeUndefined();
    expect(outermostCall(def.body).functionName).toBe("plain");
  });

  it("keeps reserved tags, in order, on def.tags", () => {
    const program = parse(
      `@validate(positive)\n@plain\n@hidden\n@fromAway\n@capabilities(terminal)\ndef f(x: number): number { return x }\n`,
    );
    // The preprocessor attaches tags before lowering; do the same here.
    const def = defNamed(program, "f");
    def.tags = program.nodes.filter((node) => node.type === "tag");
    program.nodes = program.nodes.filter((node) => node.type !== "tag");
    desugarDecorators(program, lookup);
    expect(def.tags?.map((tag) => tag.name)).toEqual(["validate", "hidden", "capabilities"]);
    expect(def.decorators?.map((tag) => tag.name)).toEqual(["plain", "fromAway"]);
  });

  it("is idempotent", () => {
    const program = parse(`@plain\n@withCall(2)\ndef f(a: number): number { return a }\n`);
    desugarDecorators(program, lookup);
    const once = JSON.stringify(program);
    desugarDecorators(program, lookup);
    expect(JSON.stringify(program)).toBe(once);
  });

  it("leaves a decorator tag on a node alone", () => {
    const program = parse(`@plain\nnode main() { return "x" }\n`);
    desugarDecorators(program, lookup);
    expect(program.nodes.filter((node) => node.type === "tag")).toHaveLength(1);
  });
});

describe("decoratorProblems", () => {
  const scope = {
    functionDefinitions: {},
    importedFunctions: { plain: { parameters: [parameter("block")], returnType: null } },
  };

  it("reports nothing for a program whose decorators resolve", () => {
    const program = parse(`@plain\ndef f(): string { return "x" }\n`);
    expect(decoratorProblems(program, scope)).toEqual([]);
  });

  it("names an unknown decorator and the def it is on", () => {
    const program = parse(`@budgted(cost: 1)\ndef f(): string { return "x" }\n`);
    const problems = decoratorProblems(program, scope);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("Unknown decorator 'budgted' on 'f'");
    expect(problems[0].loc).toEqual(program.nodes[0].loc);
  });

  it("still finds the unknown decorator after the lowering ran", () => {
    const program = parse(`@budgted\ndef f(): string { return "x" }\n`);
    desugarDecorators(program, lookup);
    expect(decoratorProblems(program, scope).map((problem) => problem.message)).toEqual([
      expect.stringContaining("Unknown decorator 'budgted'"),
    ]);
  });

  it("refuses a decorator on a node, a type, and a statement, and a stranded one", () => {
    const program = parse(
      `@plain\nnode main() { return "x" }\n@plain\ntype Foo = { a: number }\ndef g(): string {\n  @plain\n  return "y"\n}\n@plain\n`,
    );
    const messages = decoratorProblems(program, scope).map((problem) => problem.message);
    expect(messages).toEqual([
      "'@plain' is written on node 'main', but a decorator goes on a def.",
      "'@plain' is written on type 'Foo', but a decorator goes on a def.",
      "'@plain' is written on a statement, but a decorator goes on a def.",
      "'@plain' is written on nothing, but a decorator goes on a def.",
    ]);
  });

  it("refuses a def that decorates itself", () => {
    const program = parse(`@retry\ndef retry(block: () -> any): any { return block() }\n`);
    const withRetry = { ...scope, functionDefinitions: { retry: defNamed(program, "retry") } };
    expect(decoratorProblems(program, withRetry).map((problem) => problem.message)).toEqual([
      "'retry' cannot decorate itself.",
    ]);
  });

  it("refuses defs that decorate each other, naming the loop", () => {
    const program = parse(
      `@b\ndef a(block: () -> any): any { return block() }\n@a\ndef b(block: () -> any): any { return block() }\n`,
    );
    const both = {
      ...scope,
      functionDefinitions: { a: defNamed(program, "a"), b: defNamed(program, "b") },
    };
    expect(decoratorProblems(program, both).map((problem) => problem.message)).toEqual([
      expect.stringContaining("a loop: a → b → a."),
      expect.stringContaining("a loop: b → a → b."),
    ]);
  });

  it("allows a chain of decorators that does not loop back", () => {
    const program = parse(
      `@plain\ndef a(block: () -> any): any { return block() }\n@a\ndef b(): string { return "x" }\n`,
    );
    const chain = {
      ...scope,
      functionDefinitions: { a: defNamed(program, "a"), b: defNamed(program, "b") },
    };
    expect(decoratorProblems(program, chain)).toEqual([]);
  });

  it("refuses a decorator imported from JavaScript", () => {
    const program = parse(
      `import { wrap } from "./wrap.js"\n@wrap\ndef f(): string { return "x" }\n`,
    );
    expect(decoratorProblems(program, scope).map((problem) => problem.message)).toEqual([
      expect.stringContaining("'wrap' is imported from JavaScript, so it cannot decorate 'f'."),
    ]);
  });

  it("refuses a decorator whose last parameter cannot take a block", () => {
    const program = parse(
      `def tagged(label: string): string { return label }\n@tagged("x")\ndef f(): string { return "x" }\n`,
    );
    const withTagged = { ...scope, functionDefinitions: { tagged: defNamed(program, "tagged") } };
    expect(decoratorProblems(program, withTagged).map((problem) => problem.message)).toEqual([
      expect.stringContaining("'tagged' cannot decorate 'f': a decorator receives the body"),
    ]);
  });

  it("accepts a last parameter typed any or left untyped, as the type checker does", () => {
    const program = parse(
      `def loose(block: any): any { return block() }\ndef bare(block): any { return block() }\n@loose\n@bare\ndef f(): string { return "x" }\n`,
    );
    const both = {
      ...scope,
      functionDefinitions: { loose: defNamed(program, "loose"), bare: defNamed(program, "bare") },
    };
    expect(decoratorProblems(program, both)).toEqual([]);
  });

  it("ignores reserved tags wherever they are", () => {
    const program = parse(`@capabilities(terminal)\nnode main() { return "x" }\n`);
    expect(decoratorProblems(program, scope)).toEqual([]);
  });
});
