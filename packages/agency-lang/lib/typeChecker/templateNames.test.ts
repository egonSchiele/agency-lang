import { describe, expect, it } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

function diagnosticsOf(source: string) {
  const report = typeCheckSource(source);
  return [...report.errors, ...report.warnings];
}

function codesOf(source: string): string[] {
  return diagnosticsOf(source).map((diagnostic) => diagnostic.code);
}

function messageFor(source: string, code: string): string | undefined {
  return diagnosticsOf(source).find((diagnostic) => diagnostic.code === code)
    ?.message;
}

/** A host file with `body` inside a code literal. */
function withLiteral(body: string[]): string {
  return [
    "node host() {",
    "  const template = [|",
    ...body,
    "  |]",
    '  print("host")',
    "}",
    "",
  ].join("\n");
}

describe("AG8015: names a template does not define", () => {
  it("reports a variable a statement hole would supply", () => {
    const source = withLiteral([
      "    node main() {",
      "    #body",
      "      print(res)",
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
  });

  it("reports a call a declaration hole would supply", () => {
    // A FunctionCall's name is a plain string, not a variableName node, so
    // a variable-only walk would miss this entirely.
    const source = withLiteral([
      "    #helpers",
      "",
      "    export node main(): string {",
      "      return guarded()",
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/guarded/);
  });

  it("reports a call to a helper that exists only in the host file", () => {
    const source = [
      "def helper(): string {",
      '  return "hi"',
      "}",
      "",
      "node host() {",
      "  const template = [|",
      "    node main(): string {",
      "      return helper()",
      "    }",
      "  |]",
      '  print("host")',
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/helper/);
  });

  it("reports a first-class reference to a host helper", () => {
    const source = [
      "def helper(): string {",
      '  return "hi"',
      "}",
      "",
      "node host() {",
      "  const template = [|",
      "    const tool = helper",
      "  |]",
      '  print("host")',
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toContain("AG8015");
  });

  it("reports a local read from a sibling definition", () => {
    // One flat scope would let this resolve. Each definition has its own.
    const source = withLiteral([
      "    def first(): number {",
      "      const secret = 1",
      "      return secret",
      "    }",
      "",
      "    def second(): number {",
      "      return secret",
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
  });

  it("reports a misspelled direct call", () => {
    const source = withLiteral([
      "    def greet(): string {",
      '      return "hi"',
      "    }",
      "",
      "    def main(): string {",
      "      return greeet()",
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/greeet/);
  });
});

describe("AG8015: names a template does define", () => {
  // Over-rejection guards. Each covers a pattern real templates use, and
  // a flat scope model fails most of them.

  it("a parameter of a nested def", () => {
    const source = withLiteral([
      "    def greet(name: string): string {",
      "      return name",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a parameter of a nested node", () => {
    const source = withLiteral([
      "    node main(topic: string): string {",
      "      return topic",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a local declared inside one nested definition", () => {
    const source = withLiteral([
      "    def f(): number {",
      "      const x = 1",
      "      return x",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a for binder used inside the loop", () => {
    const source = withLiteral([
      "    def f(): number {",
      "      for (item in [1, 2]) {",
      "        print(item)",
      "      }",
      "      return 1",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a block parameter", () => {
    // Block params are not tracked in the typechecker's Scope at all, so
    // resolving one would always fail. The shared classifier skips them.
    const source = withLiteral([
      "    def f(): number[] {",
      "      return map([1, 2], \\(item) -> item + 1)",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a top-level binding in the literal, used later", () => {
    const source = withLiteral(["    const res = 1", "    print(res)"]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a direct call to a def the literal declares", () => {
    const source = withLiteral([
      "    def greet(): string {",
      '      return "hi"',
      "    }",
      "",
      "    def main(): string {",
      "      return greet()",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a first-class reference to a def the literal declares", () => {
    const source = withLiteral([
      "    def greet(): string {",
      '      return "hi"',
      "    }",
      "",
      "    const tool = greet",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a non-prelude import, called and referenced", () => {
    // `edit`, not `read`: `read` is in PRELUDE_NAMES, which would make
    // this test vacuous.
    const source = withLiteral([
      '    import { edit } from "std::fs"',
      "",
      "    def g(): string {",
      '      return edit("x", "y", "z")',
      "    }",
      "",
      "    const tool = edit",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a prelude call", () => {
    const source = withLiteral(['    print("hi")']);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a builtin call", () => {
    const source = withLiteral(['    const answer = llm("hi")']);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a method call on a binding the literal declares", () => {
    // `method` in `obj.method()` is not a lexical name.
    const source = withLiteral([
      '    const greeting = "hi"',
      "    const loud = greeting.toUpperCase()",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });
});

describe("AG8015: the analysis is isolated", () => {
  it("does not leak diagnostics from its own synthetic pass", () => {
    // Building scopes for the literal can produce incidental diagnostics.
    // This pass reports undefined names and nothing else.
    const source = withLiteral(['    const value: string = 1']);
    expect(codesOf(source)).not.toContain("AG2001");
  });

  it("lets two literals declare the same name", () => {
    // Scope keys derive from definition names, so per-call state has to
    // be isolated or these two collide.
    const source = [
      "node host() {",
      "  const first = [|",
      "    def greet(): string {",
      '      return "one"',
      "    }",
      "  |]",
      "  const second = [|",
      "    def greet(): string {",
      '      return "two"',
      "    }",
      "  |]",
      '  print("host")',
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).not.toContain("AG8015");
  });
});

describe("AG8015: the message", () => {
  it("names the name and says what to do", () => {
    const source = withLiteral([
      "    node main() {",
      "    #body",
      "      print(res)",
      "    }",
    ]);
    const message = messageFor(source, "AG8015");
    expect(message).toMatch(/res/);
    expect(message).toMatch(/declares or imports/);
  });
});

describe("AG8015: template files", () => {
  // A .agency file with holes is itself a template, so the always-on pass
  // owns every undefined name in it.

  const missingVariable = [
    "node main(): string {",
    "#body",
    "  print(res)",
    "  return res",
    "}",
    "",
  ].join("\n");

  const missingCall = [
    "#helpers",
    "",
    "node main(): string {",
    "  return guarded()",
    "}",
    "",
  ].join("\n");

  it("reports a missing variable as AG8015, not AG4007", () => {
    expect(codesOf(missingVariable)).toContain("AG8015");
    expect(codesOf(missingVariable)).not.toContain("AG4007");
  });

  it("reports a missing call as AG8015, not AG4004", () => {
    expect(codesOf(missingCall)).toContain("AG8015");
    expect(codesOf(missingCall)).not.toContain("AG4004");
  });

  it("still reports an ordinary variable typo away from the hole", () => {
    // AG4007 stands down for the whole file, so this pass has to cover
    // what it stopped covering.
    const source = [
      "node main(): string {",
      "#body",
      "  const greeting = 1",
      "  print(greetign)",
      '  return "x"',
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toContain("AG8015");
  });

  it("still reports an ordinary call typo away from the hole", () => {
    const source = [
      "#helpers",
      "",
      "def greet(): string {",
      '  return "hi"',
      "}",
      "",
      "node main(): string {",
      "  return greeet()",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toContain("AG8015");
  });

  it("leaves a hole-free file's missing variable to the ordinary pass", () => {
    const source = 'node main(): string {\n  print(res)\n  return "x"\n}\n';
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("leaves a hole-free file's missing call to AG4004", () => {
    const source = 'node main(): string {\n  return missingHelper()\n}\n';
    expect(codesOf(source)).toContain("AG4004");
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("still checks a literal inside a file that has its own hole", () => {
    // The whole-file walk treats a literal's nodes as opaque, so the
    // literal loop has to keep running after the file-level report.
    const source = [
      "#helpers",
      "",
      "node main(): string {",
      "  const template = [|",
      "    node inner(): string {",
      "      return missingInLiteral()",
      "    }",
      "  |]",
      '  return "x"',
      "}",
      "",
    ].join("\n");
    expect(messageFor(source, "AG8015")).toBeDefined();
    const names = diagnosticsOf(source)
      .filter((found) => found.code === "AG8015")
      .map((found) => found.message);
    expect(names.some((message) => message.includes("missingInLiteral"))).toBe(
      true,
    );
  });

  it("keeps checking JS namespace members in a template file", () => {
    // AG8015 sees `nosuch` as a method, not a lexical name, so the
    // ordinary pass has to keep covering this position.
    const source = [
      "#helpers",
      "",
      "node main(): number {",
      "  return Math.nosuch(1)",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toContain("AG4004");
  });
});

describe("AG8015: names reached through an access", () => {
  it("reports an index expression the template does not define", () => {
    const source = withLiteral([
      "    const items = [1, 2]",
      "    print(items[missingIndex])",
    ]);
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/missingIndex/);
  });

  it("says nothing about an index the template declares", () => {
    const source = withLiteral([
      "    const items = [1, 2]",
      "    const i = 0",
      "    print(items[i])",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });
});

describe("AG8015: a template's own imported node", () => {
  it("says nothing about a direct call to it", () => {
    const source = withLiteral([
      '    import node { helper } from "./helper.agency"',
      "",
      "    node main(): string {",
      "      return helper()",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("says nothing about a first-class reference to it", () => {
    const source = withLiteral([
      '    import node { helper } from "./helper.agency"',
      "",
      "    const tool = helper",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });
});

describe("AG8015: type names a template does not define", () => {
  it("reports a borrowed type on an annotated declaration", () => {
    const source = [
      "type Person = {",
      "  name: string",
      "}",
      "",
      "node host() {",
      "  const template = [|",
      '    const p: Person = { name: "a" }',
      "  |]",
      '  print("host")',
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/Person/);
  });

  it("reports a borrowed type on a hole annotation", () => {
    // The #719 case: the hole's type is one the template does not have,
    // so fill cannot check it and the generated program will not compile.
    const source = withLiteral([
      "    node main(): string {",
      "      const p: Person = #person",
      '      return "x"',
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/Person/);
  });

  it("reports a borrowed type on a parameter", () => {
    const source = withLiteral([
      "    def greet(who: Person): string {",
      '      return "hi"',
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
    expect(messageFor(source, "AG8015")).toMatch(/Person/);
  });

  it("reports a borrowed type on a return annotation", () => {
    const source = withLiteral([
      "    def make(): Person {",
      '      return { name: "a" }',
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
  });

  it("reports a borrowed type on a node parameter", () => {
    const source = withLiteral([
      "    node main(who: Person): string {",
      '      return "hi"',
      "    }",
    ]);
    expect(codesOf(source)).toContain("AG8015");
  });
});

describe("AG8015: type names a template does define", () => {
  it("a type the template declares", () => {
    const source = withLiteral([
      "    type Person = {",
      "      name: string",
      "    }",
      "",
      '    const p: Person = { name: "a" }',
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a type the template declares, used in a signature", () => {
    const source = withLiteral([
      "    type Person = {",
      "      name: string",
      "    }",
      "",
      "    def greet(who: Person): Person {",
      "      return who",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a type the template imports", () => {
    const source = withLiteral([
      '    import { Person } from "./types.agency"',
      "",
      '    const p: Person = { name: "a" }',
      "",
      "    def greet(who: Person): Person {",
      "      return who",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a builtin generic", () => {
    const source = withLiteral([
      '    const r: Result<string> = success("a")',
      "    const counts: Record<string, number> = {}",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("primitives and arrays", () => {
    const source = withLiteral([
      "    const n: number = 1",
      '    const names: string[] = ["a"]',
      "    def add(x: number, y: number): number {",
      "      return x + y",
      "    }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });

  it("a generic parameter in an alias body", () => {
    // Alias bodies are deliberately unchecked: `T` is bound here, and the
    // resolver has no notion of bound names.
    const source = withLiteral([
      "    type Box<T> = {",
      "      value: T",
      "    }",
      "",
      "    const b: Box<number> = { value: 1 }",
    ]);
    expect(codesOf(source)).not.toContain("AG8015");
  });
});

describe("AG8015: type names in a template file", () => {
  it("leaves an unknown type in a holey file to AG1006", () => {
    // A file's own annotations resolve against its real imports, so that
    // pass already covers them. Two codes for one name would be noise.
    const source = 'node main(): string {\n  const p: Person = #person\n  return "x"\n}\n';
    expect(codesOf(source)).toContain("AG1006");
    expect(codesOf(source)).not.toContain("AG8015");
  });
});
