import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import { discoverFixturePairs } from "../../tests/fixtureDiscovery.js";
import path from "path";

function normalizeWhitespace(code: string): string {
  return (
    code
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n\n\n+/g, "\n\n")
      .trim()
      .concat("\n")
  );
}

export function generateWithBuilder(agencySource: string, moduleId: string = "test.agency"): string {
  const parseResult = parseAgency(agencySource, {}, false);
  if (!parseResult.success) {
    throw new Error(`Failed to parse: ${parseResult.message}`);
  }
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(undefined, info, moduleId);
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../tests/typescriptBuilder",
);

describe("TypeScript Builder Integration Tests", () => {
  const fixtures = discoverFixturePairs(FIXTURES_DIR, ".mjs");

  if (fixtures.length === 0) {
    it("should find test fixtures (add .agency + .mjs pairs to tests/typescriptBuilder/)", () => {
      // No fixtures yet — this is expected initially.
      // Add .agency files and run `make builder-fixtures` to generate .mjs files.
      expect(true).toBe(true);
    });
    return;
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, filePath, agencyContent, companionContent }) => {
      it("should generate correct TypeScript output", () => {
        let generatedTS: string;
        try {
          generatedTS = generateWithBuilder(agencyContent, name + ".agency");
        } catch (error) {
          throw new Error(
            `Failed to generate TypeScript for fixture: ${name}\nFile: ${filePath}\nError: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        expect(normalizeWhitespace(generatedTS)).toBe(
          normalizeWhitespace(companionContent),
        );
      });
    },
  );
});

describe("match-expression result temp resolution", () => {
  // Regression: `runner.exitMatch(id, value)` writes the match result to
  // `__stack.locals.__matchval_<id>`, so the consumer read MUST compile to the
  // same frame-local accessor. Pattern lowering emits the read as an undeclared
  // synthetic `variableName`; without targeted resolution it compiled to a bare
  // JS identifier (`runner.halt(__matchval_1)`) and crashed with
  // `ReferenceError: __matchval_1 is not defined`.
  const source = `node main(x: number) {
  const val = match(x) {
    1 => "one"
    _ => "other"
  }
  return val
}
`;

  it("compiles the consumer read to the locals accessor, never a bare identifier", () => {
    const out = generateWithBuilder(source, "matchExprResult.agency");

    // The value is read through the same frame-local accessor exitMatch writes.
    expect(out).toContain("__stack.locals.__matchval_1");
    // And it is written through exitMatch (the other half of the contract).
    expect(out).toContain("exitMatch(1,");

    // There must be NO bare `__matchval_1` occurrence: every occurrence must be
    // preceded by `__stack.locals.` (or be the string arg to exitMatch, which
    // does not name the identifier at all). Strip the accessor form, then assert
    // the identifier no longer appears anywhere.
    const withoutAccessor = out.replaceAll("__stack.locals.__matchval_1", "");
    expect(withoutAccessor).not.toMatch(/__matchval_\d+/);
  });

  // The special case must fire ONLY for the synthetic temp (which always
  // arrives with unresolved scope). A USER variable that happens to be named
  // `__matchval_<n>` must resolve through the normal scope machinery.
  it("leaves a user loop variable named __matchval_<n> as a bare loop identifier", () => {
    const source = `node main() {
  let total = 0
  for (__matchval_7 in [1, 2, 3]) {
    total = total + __matchval_7
  }
  return total
}
`;
    const out = generateWithBuilder(source, "matchvalLoopVar.agency");
    // Loop vars are bound as bare closure params of `runner.loop(...)` and
    // read back as bare JS identifiers; forcing the frame-local accessor
    // would read undefined every iteration. (Before this fix was scoped to
    // the unresolved branch, the read compiled to
    // `__stack.locals.__matchval_7`.)
    expect(out).not.toContain("__stack.locals.__matchval_7");
    expect(out).toMatch(/async \(__matchval_7, /);
    expect(out).toContain("+ __matchval_7");
  });

  it("resolves a user-declared local named __matchval_<n> through normal declaration machinery", () => {
    const source = `node main() {
  let __matchval_9 = 5
  return __matchval_9
}
`;
    const out = generateWithBuilder(source, "matchvalUserLocal.agency");
    // Declared via `let`, so scope resolution marks it local: it must be
    // WRITTEN to the accessor (declaration machinery ran) and read back
    // from the same place — never emitted as a bare undeclared identifier.
    expect(out).toContain("__stack.locals.__matchval_9 = 5");
    const withoutAccessor = out.replaceAll("__stack.locals.__matchval_9", "");
    expect(withoutAccessor).not.toMatch(/__matchval_\d+/);
  });
});

describe("Named argument validation", () => {
  // Named arg validation is now done at runtime by AgencyFunction.invoke(),
  // not at compile time. These tests verify the builder compiles successfully.
  it("should compile when skipping a required argument (validated at runtime)", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(greeting: "Hi")
`),
    ).not.toThrow();
  });

  it("should compile with unknown named argument (validated at runtime)", () => {
    expect(() =>
      generateWithBuilder(`
def foo(a: string) {
  print(a)
}
foo(a: "hi", extra: "oops")
`),
    ).not.toThrow();
  });

  it("should accept correct named arguments", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(name: "world", greeting: "Hi")
`),
    ).not.toThrow();
  });

  it("should accept reordered named arguments", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(greeting: "Hi", name: "world")
`),
    ).not.toThrow();
  });

  it("should compile with positional after named (validated at runtime)", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(name: "world", "Hi")
`),
    ).not.toThrow();
  });

  it("should compile with duplicate named argument (validated at runtime)", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(name: "world", name: "other")
`),
    ).not.toThrow();
  });

  it("should accept named args with block parameters", () => {
    expect(() =>
      generateWithBuilder(`
def twice(label: string, block: () => string): string {
  return block() + block()
}
twice(label: "test") as {
  return "hi"
}
`),
    ).not.toThrow();
  });
});

