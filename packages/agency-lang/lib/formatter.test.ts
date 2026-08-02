import { describe, expect, it } from "vitest";
import { formatSource } from "./formatter.js";
import { parseAgency, replaceBlankLines } from "./parser.js";
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

  it("preserves a marker and alias in wrapped imports", () => {
    const input = 'import { idempotent alpha, bravo as b, charlie, delta, echo, foxtrot } from "./utils.agency"\nnode main() {\n  print(1)\n}\n';
    const formatted = formatSource(input);
    expect(formatted).toContain("  idempotent alpha,");
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

  it("prints a `: Type` suffix nested inside a pattern, and round-trips it", () => {
    // The suffix used to be arm-level only, so the printer never met one in
    // element or property position. A printer that dropped it would silently
    // turn a validated rule into an unvalidated one.
    const input = [
      "node main() {",
      "  const w = [\"cat\", \"f.txt\"]",
      "  const r = match (w) {",
      "    [\"echo\", s: string] => s",
      "    [\"cat\", p: SafePath] => p",
      "    [{ cmd: \"echo\" }: Word, ...rest] => \"word\"",
      // A wildcard with a suffix has no binder, so it takes formatPattern's
      // `pattern === null` branch — the branch written for after-`is`, where
      // the operator is already on the page. Printed bare in element position
      // it would come back as a BINDER named SafePath that matches anything,
      // silently turning a validated rule into an unvalidated one.
      "    [\"cat\", _: SafePath] => \"anon\"",
      "    { path: SafePath } => \"anon obj\"",
      "    _ => \"other\"",
      "  }",
      "  print(r)",
      "}",
      "",
    ].join("\n");
    const formatted = formatSource(input);
    // formatSource returns null when the source does not parse, so a parse
    // failure must not read as a silently-skipped assertion.
    expect(formatted).not.toBeNull();
    expect(formatted!).toContain("[\"echo\", s: string] =>");
    expect(formatted!).toContain("[\"cat\", p: SafePath] =>");
    expect(formatted!).toContain("[{ cmd: \"echo\" }: Word, ...rest] =>");
    expect(formatted!).toContain("[\"cat\", _: SafePath] =>");
    expect(formatted!).toContain("{ path: SafePath } =>");
    // Formatting the output again changes nothing.
    expect(formatSource(formatted!)).toBe(formatted);
  });

  it("round-trips a generics fixture (type params + Record) unchanged", () => {
    const fixturePath = path.join(__dirname, "../tests/formatter/generics.agency");
    const input = fs.readFileSync(fixturePath, "utf-8");
    const formatted = formatSource(input);
    expect(formatted).toBe(input.trimEnd() + "\n");
    // Idempotent: a second pass over the formatted output is identical.
    expect(formatSource(formatted!)).toBe(formatted);
  });

  // Regression: docstrings used to be naïvely `.trim()`ed on every
  // line, which collapsed `  ```code\n  block\n  ```` ` to flush-left
  // and lost the inner indentation. The fmt now dedents by the
  // common leading indent only, so the relative structure of code
  // fences / sub-bullets survives a round-trip.
  it("docstrings: preserves indentation inside ```code``` fences", () => {
    const input =
`def example() {
  """
  Example:

  \`\`\`ts
  if (true) {
    print("hi")
  }
  \`\`\`
  """
  return 1
}
`;
    const formatted = formatSource(input);
    expect(formatted).toContain("    print(\"hi\")");
    expect(formatted).toContain("  if (true) {");
    // Idempotent.
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
      'export { idempotent foo, bar } from "std::wikipedia"',
      'export { destructive foo as bar } from "std::wikipedia"',
      'export * from "std::wikipedia"',
    ])("round-trips: %s", (input) => {
      const formatted = formatSource(input + "\n");
      expect(formatted!.trimEnd()).toBe(input);
    });
  });
});

describe("syntax variations are a fixed point after one format", () => {
  const variations: [string, string][] = [
    ["function keyword", `function add(a: number, b: number): number { return a + b }`],
    ["arrow return type", `def f() -> string { return "x" }`],
    ["thin arrow in a match arm", `node main() { match (1) { 1 -> print("one") _ -> print("no") } }`],
    ["fat arrow in an inline block", `node main() { const ys = map(xs, \\n => n * 2) }`],
  ];

  for (const [name, src] of variations) {
    it(`formatting ${name} twice matches formatting it once`, () => {
      const once = formatSource(src);
      expect(once).not.toBeNull();
      expect(formatSource(once as string)).toBe(once);
    });
  }
});

function expectTrailingCommentFixedPoint(source: string, expected: string): void {
  const once = formatSource(source);
  expect(once).not.toBeNull();
  expect(once).toBe(expected);
  expect(formatSource(once as string)).toBe(once);
  expect(parseAgency(once as string, {}, false, false).success).toBe(true);
}

describe("complete-construct trailing comments", () => {
  it("preserves top-level and body comments", () => {
    expectTrailingCommentFixedPoint(
      `type UserId=string // id\nnode main(){\nconst x=5 // x\n}\n`,
      `type UserId = string // id\n\nnode main() {\n  const x = 5 // x\n}\n`,
    );
  });

  it("keeps comments with imports while sorting", () => {
    const formatted = formatSource(
      `import { z } from "./z" // z comment\nimport { a } from "./a" // a comment\n`,
    );
    expect(formatted).toContain(
      `import { a } from "./a" // a comment\nimport { z } from "./z" // z comment`,
    );
  });

  it("keeps a comment after a multiline call closing delimiter", () => {
    const source = `node main() {\n  save(\n    "a very long argument that keeps this call multiline",\n    "another very long argument that keeps this call multiline"\n  ) // whole call\n}\n`;
    const once = formatSource(source);
    expect(once).toContain(`\n  ) // whole call\n`);
    expect(formatSource(once as string)).toBe(once);
  });
});

