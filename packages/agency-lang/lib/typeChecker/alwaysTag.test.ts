import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { readAlwaysScope, hasAlwaysScope } from "./alwaysTag.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";

/** Parse one source string and return its first effect declaration with
 *  tags attached the way the compiler sees them. `attachTags()` is the
 *  public tag-attachment step; the full `preprocess()` needs a
 *  compilation unit and is not required here. */
function declOf(src: string): EffectDeclaration {
  const parsed = parseAgency(src);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  new TypescriptPreprocessor(parsed.result).attachTags();
  const decl = parsed.result.nodes.find((node) => node.type === "effectDeclaration");
  if (!decl) {
    throw new Error("no effect declaration");
  }
  return decl as EffectDeclaration;
}

describe("readAlwaysScope", () => {
  it("returns no fields for an untagged declaration", () => {
    const scope = readAlwaysScope(declOf("effect app::x { a: string }").tags);
    expect(scope).toEqual({ fields: [], problems: [] });
  });

  it("reads exact fields from @always", () => {
    const scope = readAlwaysScope(
      declOf("@always(command, cwd)\neffect app::x { command: string, cwd: string }").tags,
    );
    expect(scope.fields).toEqual([
      { field: "command", matchSubpaths: false },
      { field: "cwd", matchSubpaths: false },
    ]);
    expect(scope.problems).toEqual([]);
  });

  it("reads subpath fields from @alwaysUnder", () => {
    const scope = readAlwaysScope(declOf("@alwaysUnder(dir)\neffect app::x { dir: string }").tags);
    expect(scope.fields).toEqual([{ field: "dir", matchSubpaths: true }]);
  });

  it("combines both tags, exact first, regardless of tag order", () => {
    const scope = readAlwaysScope(
      declOf("@alwaysUnder(dir)\n@always(name)\neffect app::x { name: string, dir: string }").tags,
    );
    expect(scope.fields.map((field) => field.field)).toEqual(["name", "dir"]);
  });

  it("reports a non-identifier argument", () => {
    const scope = readAlwaysScope(declOf('@always("name")\neffect app::x { name: string }').tags);
    expect(scope.fields).toEqual([]);
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["badArgument"]);
  });

  it("reports a repeated tag", () => {
    const scope = readAlwaysScope(
      declOf("@always(a)\n@always(b)\neffect app::x { a: string, b: string }").tags,
    );
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["repeatedTag"]);
  });

  it("reports a field named in both tags", () => {
    const scope = readAlwaysScope(
      declOf("@always(dir)\n@alwaysUnder(dir)\neffect app::x { dir: string }").tags,
    );
    // One problem per tag that names the field, so both tags get a location.
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["namedTwice", "namedTwice"]);
  });

  it("reports a field named twice in one tag", () => {
    const scope = readAlwaysScope(declOf("@always(a, a)\neffect app::x { a: string }").tags);
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["namedTwice"]);
  });

  it("treats an empty tag as a tagged declaration with no fields", () => {
    const tags = declOf("@always()\neffect app::x { a: string }").tags;
    expect(readAlwaysScope(tags)).toEqual({ fields: [], problems: [] });
    expect(hasAlwaysScope(tags)).toBe(true);
  });

  it("ignores unrelated tags", () => {
    const tags = declOf("@hidden\n@always(a)\neffect app::x { a: string }").tags;
    expect(readAlwaysScope(tags).fields).toEqual([{ field: "a", matchSubpaths: false }]);
    expect(hasAlwaysScope(declOf("@hidden\neffect app::y { a: string }").tags)).toBe(false);
  });
});
