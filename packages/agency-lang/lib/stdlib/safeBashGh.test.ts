import { describe, it, expect } from "vitest";
import { _ghParseRepoFlag, _ghParseTarget } from "./safeBashGh.js";

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
