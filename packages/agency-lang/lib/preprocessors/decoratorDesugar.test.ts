import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import type { AgencyProgram, Assignment } from "../types.js";
import type { FunctionCall, FunctionDefinition, FunctionParameter } from "../types/function.js";
import type { ReturnStatement } from "../types/returnStatement.js";
import {
  decoratorLookup,
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

/** A stub lookup: `withCall` takes one argument of its own before `call`
 *  and the block, `plain` takes only those two, `fromAway` is imported.
 *  Anything else is unknown. */
const lookup: DecoratorLookup = (name) => {
  if (name === "withCall") {
    return {
      parameters: [parameter("times"), parameter("call"), parameter("block")],
      imported: false,
      decorator: true,
    };
  }
  if (name === "plain") {
    return {
      parameters: [parameter("call"), parameter("block")],
      imported: false,
      decorator: true,
    };
  }
  if (name === "fromAway") {
    return { parameters: [parameter("call"), parameter("block")], imported: true, decorator: true };
  }
  if (name === "named") {
    return { parameters: [parameter("ctx"), parameter("body")], imported: false, decorator: true };
  }
  return undefined;
};

/** A lowered def body: the outermost decorator's record in its own const,
 *  then one `return` of the call. */
function outermostCall(body: ReturnType<typeof loweredBody>): FunctionCall {
  expect(body).toHaveLength(2);
  expect(body[0]).toMatchObject({
    type: "assignment",
    declKind: "const",
    variableName: "__call_0",
  });
  const statement = body[1] as ReturnStatement;
  expect(statement.type).toBe("returnStatement");
  return statement.value as FunctionCall;
}

/** The call inside a lowered block: the block starts with the rebind, then
 *  the next decorator's record, then its call. */
function innerCall(body: ReturnType<typeof loweredBody>): FunctionCall {
  expect(body).toHaveLength(3);
  expect(body[0].type).toBe("rebindParameters");
  expect(body[1]).toMatchObject({
    type: "assignment",
    declKind: "const",
    variableName: "__call_1",
  });
  const statement = body[2] as ReturnStatement;
  expect(statement.type).toBe("returnStatement");
  return statement.value as FunctionCall;
}

/** The `call:` record a lowered call passes last: the call names the const
 *  declared beside it, and this returns that const's value. */
function callRecordOf(
  body: ReturnType<typeof loweredBody>,
  call: FunctionCall,
): { entries: { key: string; value: unknown }[] } {
  const last = call.arguments[call.arguments.length - 1] as {
    type: string;
    name: string;
    value: { type: string; value: string };
  };
  expect(last).toMatchObject({ type: "namedArgument", name: "call" });
  expect(last.value).toMatchObject({ type: "variableName" });
  const declaration = body.find(
    (node) => node.type === "assignment" && (node as Assignment).variableName === last.value.value,
  ) as Assignment | undefined;
  expect(declaration).toBeDefined();
  return declaration!.value as { entries: { key: string; value: unknown }[] };
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
    const body = loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup);
    const call = outermostCall(body);
    expect(call.functionName).toBe("plain");
    expect(call.arguments).toHaveLength(1);
    expect(callRecordOf(body, call).entries[0]).toMatchObject({ key: "name" });
    // The block takes the record, starts with the rebind, and then runs the
    // body's own statements.
    expect(call.block?.params.map((param) => param.name)).toEqual(["__args"]);
    expect(call.block?.body[0]).toMatchObject({
      type: "rebindParameters",
      functionName: "f",
      blockParameters: [],
      record: "__args",
      parameters: [{ name: "a" }],
    });
    expect(call.block?.body.slice(1)).toEqual(original);
    expect(call.block?.body[1]).toBe(original[0]);
    expect(call.decorator).toMatchObject({ name: "plain", target: "f" });
    expect(call.scope).toBeUndefined();
  });

  it("passes the tag's arguments first and the call record by name after them", () => {
    const program = parse(`@withCall(3)\ndef f(a: number, b: string = "x"): number { return a }\n`);
    const def = defNamed(program, "f");
    const body = loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup);
    const call = outermostCall(body);
    expect(call.arguments).toHaveLength(2);
    expect(call.arguments[0]).toMatchObject({ type: "number" });
    expect(callRecordOf(body, call)).toMatchObject({
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
  });

  it("leaves a block-typed parameter out of the call record and the rebind", () => {
    const program = parse(
      `@withCall\ndef each(xs: number[], block: (number) -> number): number[] { return xs }\n`,
    );
    const def = defNamed(program, "each");
    const body = loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup);
    const call = outermostCall(body);
    const record = callRecordOf(body, call) as {
      entries: { key: string; value: { entries: unknown[] } }[];
    };
    expect(record.entries[1].value.entries).toHaveLength(1);
    expect(call.block?.body[0]).toMatchObject({
      type: "rebindParameters",
      parameters: [{ name: "xs" }],
      blockParameters: ["block"],
    });
  });

  it("passes the record under the decorator's own slot name", () => {
    const program = parse(`@named\ndef f(a: number): number { return a }\n`);
    const def = defNamed(program, "f");
    const call = outermostCall(loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup));
    expect(call.arguments[call.arguments.length - 1]).toMatchObject({
      type: "namedArgument",
      name: "ctx",
    });
  });

  it("nests stacked decorators outermost first", () => {
    const program = parse(`@plain\n@fromAway(cost: 2)\ndef f(): string { return "x" }\n`);
    const def = defNamed(program, "f");
    const original = def.body;
    const outer = outermostCall(loweredBody(def, decoratorsAbove(program.nodes)[0].tags, lookup));
    expect(outer.functionName).toBe("plain");
    const inner = innerCall(outer.block?.body ?? []);
    expect(inner.functionName).toBe("fromAway");
    expect(inner.scope).toBe("imported");
    expect(inner.arguments[0]).toMatchObject({ type: "namedArgument", name: "cost" });
    expect(inner.block?.body.slice(1)).toEqual(original);
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

describe("desugarDecorators fills decorator slots", () => {
  it("types every decorator def's slots before lowering, so a decorated decorator's record leaves its block out", () => {
    const program = parse(
      `decorator def outer(call, block) { return block() }\n@outer\ndecorator def inner(call, block) { return block() }\n@inner\ndef f(a: number): number { return a }\n`,
    );
    const defs = { outer: defNamed(program, "outer"), inner: defNamed(program, "inner") };
    desugarDecorators(program, decoratorLookup(defs, {}));
    for (const def of [defs.outer, defs.inner]) {
      expect(def.parameters[0].typeHint).toEqual({ type: "typeAliasVariable", aliasName: "Call" });
      expect(def.parameters[1].typeHint).toMatchObject({ type: "blockType" });
    }
    const record = (defs.inner.body[0] as Assignment).value as {
      entries: { key: string; value: { entries: { key: string }[] } }[];
    };
    expect(record.entries[1].value.entries.map((entry) => entry.key)).toEqual(["call"]);
  });
});

describe("decoratorLookup", () => {
  it("says whether a name is a decorator, for local and imported defs", () => {
    const program = parse(
      `decorator def marked(call, block) { return block() }\ndef plain(call: Call, block: () -> any): any { return block() }\n`,
    );
    const lookup = decoratorLookup(
      { marked: defNamed(program, "marked"), plain: defNamed(program, "plain") },
      {
        fromAway: {
          parameters: [parameter("call"), parameter("block")],
          returnType: null,
          markers: { decorator: true },
        },
        plainAway: { parameters: [parameter("call"), parameter("block")], returnType: null },
      },
    );
    expect(lookup("marked")?.decorator).toBe(true);
    expect(lookup("plain")?.decorator).toBe(false);
    expect(lookup("fromAway")).toEqual(
      expect.objectContaining({ imported: true, decorator: true }),
    );
    expect(lookup("plainAway")?.decorator).toBe(false);
    expect(lookup("nobody")).toBeUndefined();
  });
});

describe("decoratorProblems", () => {
  const scope = {
    functionDefinitions: {},
    importedFunctions: {
      plain: {
        parameters: [parameter("call"), parameter("block")],
        returnType: null,
        markers: { decorator: true },
      },
    },
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
      `@plain\ndecorator def a(call: Call, block: () -> any): any { return block() }\n@a\ndef b(): string { return "x" }\n`,
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
      `decorator def tagged(label: string, call, x: number): string { return label }\n@tagged("x")\ndef f(): string { return "x" }\n`,
    );
    const withTagged = { ...scope, functionDefinitions: { tagged: defNamed(program, "tagged") } };
    expect(decoratorProblems(program, withTagged).map((problem) => problem.message)).toEqual([
      "'tagged' is declared as a decorator, but its last parameter must take the body as a block, such as `block: (args: object) -> any`. Found 'x: number'.",
    ]);
  });

  it("accepts a last parameter typed any or left untyped, as the type checker does", () => {
    const program = parse(
      `decorator def loose(call: Call, block: any): any { return block() }\ndecorator def bare(call, block): any { return block() }\n@loose\n@bare\ndef f(): string { return "x" }\n`,
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

  it("reports a decorator def in the wrong shape at the def, once, whatever its tags", () => {
    const program = parse(
      `decorator def logged(call: Call, tag: string, block: () -> any): any { return block() }\n@logged("t")\ndef f(): string { return "x" }\n@logged("u")\ndef g(): string { return "y" }\n`,
    );
    const withLogged = { ...scope, functionDefinitions: { logged: defNamed(program, "logged") } };
    const problems = decoratorProblems(program, withLogged);
    expect(problems.map((problem) => problem.message)).toEqual([
      "'logged' is declared as a decorator, but 'tag' receives the call record, so its type must be `Call` or left off.",
    ]);
    expect(problems[0].loc).toEqual(defNamed(program, "logged").loc);
  });

  it("refuses a tag on a plain def whatever its shape", () => {
    const program = parse(
      `def d(call: Call, block: () -> any): any { return block() }\n@d\ndef f(): string { return "x" }\n`,
    );
    const withD = { ...scope, functionDefinitions: { d: defNamed(program, "d") } };
    const problems = decoratorProblems(program, withD);
    expect(problems.map((problem) => problem.message)).toEqual([
      "'d' is not a decorator, so '@d' cannot go on 'f'. Declare it as `decorator def d(...)`.",
    ]);
    expect(problems[0].loc).toEqual(program.nodes[1].loc);
  });

  it("reports an imported decorator in the wrong shape at the tag", () => {
    const program = parse(`@bad\ndef f(): string { return "x" }\n`);
    const withBad = {
      ...scope,
      importedFunctions: {
        bad: { parameters: [parameter("block")], returnType: null, markers: { decorator: true } },
      },
    };
    const problems = decoratorProblems(program, withBad);
    expect(problems.map((problem) => problem.message)).toEqual([
      "'bad' is declared as a decorator, but a decorator takes at least two parameters: the call record and the body as a block.",
    ]);
    expect(problems[0].loc).toEqual(program.nodes[0].loc);
  });

  it("refuses a default on call or the block", () => {
    const program = parse(
      `decorator def d(call: Call, block: () -> any = null): any { return block() }\n@d\ndef f(): string { return "x" }\n`,
    );
    const withD = { ...scope, functionDefinitions: { d: defNamed(program, "d") } };
    expect(decoratorProblems(program, withD).map((problem) => problem.message)).toEqual([
      "'d' is declared as a decorator, but 'block' has a default, and a decorator always receives the call record and the block. Remove the default.",
    ]);
  });

  it("describes the shape in the unknown-decorator message", () => {
    const program = parse(`@budgted\ndef f(): string { return "x" }\n`);
    expect(decoratorProblems(program, scope)[0].message).toBe(
      "Unknown decorator 'budgted' on 'f'. A decorator is a `decorator def` whose last two parameters are the call record and a block; declare or import 'budgted'.",
    );
  });
});
