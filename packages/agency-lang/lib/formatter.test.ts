import { describe, expect, it } from "vitest";
import { formatSource } from "./formatter.js";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("formatSource", () => {
  it("does not inject stdlib imports when formatting user source", () => {
    const formatted = formatSource("node main(){print(1)}\n");
    expect(formatted).toContain("node main()");
    expect(formatted).not.toContain('import {');
    expect(formatted).not.toContain('"std::index"');
  });

  it("preserves blank lines between statements", () => {
    const input = 'node main() {\n  print("a")\n\n  print("b")\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain('print("a")\n\n  print("b")');
  });

  it("preserves multiple blank line regions", () => {
    const input = 'node main() {\n  print("a")\n\n  print("b")\n\n  print("c")\n}\n';
    const formatted = formatSource(input);
    const matches = formatted!.match(/\n\n/g);
    expect(matches?.length).toBe(2);
  });

  it("collapses multiple consecutive blank lines into one", () => {
    const input = 'node main() {\n  print("a")\n\n\n\n  print("b")\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain('print("a")\n\n  print("b")');
    expect(formatted).not.toContain('\n\n\n');
  });

  it("output ends with exactly one trailing newline", () => {
    const input = 'node main() {\n  print("a")\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toMatch(/[^\n]\n$/);
  });

  it("removes trailing whitespace from lines", () => {
    const input = 'node main() {\n  print("a")\n}\n';
    const formatted = formatSource(input);
    const lines = formatted!.split("\n");
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("keeps short function signatures on one line", () => {
    const input = 'def add(a: number, b: number): number {\n  return a + b\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("def add(a: number, b: number): number {");
  });

  it("wraps long function signatures to multi-line", () => {
    const input = 'def processData(inputFile: string, outputFile: string, format: string, verbose: boolean) {\n  return 1\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("def processData(\n");
    expect(formatted).toContain("  inputFile: string,\n");
    expect(formatted).toContain("  verbose: boolean,\n");
    expect(formatted).toContain(") {");
  });

  it("wraps long node signatures to multi-line", () => {
    const input = 'node handleRequest(message: string, context: string, options: string, verbose: boolean) {\n  return 1\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("node handleRequest(\n");
    expect(formatted).toContain(") {");
  });

  it("keeps short function calls on one line", () => {
    const input = 'node main() {\n  print("hello")\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain('print("hello")');
  });

  it("wraps long function call arguments to multi-line", () => {
    const input = 'node main() {\n  someFunction("a very long argument", "another long argument", "yet another", "and more")\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("someFunction(\n");
    expect(formatted).toContain('"a very long argument",');
  });

  it("wraps long call arguments with trailing as block", () => {
    const input = 'node main() {\n  const result = longFunctionName("very long first argument string here", "second long argument string") as item {\n    return item\n  }\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("longFunctionName(\n");
    expect(formatted).toContain(") as item {");
  });

  it("keeps short imports on one line", () => {
    const input = 'import { foo, bar } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain('import { foo, bar } from "./utils.agency"');
  });

  it("wraps long named imports to multi-line", () => {
    const input = 'import { alpha, bravo, charlie, delta, echo, foxtrot, golf } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("import {\n");
    expect(formatted).toContain("  alpha,\n");
    expect(formatted).toContain('} from "./utils.agency"');
  });

  it("preserves safe and alias in wrapped imports", () => {
    const input = 'import { safe alpha, bravo as b, charlie, delta, echo, foxtrot } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("  safe alpha,");
    expect(formatted).toContain("  bravo as b,");
  });

  it("sorts imports into groups: stdlib, packages, relative", () => {
    const input = [
      'import { bar } from "./bar.agency"',
      'import { bash } from "std::shell"',
      'import { foo } from "./foo.js"',
      'import { mcp } from "pkg::@agency-lang/mcp"',
      'node main() {',
      '  print(1)',
      '}',
    ].join("\n") + "\n";
    const formatted = formatSource(input);
    const lines = formatted!.split("\n");
    // stdlib first
    expect(lines[0]).toBe('import { bash } from "std::shell"');
    // blank line
    expect(lines[1]).toBe('');
    // packages
    expect(lines[2]).toBe('import { mcp } from "pkg::@agency-lang/mcp"');
    // blank line
    expect(lines[3]).toBe('');
    // relative (alphabetized)
    expect(lines[4]).toBe('import { bar } from "./bar.agency"');
    expect(lines[5]).toBe('import { foo } from "./foo.js"');
  });

  it("round-trips a correctly formatted file unchanged", () => {
    const fixturePath = path.join(__dirname, "../tests/formatter/roundtrip.agency");
    const input = fs.readFileSync(fixturePath, "utf-8");
    const formatted = formatSource(input);
    expect(formatted).toBe(input.trimEnd() + "\n");
  });

  it("round-trips a generics fixture (type params + Record) unchanged", () => {
    const fixturePath = path.join(__dirname, "../tests/formatter/generics.agency");
    const input = fs.readFileSync(fixturePath, "utf-8");
    const formatted = formatSource(input);
    expect(formatted).toBe(input.trimEnd() + "\n");
    // Idempotent: a second pass over the formatted output is identical.
    expect(formatSource(formatted!)).toBe(formatted);
  });

  // Locks in the `=>` → `->` migration and the named-param round-trip
  // added in the block-type-named-params change. Both must reformat
  // exactly as below so users can rely on `fmt` to silently migrate
  // legacy `=>` arrows and surface param names in formatted output.
  it("block-types: migrates `=>` to `->` and surfaces param names", () => {
    const input =
`type AgentSpec = {
  agent: (userMsg: string) => string;
  cb: (string) => void
}
`;
    const expected =
`type AgentSpec = {
  agent: (userMsg: string) -> string;
  cb: (string) -> void
}
`;
    const formatted = formatSource(input);
    expect(formatted).toBe(expected);
    // Idempotent on the migrated output.
    expect(formatSource(formatted!)).toBe(expected);
  });

  describe("comments inside match blocks", () => {
    it("preserves a leading comment before the first case", () => {
      const input =
        'node main() {\n  let x = 1\n  match (x) {\n    // a comment\n    1 => "one"\n    2 => "two"\n  }\n}\n';
      const formatted = formatSource(input);
      expect(formatted).toContain('// a comment\n    1 => "one"');
    });

    it("preserves a comment between two cases", () => {
      const input =
        'node main() {\n  let x = 1\n  match (x) {\n    1 => "one"\n    // between\n    2 => "two"\n  }\n}\n';
      const formatted = formatSource(input);
      expect(formatted).toContain('// between\n    2 => "two"');
    });
  });

  describe("comments inside record types", () => {
    it("preserves a leading // comment before the first property", () => {
      const input =
        "type Foo = {\n  // leading\n  name: string,\n  age: number\n}\n";
      const formatted = formatSource(input);
      expect(formatted).toContain("// leading\n  name: string");
    });

    it("preserves a // comment between two properties", () => {
      const input =
        "type Foo = {\n  name: string,\n  // between\n  age: number\n}\n";
      const formatted = formatSource(input);
      expect(formatted).toContain("// between\n  age: number");
    });

    it("preserves a trailing // comment after the last property", () => {
      const input =
        "type Foo = {\n  name: string,\n  age: number,\n  // trailing\n}\n";
      const formatted = formatSource(input);
      expect(formatted).toMatch(/age: number\s*\n\s*\/\/ trailing\s*\n}/);
    });

    it("preserves a /* */ block comment", () => {
      const input =
        "type Foo = {\n  /* block leading */\n  name: string\n}\n";
      const formatted = formatSource(input);
      expect(formatted).toContain("/* block leading */\n  name: string");
    });

    it("preserves multiple consecutive comments without converting syntax", () => {
      const input =
        "type Foo = {\n  // first\n  /* second */\n  name: string\n}\n";
      const formatted = formatSource(input);
      expect(formatted).toContain("// first\n");
      expect(formatted).toContain("/* second */\n");
    });

    it("preserves a blank line between properties", () => {
      const input =
        "type Foo = {\n  name: string,\n\n  age: number\n}\n";
      const formatted = formatSource(input);
      expect(formatted).toMatch(/name: string;\s*\n\n\s*age: number/);
    });

    it("is idempotent for every record-comment shape", () => {
      const inputs = [
        "type A = {\n  // leading\n  name: string\n}\n",
        "type B = {\n  name: string,\n  // between\n  age: number\n}\n",
        "type C = {\n  name: string,\n  age: number,\n  // trailing\n}\n",
        "type D = {\n  /* doc */\n  name: string\n}\n",
        "type E = {\n  // a\n  // b\n  name: string\n}\n",
        "type F = {\n  name: string,\n\n  age: number\n}\n",
      ];
      for (const input of inputs) {
        const f1 = formatSource(input);
        const f2 = formatSource(f1!);
        expect(f2).toBe(f1);
      }
    });

    // Known limitation: comments inside inline (non-aliased) record types
    // — e.g. `def f(x: { /* c */ a: number }) { ... }` — are dropped by the
    // formatter today. The trivia survives in the AST (the parser captures
    // it everywhere `objectTypeParser` runs), but the renderer for inline
    // types lives in `variableTypeToString` (typescriptGenerator/) which
    // flattens objectType to `{ a: number; b: string }` regardless. Fixing
    // it requires threading indent context through `variableTypeToString`,
    // which is shared with TS / Zod code generation — out of scope.
  });

  describe("export-from re-export round-trip", () => {
    it.each([
      'export { foo } from "./tools.agency"',
      'export { foo as bar } from "./tools.agency"',
      'export { search as wikipediaSearch, fetch } from "std::wikipedia"',
      'export { safe foo, bar } from "std::wikipedia"',
      'export { safe foo as bar } from "std::wikipedia"',
      'export * from "std::wikipedia"',
    ])("round-trips: %s", (input) => {
      const formatted = formatSource(input + "\n");
      expect(formatted!.trimEnd()).toBe(input);
    });
  });
});