describe("optimize declaration modifier", () => {
  it("does not emit optimize as runtime TypeScript", () => {
    const optimized = generateWithBuilder(`
optimize const prompt = "hi"
node main() {
  return prompt
}
`);

    const plain = generateWithBuilder(`
const prompt = "hi"
node main() {
  return prompt
}
`);

    expect(normalizeWhitespace(optimized)).toBe(normalizeWhitespace(plain));
    expect(optimized).not.toContain("optimize");
  });
});

describe("Destructive-execution tracking codegen", () => {
  const bodyOf = (output: string, funcName: string): string => {
    const m = output.match(
      new RegExp(`async function __${funcName}_impl\\([\\s\\S]*?finally`),
    );
    expect(m).toBeTruthy();
    return m![0];
  };

  it("every function inits __destructiveRan and stamps the boundary — even with no destructive content", () => {
    const output = generateWithBuilder(`
def plain(id: string): string {
  return id
}
`);
    const body = bodyOf(output, "plain");
    // Unconditional per function: the tool loop can set the flag at runtime
    // in any llm()-calling function, so both must always be present.
    expect(body).toContain("__self.__destructiveRan = __self.__destructiveRan ?? false");
    expect(body).toContain("stampFailureBoundary(runner.haltResult, __self.__destructiveRan)");
    // The old machinery is gone.
    expect(body).not.toContain("__retryable");
  });

  it("a destructive def flips __destructiveRan before an impure statement", () => {
    const output = generateWithBuilder(`
import { saveItem } from "./tools.js"

destructive def rm(id: string): string {
  saveItem(id)
  return id
}
`);
    const body = bodyOf(output, "rm");
    expect(body).toContain("__self.__destructiveRan = true");
  });

  it("emits markers into the AgencyFunction registration", () => {
    const dOut = generateWithBuilder(`destructive def rm(id: string): string { return id }`);
    expect(dOut).toMatch(/markers:\s*\{\s*destructive:\s*true/);
    const iOut = generateWithBuilder(`idempotent def compileIt(s: string): string { return s }`);
    expect(iOut).toMatch(/markers:\s*\{\s*idempotent:\s*true/);
    const plainOut = generateWithBuilder(`def plain(id: string): string { return id }`);
    expect(plainOut).not.toContain("markers:");
  });

  it("an unmarked caller of a destructive fn emits the outcome flip on the result", () => {
    const output = generateWithBuilder(`
destructive def rm(id: string): string {
  return id
}
def caller(id: string): string {
  const r = rm(id)
  return r
}
`);
    const body = bodyOf(output, "caller");
    // Outcome-dependent: a returned failure contributes its own bit, a
    // success/plain value marks true.
    expect(body).toContain(
      "__self.__destructiveRan = __self.__destructiveRan || (isFailure(__self.r) ? __self.r.destructiveRan : true)",
    );
  });
});

describe("schema(Type) expression", () => {
  it("should compile schema(Type) for named type aliases", () => {
    expect(() =>
      generateWithBuilder(`
type Category = "bug" | "feature"
node main() {
  const s = schema(Category)
}
`),
    ).not.toThrow();
  });

  it("should compile schema(Type) for builtin types", () => {
    expect(() =>
      generateWithBuilder(`
node main() {
  const s = schema(number)
}
`),
    ).not.toThrow();
  });

  it("should compile schema(Result<number>)", () => {
    expect(() =>
      generateWithBuilder(`
node main() {
  const s = schema(Result<number>)
}
`),
    ).not.toThrow();
  });

  it("generated code contains new Schema(...)", () => {
    const output = generateWithBuilder(`
type Category = "bug" | "feature"
node main() {
  const s = schema(Category)
}
`);
    expect(output).toContain("new Schema(");
  });
});

describe("subthread rejects continue/session at codegen", () => {
  // `subthread` is identity-bound to its parent's context; resuming
  // via `continue` or `session` would be ambiguous, so the builder
  // throws. See `lib/backends/typescriptBuilder.ts` (subthread continue/session check).
  it("throws when subthread() uses `continue`", () => {
    expect(() =>
      generateWithBuilder(`
node main() {
  thread {
    subthread(continue: "t1") {
    }
  }
}
`),
    ).toThrow(/subthread.*continue.*session/i);
  });

  it("throws when subthread() uses `session`", () => {
    expect(() =>
      generateWithBuilder(`
node main() {
  thread {
    subthread(session: "my-session") {
    }
  }
}
`),
    ).toThrow(/subthread.*continue.*session/i);
  });
});

import { mapTypeToValidationSchema } from "./typescriptGenerator/typeToZodSchema.js";

describe("mapTypeToValidationSchema", () => {

  it("generates Result validation schema for bare Result", () => {
    const schema = mapTypeToValidationSchema(
      { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
      {},
    );
    expect(schema).toContain("z.literal(true)");
    expect(schema).toContain("z.literal(false)");
  });

  it("generates Result validation schema with typed success", () => {
    const schema = mapTypeToValidationSchema(
      { type: "resultType", successType: { type: "primitiveType", value: "number" }, failureType: { type: "primitiveType", value: "string" } },
      {},
    );
    expect(schema).toContain("z.number()");
    expect(schema).toContain("z.literal(true)");
  });

  it("delegates non-Result types to mapTypeToZodSchema", () => {
    const schema = mapTypeToValidationSchema(
      { type: "primitiveType", value: "number" },
      {},
    );
    expect(schema).toBe("z.number()");
  });
});

describe("value-parameterized validator factory", () => {
  it("emits a descriptor factory for a validated value-param alias", () => {
    const out = generateWithBuilder(`
import { min, max } from "std::validation"

@validate(min.partial(n: low), max.partial(n: high))
@jsonSchema({ minimum: low, maximum: high })
type NumberInRange(low: number, high: number) = number

node main() {
  return 1
}
`);
    // Factory function, parameterized by the alias's value params, lives here:
    expect(out).toContain("function NumberInRange(low, high)");
    // Validators reference low/high as the factory's parameters (not literals):
    expect(out).toContain("min.partial({ n: low })");
    expect(out).toContain("max.partial({ n: high })");
    // Schema-path identifiers survive too: the `@jsonSchema(...)` tag goes
    // through `appendMeta` (typeToZodSchema.ts:32) and must reference the
    // factory params, NOT substituted literals. This mirrors how every
    // stdlib value-param alias (NumberInRange/StringWithLength) is defined.
    expect(out).toContain("minimum: low");
    expect(out).toContain("maximum: high");
  });

  it("bakes value-param defaults into the factory signature", () => {
    const out = generateWithBuilder(`
import { min } from "std::validation"

@validate(min.partial(n: low))
type Age(low: number = 0) = number

node main() {
  return 1
}
`);
    // An omitted use-site arg (Age() / bare Age) must fall back to the default,
    // so the default has to live in the factory signature itself.
    expect(out).toContain("function Age(low = 0)");
  });

  it("references the factory by call at a validated use site", () => {
    const out = generateWithBuilder(`
import { min, max } from "std::validation"

@validate(min.partial(n: low), max.partial(n: high))
type NumberInRange(low: number, high: number) = number

node main() {
  const n: NumberInRange(1, 10)! = 5
  return n
}
`);
    // The \`!\` site validates against a CALL to the factory, not an inlined chain:
    expect(out).toContain("NumberInRange(1, 10)");
  });

  it("evaluates the factory call once when use-site validators are stacked", () => {
    const out = generateWithBuilder(`
import { min, max } from "std::validation"

@validate(min.partial(n: low), max.partial(n: high))
type NumberInRange(low: number, high: number) = number

type Holder = {
  @validate(min.partial(n: 3)) val: NumberInRange(1, 10)
}

node main() {
  const h: Holder! = { val: 5 }
  return h
}
`);
    // Use-site validators must be concatenated via an IIFE that binds the
    // factory call to a local, so the factory (and its min.partial(...)
    // allocations) is evaluated exactly once, not twice.
    expect(out).toContain("(__d) =>");
    // The factory call appears once (as the IIFE argument), not spread + read.
    const calls = out.match(/NumberInRange\(1, 10\)/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

describe("match arm yielding a graph-node transition is a compile error", () => {
  it("rejects a match-expression arm whose value is a graph-node call", () => {
    const source = `node target() {
  return "done"
}

node main(x: string) {
  const val = match(x) {
    "a" => target()
    _ => "other"
  }
  return val
}`;
    expect(() => generateWithBuilder(source, "matchNodeYield.agency")).toThrow(
      /match arm cannot return a graph node transition/i,
    );
  });
});

describe("function wrapper JS export", () => {
  it("always JS-exports a non-exported function wrapper, keeping exported:false metadata", () => {
    const out = generateWithBuilder(`def helper(): number { return 1 }`);
    expect(out).toContain("export const helper");
    // The Agency-level visibility must still be recorded at runtime even
    // though the JS export no longer reflects it.
    expect(out).toContain("exported: false");
  });
});