describe("trailing comments in every body owner", () => {
  it.each([
    ["node", `node main() {\n  print(1) // c\n}\n`],
    ["function", `def f() {\n  print(1) // c\n}\n`],
    ["if", `node main() {\n  if (true) {\n    print(1) // c\n  }\n}\n`],
    ["else", `node main() {\n  if (true) {\n    print(2)\n  } else {\n    print(1) // c\n  }\n}\n`],
    ["while", `node main() {\n  while (true) {\n    print(1) // c\n  }\n}\n`],
    ["for", `node main() {\n  for (x in xs) {\n    print(1) // c\n  }\n}\n`],
    ["thread", `node main() {\n  thread {\n    print(1) // c\n  }\n}\n`],
    ["subthread", `node main() {\n  subthread {\n    print(1) // c\n  }\n}\n`],
    ["guard", `node main() {\n  guard() {\n    print(1) // c\n  }\n}\n`],
    ["handle", `node main() {\n  handle {\n    print(1) // c\n  } with approve\n}\n`],
    ["inline handler", `node main() {\n  handle {\n    print(2)\n  } with (answer) {\n    print(1) // c\n  }\n}\n`],
    ["finalize", `node main() {\n  finalize {\n    print(1) // c\n  }\n}\n`],
    ["parallel", `node main() {\n  parallel {\n    print(1) // c\n  }\n}\n`],
    ["seq", `node main() {\n  seq {\n    print(1) // c\n  }\n}\n`],
    ["destructive", `node main() {\n  destructive {\n    print(1) // c\n  }\n}\n`],
    ["block match arm", `node main() {\n  match (x) {\n    1 => {\n      print(1) // c\n    }\n  }\n}\n`],
    ["block argument", `node main() {\n  each(xs) as item {\n    print(1) // c\n  }\n}\n`],
    ["statement code literal", `def f(): Code {\n  return [| node main(): number {\n    print(1) // c\n    return 1\n  } |]\n}\n`],
  ])("preserves a trailing comment in a %s body", (_name, source) => {
    const once = formatSource(source);
    expect(once).toContain("print(1) // c");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  it("preserves a trailing comment on an inline match arm", () => {
    const source = `node main() {\n  match (x) {\n    1 => "one" // first\n    2 => "two" // second\n  }\n}\n`;
    const once = formatSource(source);
    expect(once).toContain(`1 => "one" // first`);
    expect(once).toContain(`2 => "two" // second`);
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });
});

/** Every triple-quoted string's text, so a formatting change that alters one
 *  shows up as a value difference rather than only as a layout difference. */
function multilineStringValues(source: string): string[] {
  const parsed = parseAgency(replaceBlankLines(source), {}, false, false);
  if (!parsed.success) {
    return ["<did not parse>"];
  }
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const node = value as { type?: unknown; segments?: unknown };
    if (node.type === "multiLineString" && Array.isArray(node.segments)) {
      values.push(
        node.segments
          .map((segment: { value?: string }) => segment.value ?? "")
          .join(""),
      );
    }
    Object.values(value as Record<string, unknown>).forEach(walk);
  };
  walk(parsed.result.nodes);
  return values;
}

describe("a multi-line item inside a wrapped list", () => {
  // The list wraps on length, so its items were already rendered as strings
  // at the outer indent. Only their first line used to be moved.
  it("indents an object literal's continuation lines with the list", () => {
    const source = `def f() {\n  return _bash(\n    command,\n    cwd,\n    timeout,\n    stdin,\n    {\n      blockedCommands: blockedCommands\n    },\n  )\n}\n`;
    const once = formatSource(source);
    expect(once).toContain(
      "    {\n      blockedCommands: blockedCommands\n    },",
    );
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  it("indents a nested array's continuation lines with the list", () => {
    const source = `def f() {\n  return someFunctionWithALongName(\n    firstArgument,\n    secondArgument,\n    [\n      1, // one\n      2\n    ],\n    thirdArgument\n  )\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("    [\n      1, // one\n      2\n    ],");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  // A triple-quoted string's newlines are DATA. Indenting them to match the
  // surrounding layout changes the value the program computes, which is a
  // far worse bug than the misalignment this suite is about.
  it("does not change a multiline string's value when the list wraps", () => {
    const source = `def f() {\n  return someFunctionWithAnExtremelyLongName(\n    firstArgument,\n    """line1\nline2""",\n    thirdArgument\n  )\n}\n`;
    const once = formatSource(source) as string;
    expect(once).not.toBeNull();
    expect(once).toContain('"""line1\nline2"""');
    expect(multilineStringValues(once)).toEqual(multilineStringValues(source));
    expect(formatSource(once)).toBe(once);
  });

  it("keeps an indented multiline string's own indentation", () => {
    const source = `def f() {\n  return someFunctionWithAnExtremelyLongName(\n    firstArgument,\n    """line1\n  indented""",\n    thirdArgument\n  )\n}\n`;
    const once = formatSource(source) as string;
    expect(multilineStringValues(once)).toEqual(multilineStringValues(source));
    expect(formatSource(once)).toBe(once);
  });

  it("leaves a blank line inside a wrapped item unindented", () => {
    const source = `def f() {\n  return someFunctionWithALongName(\n    firstArgument,\n    secondArgument,\n    {\n      a: 1,\n\n      b: 2\n    },\n    thirdArgument\n  )\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("\n\n      b: 2");
    expect(once).not.toContain("  \n");
    expect(formatSource(once as string)).toBe(once);
  });
});
