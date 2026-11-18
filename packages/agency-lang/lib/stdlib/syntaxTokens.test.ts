import { describe, it, expect } from "vitest";
import { _diffTokens, _highlightTokens } from "./syntaxTokens.js";
import type { CodeToken, DiffTokenLine } from "./syntaxTokens.js";

const textOf = (tokens: CodeToken[]): string => tokens.map((token) => token.text).join("");

const scopeOf = (tokens: CodeToken[], text: string): string | null | undefined =>
  tokens.find((token) => token.text === text)?.scope;

describe("_highlightTokens", () => {
  it("tags each piece of code with its kind of syntax", () => {
    const tokens = _highlightTokens("const a = 1", "typescript");
    expect(textOf(tokens)).toBe("const a = 1");
    expect(scopeOf(tokens, "const")).toBe("keyword");
    expect(scopeOf(tokens, "1")).toBe("number");
  });

  it("names a kind like the ColorScheme field for it", () => {
    // highlight.js calls this class "built_in"; ColorScheme calls it builtIn.
    const tokens = _highlightTokens("print(len(x))", "python");
    expect(tokens.map((token) => token.scope)).toContain("builtIn");
  });

  it("gives text inside a nested kind the innermost kind", () => {
    const tokens = _highlightTokens("const s = `a${b}`", "typescript");
    expect(scopeOf(tokens, "${b}")).toBe("subst");
    expect(textOf(tokens)).toBe("const s = `a${b}`");
  });

  it("keeps a multi-line comment as one comment token", () => {
    const code = "/* one\ntwo */\nx";
    const tokens = _highlightTokens(code, "typescript");
    expect(textOf(tokens)).toBe(code);
    expect(scopeOf(tokens, "/* one\ntwo */")).toBe("comment");
  });

  it("joins neighboring pieces of the same kind", () => {
    const tokens = _highlightTokens("a b c", "plaintext");
    expect(tokens).toEqual([{ text: "a b c", scope: null }]);
  });

  it("reads agency code as TypeScript", () => {
    expect(scopeOf(_highlightTokens("const a = 1", "agency"), "const")).toBe("keyword");
  });

  it("returns plain text for a language it does not know", () => {
    expect(_highlightTokens("whatever here", "no-such-language")).toEqual([
      { text: "whatever here", scope: null },
    ]);
  });

  it("guesses the language for auto", () => {
    const tokens = _highlightTokens('def greet(name):\n    return f"hi {name}"\n', "auto");
    expect(scopeOf(tokens, "def")).toBe("keyword");
  });

  it("returns plain text when highlight.js loses some of the code", () => {
    // highlight.js 10 drops the newline inside this CSS attribute selector.
    expect(_highlightTokens("a[\nhref] {}", "css")).toEqual([
      { text: "a[\nhref] {}", scope: null },
    ]);
  });

  it("returns no tokens for empty code", () => {
    expect(_highlightTokens("", "typescript")).toEqual([]);
  });
});

describe("_diffTokens", () => {
  const lineText = (line: DiffTokenLine): string => textOf(line.tokens);
  const changedText = (line: DiffTokenLine): string =>
    line.tokens
      .filter((token) => token.changed)
      .map((token) => token.text)
      .join("");

  it("returns the changed lines with their numbers and kinds", () => {
    const hunks = _diffTokens("const x = 1", "const x = 2", -1, false, "typescript");
    expect(hunks).toHaveLength(1);
    const [removed, added] = hunks[0].lines;
    expect(removed).toMatchObject({ kind: "delete", oldNumber: 1, newNumber: null });
    expect(added).toMatchObject({ kind: "insert", oldNumber: null, newNumber: 1 });
    expect(lineText(removed)).toBe("const x = 1");
    expect(lineText(added)).toBe("const x = 2");
  });

  it("marks the words that changed on a replaced line", () => {
    const [removed, added] = _diffTokens("const x = 1", "const x = 2", -1, false, "typescript")[0]
      .lines;
    expect(changedText(removed)).toBe("1");
    expect(changedText(added)).toBe("2");
    expect(removed.tokens.find((token) => token.text === "const")).toEqual({
      text: "const",
      scope: "keyword",
      changed: false,
    });
  });

  it("marks nothing as changed on an unchanged line or a line with no partner", () => {
    const lines = _diffTokens("keep", "keep\nnew line", -1, false, "")[0].lines;
    expect(lines.map((line) => line.kind)).toEqual(["context", "insert"]);
    expect(lines.every((line) => changedText(line) === "")).toBe(true);
  });

  it("has no kinds of syntax when no language is given", () => {
    const lines = _diffTokens("const x = 1", "const x = 2", -1, false, "")[0].lines;
    expect(lines.flatMap((line) => line.tokens).every((token) => token.scope === null)).toBe(true);
  });

  it("highlights each side as a whole, so a comment over several lines stays a comment", () => {
    const before = "/* start\nmiddle\nend */\nlet a = 1";
    const after = "/* start\nmiddle\nend */\nlet a = 2";
    const lines = _diffTokens(before, after, -1, false, "typescript")[0].lines;
    const middle = lines.find((line) => lineText(line) === "middle");
    expect(middle?.tokens).toEqual([{ text: "middle", scope: "comment", changed: false }]);
  });

  it("splits into hunks with the requested context, as diff does", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh";
    const after = "A\nb\nc\nd\ne\nf\ng\nH";
    const hunks = _diffTokens(before, after, 1, false, "");
    expect(
      hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
    ).toEqual([
      [1, 2, 1, 2],
      [7, 2, 7, 2],
    ]);
  });

  it("returns no hunks for two empty texts", () => {
    expect(_diffTokens("", "", -1, false, "typescript")).toEqual([]);
  });

  it("returns one hunk of unchanged lines for identical texts with full context", () => {
    const hunks = _diffTokens("a\nb", "a\nb", -1, false, "");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((line) => line.kind)).toEqual(["context", "context"]);
  });

  it("keeps every line in place when highlight.js drops a character", () => {
    // highlight.js 10 loses the newline inside this CSS attribute selector.
    const before = "a[\nhref] {}\nb {}";
    const after = "a[\nhref] {}\nb { color: red; }";
    const lines = _diffTokens(before, after, -1, false, "css")[0].lines;
    expect(lines.map(lineText)).toEqual(["a[", "href] {}", "b {}", "b { color: red; }"]);
  });
});
