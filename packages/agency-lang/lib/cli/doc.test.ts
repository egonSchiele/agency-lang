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
type User = {
  name: string # The user's name;
  age: number # The user's age
}

def greet(name: string): string {
  """Greet the user by name."""
  return "Hello, " + name
}

def add(a: number, b: number): number {
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
    expect(output).toContain("```ts\ntype User =");
    expect(output).toContain("name: string # The user's name");
    expect(output).toContain("age: number # The user's age");

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
def helper(): string {
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
def greet(name: string = "world"): string {
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
def add(a: number, b: number): number {
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
type Category = "reminder" | "todo"
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
type Status = "active" | "inactive"
`,
    );

    generateDoc({}, path.join(inputDir, "simpletype.agency"), outputDir);
    const output = fs.readFileSync(
      path.join(outputDir, "simpletype.md"),
      "utf-8",
    );

    expect(output).toContain("### Status");
    expect(output).toContain('```ts\ntype Status = "active" | "inactive"\n```');
  });

  it("generates cross-file type links in directory mode", () => {
    const inputDir = path.join(tmpDir, "input");
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(inputDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "types.agency"),
      `type User = {
  name: string
  age: number
}
`,
    );

    fs.writeFileSync(
      path.join(inputDir, "funcs.agency"),
      `type Category = "a" | "b"

def getCategory(): Category {
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
});
