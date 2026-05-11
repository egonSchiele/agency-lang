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
