import { describe, it, expect } from "vitest";
import { _ghParseRepoFlag, _ghParseTarget, _ghSearchQuery } from "./safeBashGh.js";

describe("_ghParseTarget", () => {
  it("reads a bare number, with no repository", () => {
    expect(_ghParseTarget("1451", "pull")).toEqual({ number: 1451, owner: "", repo: "" });
  });

  it("reads a pull request URL, with its repository", () => {
    expect(_ghParseTarget("https://github.com/egonSchiele/agency-lang/pull/1451", "pull")).toEqual({
      number: 1451,
      owner: "egonSchiele",
      repo: "agency-lang",
    });
  });

  it("reads an issue URL, with its repository", () => {
    expect(_ghParseTarget("https://github.com/o/r/issues/7", "issues")).toEqual({
      number: 7,
      owner: "o",
      repo: "r",
    });
  });

  it("refuses a pull request URL where an issue is wanted", () => {
    expect(() =>
      _ghParseTarget("https://github.com/egonSchiele/agency-lang/pull/1451", "issues"),
    ).toThrow();
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "abc",
    "",
    "https://ghe.example.com/o/r/pull/1",
    "https://github.com/o/r/pull/1/files",
    "https://github.com/_bad/r/pull/1",
    "https://github.com/o/r/pull/0",
  ])("refuses %j", (text) => {
    expect(() => _ghParseTarget(text, "pull")).toThrow();
  });
});

describe("_ghParseRepoFlag", () => {
  it("reads OWNER/REPO", () => {
    expect(_ghParseRepoFlag("o/r")).toEqual({ owner: "o", repo: "r" });
  });

  it("reads github.com/OWNER/REPO", () => {
    expect(_ghParseRepoFlag("github.com/o/r")).toEqual({ owner: "o", repo: "r" });
  });

  it.each([
    "ghe.example.com/o/r",
    "https://github.com/o/r",
    "o",
    "o/r/x/y",
    "../x",
    "o/r; rm -rf x",
    "o/r,other/x",
    "_bad/r",
    "",
  ])("refuses %j", (text) => {
    expect(() => _ghParseRepoFlag(text)).toThrow();
  });
});

describe("_ghSearchQuery", () => {
  const scope = { repo: ["o/r"], type: ["issue"] };

  it("puts the words in parentheses before the qualifiers", () => {
    expect(_ghSearchQuery(["crash"], scope)).toBe("( crash ) repo:o/r type:issue");
  });

  it("quotes a word with a space, as a phrase", () => {
    expect(_ghSearchQuery(["crash bug"], { ...scope, state: ["closed"] })).toBe(
      '( "crash bug" ) repo:o/r state:closed type:issue',
    );
  });

  it("quotes only the value of a word with a colon", () => {
    expect(_ghSearchQuery(["label:a b"], scope)).toBe('( label:"a b" ) repo:o/r type:issue');
  });

  it("sorts the qualifiers by name and joins several --match fields with OR", () => {
    const query = _ghSearchQuery(["crash", "in:title"], {
      ...scope,
      author: ["dana"],
      assignee: [],
      in: ["title", "body"],
      label: ["bug", "a b"],
    });
    expect(query).toBe(
      '( crash in:title ) author:dana (in:body OR in:title) label:"a b" label:bug repo:o/r type:issue',
    );
  });

  it("sorts values in code point order, as gh does, not in UTF-16 order", () => {
    expect(_ghSearchQuery(["crash"], { ...scope, label: ["😀", "Ａ"] })).toBe(
      "( crash ) label:Ａ label:😀 repo:o/r type:issue",
    );
  });

  it("leaves out type:issue when it is not given (--include-prs)", () => {
    expect(_ghSearchQuery(["crash"], { repo: ["o/r"], type: [] })).toBe("( crash ) repo:o/r");
  });

  it.each(["a)", "(b", 'say "hi"', "a\\b", "tab\there", "nb sp", "zero​width", ""])(
    "refuses the word %j",
    (word) => {
      expect(() => _ghSearchQuery([word], scope)).toThrow();
    },
  );

  it("refuses a filter value it cannot write the way gh does", () => {
    expect(() => _ghSearchQuery(["crash"], { ...scope, author: ["x)"] })).toThrow();
  });
});
