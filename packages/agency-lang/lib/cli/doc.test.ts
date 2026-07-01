import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateDoc } from "./doc.js";
import * as fs from "fs";
import * as path from "path";

const tmpDir = path.join(process.env.TMPDIR || "/tmp", "agency-doc-test");

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateDoc", () => {
  it("generates docs for a file with types, functions, and nodes", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "test.agency"),
      `
export type User = {
  name: string # The user's name;
  age: number # The user's age
}

type Internal = {
  id: string
}

export def greet(name: string): string {
  """Greet the user by name."""
  return "Hello, " + name
}

export def add(a: number, b: number): number {
  """
  Add two numbers together.
  """
  return a + b
}

node main() {
  uses greet
  const result = llm("Say hello")
  print(result)
}
`,
    );

    generateDoc({}, path.join(inputDir, "test.agency"), outputDir);

    const output = fs.readFileSync(path.join(outputDir, "test.md"), "utf-8");

    // Title
    expect(output).toContain("# test");

    // Types section — rendered as code fences via agency generator
    expect(output).toContain("## Types");
    expect(output).toContain("### User");
    expect(output).toContain("```ts\nexport type User =");
    expect(output).toContain("name: string # The user's name");
    expect(output).toContain("age: number # The user's age");
    expect(output).not.toContain("### Internal");

    // Functions section — heading is name only, signature in code fence
    expect(output).toContain("## Functions");
    expect(output).toContain("### greet");
    expect(output).toContain("```ts\ngreet(name: string): string\n```");
    expect(output).toContain("Greet the user by name.");
    expect(output).toContain("### add");
    expect(output).toContain("```ts\nadd(a: number, b: number): number\n```");
    expect(output).toContain("Add two numbers together.");
    expect(output).toContain("**Returns:** `number`");

    // Nodes section — heading is name only, signature in code fence
    expect(output).toContain("## Nodes");
    expect(output).toContain("### main");
    expect(output).toContain("```ts\nmain()\n```");
  });

  it("generates docs for a directory recursively", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    const subDir = path.join(inputDir, "agents");
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "utils.agency"),
      `
export def helper(): string {
  """A helper function."""
  return "help"
}
`,
    );

    fs.writeFileSync(
      path.join(subDir, "chat.agency"),
      `
node main() {
  print("hello")
}
`,
    );

    generateDoc({}, inputDir, outputDir);

    // Check files exist with mirrored structure
    expect(fs.existsSync(path.join(outputDir, "utils.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "agents", "chat.md"))).toBe(
      true,
    );

    const utilsDoc = fs.readFileSync(
      path.join(outputDir, "utils.md"),
      "utf-8",
    );
    expect(utilsDoc).toContain("### helper");
    expect(utilsDoc).toContain("```ts\nhelper(): string\n```");
    expect(utilsDoc).toContain("A helper function.");

    const chatDoc = fs.readFileSync(
      path.join(outputDir, "agents", "chat.md"),
      "utf-8",
    );
    expect(chatDoc).toContain("### main");
    expect(chatDoc).toContain("```ts\nmain()\n```");
  });

  it("omits empty sections", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "nodetonly.agency"),
      `
node main() {
  print("hello")
}
`,
    );

    generateDoc({}, path.join(inputDir, "nodetonly.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "nodetonly.md"),
      "utf-8",
    );

    expect(output).toContain("## Nodes");
    expect(output).not.toContain("## Types");
    expect(output).not.toContain("## Functions");
  });

  it("handles functions with default values", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "defaults.agency"),
      `
export def greet(name: string = "world"): string {
  return "Hello, " + name
}
`,
    );

    generateDoc({}, path.join(inputDir, "defaults.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "defaults.md"),
      "utf-8",
    );

    expect(output).toContain('| name | `string` | "world" |');
  });

  it("renders file-level doc comment after title", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "filedoc.agency"),
      `/** @module This file implements email categorization. */

import { helper } from "./helper.ts"

node main() {
  print("hello")
}
`,
    );

    generateDoc({}, path.join(inputDir, "filedoc.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "filedoc.md"),
      "utf-8",
    );

    expect(output).toContain("# filedoc");
    expect(output).toContain("This file implements email categorization.");
    // File doc should come before nodes section
    const fileDocIndex = output.indexOf("This file implements email categorization.");
    const nodesIndex = output.indexOf("## Nodes");
    expect(fileDocIndex).toBeLessThan(nodesIndex);
  });

  it("renders doc comment and docstring on a function (docstring first)", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "funcdoc.agency"),
      `/** Extra context for docs. */
export def add(a: number, b: number): number {
  """Adds two numbers."""
  return a + b
}
`,
    );

    generateDoc({}, path.join(inputDir, "funcdoc.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "funcdoc.md"),
      "utf-8",
    );

    expect(output).toContain("Adds two numbers.");
    expect(output).toContain("Extra context for docs.");
    // Docstring should come before doc comment
    const docstringIndex = output.indexOf("Adds two numbers.");
    const docCommentIndex = output.indexOf("Extra context for docs.");
    expect(docstringIndex).toBeLessThan(docCommentIndex);
  });

  it("renders doc comment and docstring on a node (docstring first)", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "nodedoc.agency"),
      `/** Extra node context. */
node main() {
  """Main entry point."""
  print("hello")
}
`,
    );

    generateDoc({}, path.join(inputDir, "nodedoc.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "nodedoc.md"),
      "utf-8",
    );

    expect(output).toContain("Main entry point.");
    expect(output).toContain("Extra node context.");
    const docstringIndex = output.indexOf("Main entry point.");
    const docCommentIndex = output.indexOf("Extra node context.");
    expect(docstringIndex).toBeLessThan(docCommentIndex);
  });

  it("renders doc comment on a type alias", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "typedoc.agency"),
      `/** Possible message categories. */
export type Category = "reminder" | "todo"
`,
    );

    generateDoc({}, path.join(inputDir, "typedoc.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "typedoc.md"),
      "utf-8",
    );

    expect(output).toContain("Possible message categories.");
    expect(output).toContain("### Category");
  });

  it("handles type aliases that are not objects", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "simpletype.agency"),
      `
export type Status = "active" | "inactive"
`,
    );

    generateDoc({}, path.join(inputDir, "simpletype.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "simpletype.md"),
      "utf-8",
    );

    expect(output).toContain("### Status");
    expect(output).toContain('```ts\nexport type Status = "active" | "inactive"\n```');
  });

  it("omits non-exported type aliases", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "internaltype.agency"),
      `
type Internal = "hidden"
`,
    );

    generateDoc({}, path.join(inputDir, "internaltype.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "internaltype.md"),
      "utf-8",
    );

    expect(output).not.toContain("### Internal");
    expect(output).not.toContain('type Internal = "hidden"');
  });

  it("generates cross-file type links in directory mode", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "types.agency"),
      `export type User = {
  name: string
  age: number
}
`,
    );

    fs.writeFileSync(
      path.join(inputDir, "funcs.agency"),
      `export type Category = "a" | "b"

export def getCategory(): Category {
  return "a"
}
`,
    );

    generateDoc(
      { doc: { baseUrl: "https://example.com/src" } },
      inputDir,
      outputDir,
    );

    const funcsOutput = fs.readFileSync(
      path.join(outputDir, "funcs.md"),
      "utf-8",
    );

    // Return type Category is defined in same file — anchor link
    expect(funcsOutput).toContain("[Category](#category)");

    const typesOutput = fs.readFileSync(
      path.join(outputDir, "types.md"),
      "utf-8",
    );

    // Types file should have User with source link
    expect(typesOutput).toContain("### User");
  });

  it("documents the interrupt kinds a function or node may throw", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "throws.agency"),
      `
export def deploy(): string {
  interrupt myapp::deploy("deploying")
  return "ok"
}

export def helper(): string {
  return deploy()
}

export def safe(): string {
  return "no interrupts here"
}

node main() {
  interrupt myapp::confirm("confirm?")
  const r = helper()
  print(r)
}
`,
    );

    generateDoc({}, path.join(inputDir, "throws.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "throws.md"),
      "utf-8",
    );

    // Direct interrupt
    expect(output).toMatch(/### deploy[\s\S]*?\*\*Throws:\*\* `myapp::deploy`/);
    // Transitive — helper calls deploy
    expect(output).toMatch(/### helper[\s\S]*?\*\*Throws:\*\* `myapp::deploy`/);
    // Function with no interrupts has no Throws line — between `### safe`
    // and the next heading, "Throws:" must not appear.
    const safeBlock = output.match(/### safe[\s\S]*?(?=###|## )/);
    expect(safeBlock).not.toBeNull();
    expect(safeBlock![0]).not.toContain("Throws:");
    // Node combines its own + transitive
    expect(output).toMatch(
      /### main[\s\S]*?\*\*Throws:\*\* `myapp::confirm`, `myapp::deploy`/,
    );
  });

  it("shows @validate and @jsonSchema annotations on type aliases", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "annotated.agency"),
      `import { isEmail } from "std::validation"

@validate(isEmail)
@jsonSchema({ format: "email", description: "User email." })
export type Email = string
`,
    );

    generateDoc({}, path.join(inputDir, "annotated.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "annotated.md"),
      "utf-8",
    );

    // The type alias should appear with its annotations inline.
    expect(output).toContain("@validate(isEmail)");
    expect(output).toContain("@jsonSchema(");

    // Structured "Validators:" line should list the validator.
    expect(output).toMatch(/\*\*Validators:\*\* `isEmail`/);

    // JSON Schema metadata code block should include the object literal.
    expect(output).toContain("**JSON Schema metadata:**");
    expect(output).toMatch(/format:\s*"email"/);
  });

  it("includes exported constants in a Constants section", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "consts.agency"),
      `export static const VERSION = "1.0.0"
export static const limits = { max: 10 }

const internal = "not exported"
`,
    );

    generateDoc({}, path.join(inputDir, "consts.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "consts.md"),
      "utf-8",
    );

    expect(output).toContain("## Constants");
    expect(output).toContain("### VERSION");
    expect(output).toContain('"1.0.0"');
    expect(output).toContain("### limits");
    // Internal (non-exported) const should NOT appear.
    expect(output).not.toContain("### internal");
  });

  it("does not add source links when baseUrl is not configured", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "test.agency"),
      `def foo(): string {
  return "bar"
}
`,
    );

    generateDoc({}, path.join(inputDir, "test.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "test.md"),
      "utf-8",
    );

    expect(output).not.toContain("[View source]");
    expect(output).not.toContain("[source]");
  });

  it("emits YAML frontmatter with quoted name at the top", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(
      path.join(inputDir, "array.agency"),
      `def foo(): string { return "x" }\n`,
    );

    generateDoc({}, path.join(inputDir, "array.agency"), outputDir);
    const output = fs.readFileSync(path.join(outputDir, "array.md"), "utf-8");

    expect(output).toMatch(/^---\nname: "array"\n---\n\n# array\n/);
  });

  it("emits exactly one frontmatter block, at the very top", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(
      path.join(inputDir, "shell.agency"),
      `def bar(): string { return "y" }\n`,
    );

    generateDoc({}, path.join(inputDir, "shell.agency"), outputDir);
    const output = fs.readFileSync(path.join(outputDir, "shell.md"), "utf-8");

    const delimiterCount = (output.match(/^---$/gm) ?? []).length;
    expect(delimiterCount).toBe(2);
    expect(output.indexOf("---\n")).toBe(0);
  });

  it("derives frontmatter name from the input filename", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(
      path.join(inputDir, "ui.agency"),
      `def baz(): string { return "z" }\n`,
    );

    generateDoc({}, path.join(inputDir, "ui.agency"), outputDir);
    const output = fs.readFileSync(path.join(outputDir, "ui.md"), "utf-8");

    expect(output).toMatch(/^---\nname: "ui"\n---\n\n# ui\n/);
  });

  it("renders effect declarations under an Effects section with attached doc comments", () => {
    // Covers the new doc-section renderer end-to-end:
    //   * the `## Effects` heading appears,
    //   * each declaration becomes an `### <effect>` subsection,
    //   * the agency-formatted body is fenced,
    //   * the preceding doc comment is attached and rendered.
    // Without this, a regression deleting either `generateEffectSection`
    // or the docComment branch would slip through unnoticed.
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(
      path.join(inputDir, "effects.agency"),
      `/** Reads files from a directory. */
effect std::read { dir: string }

node main() { print("hi") }
`,
    );

    generateDoc({}, path.join(inputDir, "effects.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "effects.md"),
      "utf-8",
    );

    expect(output).toContain("## Effects");
    expect(output).toContain("### std::read");
    expect(output).toContain("Reads files from a directory.");
    // The agency-formatted body appears inside a `ts` fence (the doc
    // comment is re-emitted there too, matching the type-alias renderer).
    expect(output).toMatch(/```ts[\s\S]*?effect std::read\s*\{/);
    expect(output).toMatch(/dir: string/);
  });
});
