// Text handling for safeBash's `gh` rule. Each function throws an Error that
// says what is wrong, and the Agency side turns the throw into the plan's
// broad reason, so a refused line tells the model why.
import { _ghCheckNumber } from "./github/args.js";
import { checkRepoCoord, type RepoCoord } from "./github/repo.js";

export type GhTarget = { number: number; owner: string; repo: string };

const DIGITS = /^[0-9]+$/;
const TARGET_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/([0-9]+)$/;
const REPO_FLAG = /^(?:github\.com\/)?([^/]+)\/([^/]+)$/;

/** `1451`, or `https://github.com/OWNER/REPO/pull/1451` (also `/issues/`).
 *  owner and repo are "" for a bare number. */
export function _ghParseTarget(text: string, kind: "pull" | "issues"): GhTarget {
  if (DIGITS.test(text)) {
    const number = Number(text);
    _ghCheckNumber(number);
    return { number, owner: "", repo: "" };
  }
  const url = TARGET_URL.exec(text);
  if (url === null) {
    throw new Error(
      `Expected a number or a https://github.com/OWNER/REPO/${kind}/N URL, got "${text}".`,
    );
  }
  if (url[3] !== kind) {
    throw new Error(`Expected a /${kind}/ URL, got "${text}".`);
  }
  const number = Number(url[4]);
  _ghCheckNumber(number);
  const coord = checkRepoCoord({ owner: url[1], repo: url[2] });
  return { number, owner: coord.owner, repo: coord.repo };
}

/** `OWNER/REPO` or `github.com/OWNER/REPO`, the value of `--repo` or `-R`. */
export function _ghParseRepoFlag(text: string): RepoCoord {
  const match = REPO_FLAG.exec(text);
  if (match === null) {
    throw new Error(`--repo takes OWNER/REPO or github.com/OWNER/REPO, got "${text}".`);
  }
  return checkRepoCoord({ owner: match[1], repo: match[2] });
}

/** The qualifiers `gh search issues` puts in its query, by name. An empty
 *  list leaves the qualifier out. */
export type GhSearchQualifiers = Record<string, string[]>;

// The qualifiers gh joins with OR: several `--match` fields, and several
// `--repo` values (safeBash passes one).
const OR_QUALIFIERS = ["in", "repo"];

// gh quotes a word or value that holds one of these.
const NEEDS_QUOTES = /[ "\t\r\n]/;

// Parentheses would close the group gh wraps the words in, so
// `a) OR (b` could put an OR outside the repository filter. The other
// characters are quoted differently by gh (Go's %q) than by plain double
// quotes: a quote, a backslash, a control or format character, and any
// space character but a plain space.
const REFUSED = /[()"\\]|\p{C}|(?! )\p{Z}/u;

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text}"` : text;
}

function checkSearchText(text: string): void {
  if (text === "") {
    throw new Error("A gh search word or filter value is empty.");
  }
  if (REFUSED.test(text)) {
    throw new Error(
      `"${text}" holds a parenthesis, a quote, a backslash, or a special space or control character.`,
    );
  }
}

/** `key:value`, quoting only the value, as gh does for a word with a colon. */
function keyword(text: string): string {
  const colon = text.indexOf(":");
  if (colon < 0) {
    return quote(text);
  }
  return `${text.slice(0, colon)}:${quote(text.slice(colon + 1))}`;
}

/** Go sorts strings by their UTF-8 bytes, which is Unicode code point
 *  order. JavaScript's default sort compares UTF-16 units, which puts an
 *  emoji before `Ａ` (U+FF21) where Go puts it after. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index].codePointAt(0)! - right[index].codePointAt(0)!;
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function qualifierTerms(name: string, values: string[]): string[] {
  const terms = values.map((value) => `${name}:${quote(value)}`).sort(compareCodePoints);
  if (OR_QUALIFIERS.includes(name) && terms.length > 1) {
    return [`(${terms.join(" OR ")})`];
  }
  return terms;
}

/** The query `gh search issues` sends to github.com, as gh 2.88.1 builds it
 *  (`AdvancedIssueSearchString` in pkg/search/query.go): the words in
 *  parentheses, then the qualifiers sorted by name. Throws on a word or
 *  value this function cannot write the way gh does. */
export function _ghSearchQuery(words: string[], qualifiers: GhSearchQualifiers): string {
  const names = Object.keys(qualifiers)
    .filter((name) => qualifiers[name].length > 0)
    .sort();
  for (const text of [...words, ...names.flatMap((name) => qualifiers[name])]) {
    checkSearchText(text);
  }
  const terms = names.flatMap((name) => qualifierTerms(name, qualifiers[name])).join(" ");
  const text = words.map(keyword).join(" ");
  if (text === "" || terms === "") {
    return text + terms;
  }
  return `( ${text} ) ${terms}`;
}
