import { describe, it, expect } from "vitest";
import {
  _ghApiPath,
  _ghParseApiPath,
  _ghParseRepoFlag,
  _ghParseTarget,
  _ghSearchQuery,
} from "./safeBashGh.js";

describe("_ghParseApiPath", () => {
  it.each([
    ["repos/o/r/pulls/5", "prGet", "o", "r", 5, 30, 1],
    ["/repos/o/r/pulls/5", "prGet", "o", "r", 5, 30, 1],
    ["repos/{owner}/{repo}/pulls/5/comments", "prReviewCommentList", "", "", 5, 30, 1],
    ["repos/o/r/pulls/5/files?per_page=100&page=2", "prFiles", "o", "r", 5, 100, 2],
    ["repos/o/r/pulls/5/reviews", "prReviewList", "o", "r", 5, 30, 1],
    ["repos/o/r/issues/7", "issueGet", "o", "r", 7, 30, 1],
    ["repos/o/r/issues/7/comments?page=3", "issueCommentList", "o", "r", 7, 30, 3],
  ] as const)("reads %s", (text, endpoint, owner, repo, number, perPage, page) => {
    expect(_ghParseApiPath(text)).toEqual({ endpoint, owner, repo, number, perPage, page });
  });

  it.each([
    // One placeholder and one name: gh would fill the placeholder itself.
    "repos/{owner}/r/pulls/5",
    // Paths that are not one of the six reads.
    "repos/o/r/pulls/5/merge",
    "repos/o/r/pulls",
    "repos/o/r/issues/7/labels",
    "user",
    "graphql",
    // Paging out of range, an unknown key, or a key given twice.
    "repos/o/r/pulls/5/files?per_page=101",
    "repos/o/r/pulls/5/files?per_page=0",
    "repos/o/r/pulls/5/files?page=0",
    "repos/o/r/pulls/5/files?state=all",
    "repos/o/r/pulls/5/files?per_page=5&per_page=6",
    // A single pull request or issue has no pages.
    "repos/o/r/pulls/5?page=1",
    // A bad number or name.
    "repos/o/r/pulls/0",
    "repos/o/r/pulls/abc",
    "repos/_bad/r/pulls/5",
    "repos/o/r%2F..%2Fx/pulls/5",
  ])("refuses %j", (text) => {
    expect(() => _ghParseApiPath(text)).toThrow();
  });

  // Past Number.MAX_SAFE_INTEGER the number is not the digits written:
  // the payload would show 1e+22 or Infinity, and that is what would run.
  it.each([
    ["a pull request number", "repos/o/r/pulls/9999999999999999999999"],
    ["a page", `repos/o/r/pulls/5/files?page=${"9".repeat(400)}`],
  ])("refuses %s too large to write back exactly", (_name, text) => {
    expect(() => _ghParseApiPath(text)).toThrow(/whole number|takes a number/);
  });
});

describe("_ghApiPath", () => {
  it("writes the names and both paging values into a list path", () => {
    const read = _ghParseApiPath("repos/{owner}/{repo}/pulls/5/comments");
    expect(_ghApiPath(read, "o", "r")).toBe("repos/o/r/pulls/5/comments?per_page=30&page=1");
  });

  it("writes no query string for a single pull request or issue", () => {
    expect(_ghApiPath(_ghParseApiPath("/repos/o/r/issues/7"), "o", "r")).toBe("repos/o/r/issues/7");
  });
});

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
