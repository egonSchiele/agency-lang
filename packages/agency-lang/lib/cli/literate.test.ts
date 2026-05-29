import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateLiterate } from "./literate.js";
import * as fs from "fs";
import * as path from "path";

const tmpDir = path.join(process.env.TMPDIR || "/tmp", "agency-literate-test");

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeInput(name: string, contents: string): string {
  const inputDir = path.join(tmpDir, "in");
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPath = path.join(inputDir, name);
  fs.writeFileSync(inputPath, contents);
  return inputPath;
}

function weaveAndRead(
  name: string,
  contents: string,
  opts: { lang?: string } = {},
): string {
  const inputPath = writeInput(name, contents);
  const outputDir = path.join(tmpDir, "out");
  generateLiterate(
    {},
    inputPath,
    outputDir,
    [],
    opts.lang ?? "agency",
  );
  const outName = name.replace(/\.agency$/, ".md");
  return fs.readFileSync(path.join(outputDir, outName), "utf-8");
}

describe("generateLiterate (weave)", () => {
  it("turns a block comment into prose and code into a fence", () => {
    const md = weaveAndRead(
      "test.agency",
      `/* hello */

def foo(): number {
  return 1
}
`,
    );

    // prose is plain text
    expect(md).toContain("hello");

    // code goes in an agency fence
    expect(md).toContain("```agency");
    expect(md).toContain("def foo");

    // prose appears BEFORE the fence (positional check)
    const proseIdx = md.indexOf("hello");
    const fenceIdx = md.indexOf("```agency");
    expect(proseIdx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeGreaterThan(proseIdx);

    // and "hello" must not be inside the fence
    const fenceEndIdx = md.indexOf("```", fenceIdx + 3);
    expect(md.substring(fenceIdx, fenceEndIdx)).not.toContain("hello");
  });

  it("turns a doc comment (/** */) into prose, not into a fence", () => {
    const md = weaveAndRead(
      "test.agency",
      `/** docs */

def foo(): number {
  return 1
}
`,
    );

    // The "docs" string must appear outside any fence.
    const fenceIdx = md.indexOf("```agency");
    expect(fenceIdx).toBeGreaterThan(0);
    const fenceEndIdx = md.indexOf("```", fenceIdx + 3);
    const fenceContent = md.substring(fenceIdx, fenceEndIdx + 3);
    expect(fenceContent).not.toContain("docs");

    // And it must appear before the fence as prose.
    const docsIdx = md.indexOf("docs");
    expect(docsIdx).toBeGreaterThanOrEqual(0);
    expect(docsIdx).toBeLessThan(fenceIdx);
  });

  it("module-level doc comment appears once as the first prose paragraph", () => {
    const md = weaveAndRead(
      "test.agency",
      `/** module docs */

def foo(): number {
  return 1
}
`,
    );

    // Exactly one occurrence (regression guard against double-emitting from
    // program.docComment AND the multiLineComment node).
    const occurrences = md.split("module docs").length - 1;
    expect(occurrences).toBe(1);

    // And it must be the first thing in the output (no fence before it).
    const firstFenceIdx = md.indexOf("```");
    const docsIdx = md.indexOf("module docs");
    expect(docsIdx).toBeGreaterThanOrEqual(0);
    expect(docsIdx).toBeLessThan(firstFenceIdx);
  });

  it("line comments stay inside the code fence", () => {
    const md = weaveAndRead(
      "test.agency",
      `def foo(): number {
  // inline comment here
  return 1
}
`,
    );

    const fenceIdx = md.indexOf("```agency");
    const fenceEndIdx = md.indexOf("```", fenceIdx + 3);
    const fenceContent = md.substring(fenceIdx, fenceEndIdx + 3);
    expect(fenceContent).toContain("// inline comment here");
  });

  it("adjacent block comments merge with a paragraph break", () => {
    const md = weaveAndRead(
      "test.agency",
      `/* a */

/* b */
`,
    );

    // No fence at all — only prose.
    expect(md).not.toContain("```");

    // The two prose chunks are joined by "\n\n".
    const aIdx = md.indexOf("a");
    const bIdx = md.indexOf("b");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(md.substring(aIdx, bIdx + 1)).toContain("\n\n");
  });

  it("--lang flag flows through to the fence language tag", () => {
    const md = weaveAndRead(
      "test.agency",
      `def foo(): number { return 1 }
`,
      { lang: "typescript" },
    );

    expect(md).toContain("```typescript");
    expect(md).not.toContain("```agency");
  });

  it("mirrors the tree for directory input", () => {
    const inputDir = path.join(tmpDir, "src");
    const nestedDir = path.join(inputDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, "a.agency"),
      `def a(): number { return 1 }\n`,
    );
    fs.writeFileSync(
      path.join(nestedDir, "b.agency"),
      `def b(): number { return 2 }\n`,
    );

    const outputDir = path.join(tmpDir, "out");
    generateLiterate({}, inputDir, outputDir, [], "agency");

    expect(fs.existsSync(path.join(outputDir, "a.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "nested", "b.md"))).toBe(true);
  });

  it("produces an empty .md for an empty input file", () => {
    const md = weaveAndRead("empty.agency", "");
    expect(md).toBe("");
  });

  it("escalates the fence delimiter when the code contains triple backticks", () => {
    // Block comment containing ``` ends up as prose, not code — so to
    // exercise escalation through codeFence we need backticks inside a
    // CODE node. A doc-string is the simplest way to get a string with
    // backticks into the code segment.
    const md = weaveAndRead(
      "test.agency",
      "def foo(): string {\n" +
        '  """contains ``` triple backticks"""\n' +
        '  return "x"\n' +
        "}\n",
    );

    // The surrounding fence must be at least 4 backticks so the inner
    // ``` doesn't terminate it prematurely.
    expect(md).toMatch(/^````+agency\n/m);
    expect(md).toMatch(/\n````+\n?$/);
  });

  it("escalates the fence delimiter to 5 backticks when content has 4", () => {
    const md = weaveAndRead(
      "test.agency",
      "def foo(): string {\n" +
        '  """contains ```` four backticks"""\n' +
        '  return "x"\n' +
        "}\n",
    );

    expect(md).toMatch(/^`````+agency\n/m);
  });

  it("strips JSDoc-style leading `*` from multi-line block comments", () => {
    const md = weaveAndRead(
      "test.agency",
      `/**
 * Line one
 *
 * Line two
 */

def foo(): number { return 1 }
`,
    );

    // The leading " * " on each line is gone; paragraphs are preserved.
    expect(md).toContain("Line one");
    expect(md).toContain("Line two");
    expect(md).not.toMatch(/^\s*\*\s+Line/m);

    // The two paragraphs are separated by a blank line.
    const oneIdx = md.indexOf("Line one");
    const twoIdx = md.indexOf("Line two");
    expect(md.substring(oneIdx, twoIdx)).toContain("\n\n");
  });

  it("preserves markdown bullets (leading `*` after the JSDoc decoration)", () => {
    const md = weaveAndRead(
      "test.agency",
      `/**
 * Items:
 * * one
 * * two
 */
`,
    );

    // After stripping the JSDoc decoration, the inner "* one" / "* two"
    // markdown bullets remain.
    expect(md).toContain("Items:");
    expect(md).toContain("* one");
    expect(md).toContain("* two");
  });

  it("leaves single-line block comments alone", () => {
    const md = weaveAndRead("test.agency", `/* a * b */\n`);
    // The internal "*" is untouched.
    expect(md).toContain("a * b");
  });

  it("preserves source order of imports (no hoisting, no alphabetical sort)", () => {
    const md = weaveAndRead(
      "test.agency",
      `import { zebra } from "z"
import { apple } from "a"

def hello(): string {
  return "world"
}
`,
    );

    // Without preserveOrder, AgencyGenerator would alphabetize these
    // imports — "apple" would come before "zebra". Pin source order.
    const zebraIdx = md.indexOf("zebra");
    const appleIdx = md.indexOf("apple");
    expect(zebraIdx).toBeGreaterThan(0);
    expect(appleIdx).toBeGreaterThan(0);
    expect(zebraIdx).toBeLessThan(appleIdx);
  });

  it("preserves imports placed mid-file (no hoisting)", () => {
    const md = weaveAndRead(
      "test.agency",
      `def first(): number { return 1 }

import { later } from "wherever"

def second(): number { return 2 }
`,
    );

    // The mid-file import must appear AFTER first() and BEFORE second().
    const firstIdx = md.indexOf("def first");
    const importIdx = md.indexOf("import { later }");
    const secondIdx = md.indexOf("def second");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeGreaterThan(importIdx);
  });

  it("smoke-tests against stdlib/markdown.agency (real-world AST)", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const input = path.join(repoRoot, "stdlib", "markdown.agency");
    // Sanity: only run if the fixture exists in this checkout.
    if (!fs.existsSync(input)) return;

    const outputDir = path.join(tmpDir, "out");
    generateLiterate({}, input, outputDir, [], "agency");

    const md = fs.readFileSync(path.join(outputDir, "markdown.md"), "utf-8");
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("```agency");
  });
});
