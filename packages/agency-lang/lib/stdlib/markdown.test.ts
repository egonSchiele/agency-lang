import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { _parseFrontmatter, _parseMarkdown } from "./markdown.js";

/** What `frontmatter()` returned when it parsed the whole document: the
 *  data of its frontmatter block, or null when there was none. */
function frontmatterFromWholeDocument(input: string): unknown {
  const parsed = _parseMarkdown(input);
  if (!parsed.success) return null;
  const block = parsed.blocks.find((b) => (b as { type: string }).type === "frontmatter");
  return block ? (block as unknown as { data: unknown }).data : null;
}

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(dir, name));
}

const packageRoot = path.resolve(__dirname, "../..");

describe("_parseFrontmatter", () => {
  it("reads the header fields, values and inline lists included", () => {
    const input = [
      "---",
      "name: debug-run",
      "description: \"Find out: why a run failed\"",
      "tags: [one, two]",
      "count: 3",
      "user-invocable: false",
      "---",
      "",
      "# Body",
      "",
      "Long text the header doesn't need.",
    ].join("\n");
    expect(_parseFrontmatter(input)).toEqual({
      success: true,
      data: {
        name: "debug-run",
        description: "Find out: why a run failed",
        tags: ["one", "two"],
        count: 3,
        "user-invocable": false,
      },
      error: "",
    });
  });

  it("fails as missing with no header, an unclosed one, or one not at the start", () => {
    for (const input of ["# Just a doc", "---\nname: x\nnever closed", "\n---\nname: x\n---\n"]) {
      expect(_parseFrontmatter(input)).toEqual({
        success: false,
        data: {},
        error: "no frontmatter",
      });
    }
  });

  // The header parser is the one the whole-document parser runs first, so
  // the two must agree on every real file: the fixtures and bundled skills.
  it("matches the whole-document parse on every Markdown fixture and skill", () => {
    const files = [
      ...markdownFiles(path.join(packageRoot, "tests")),
      ...markdownFiles(path.join(packageRoot, "skills")),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const input = fs.readFileSync(file, "utf8");
      const header = _parseFrontmatter(input);
      expect(header.success ? header.data : null, file).toEqual(frontmatterFromWholeDocument(input));
    }
  });
});
