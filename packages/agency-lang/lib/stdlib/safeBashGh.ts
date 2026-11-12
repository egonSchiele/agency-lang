// Text handling for safeBash's `gh` rule. Each function throws an Error that
// says what is wrong, and the Agency side turns the throw into the plan's
// broad reason, so a refused line tells the model why.
import { _ghCheckNumber, GITHUB_DEFAULT_PER_PAGE, GITHUB_MAX_PER_PAGE } from "./github/args.js";
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

export type GhApiEndpoint =
  "prGet" | "prFiles" | "prReviewList" | "prReviewCommentList" | "issueGet" | "issueCommentList";

export type GhApiRead = {
  endpoint: GhApiEndpoint;
  /** "" for both when the path used {owner} and {repo}. */
  owner: string;
  repo: string;
  number: number;
  /** GITHUB_DEFAULT_PER_PAGE and 1 when the query string does not give them. */
  perPage: number;
  page: number;
};

/** A path after `repos/OWNER/REPO/`: its kind, the part after the number,
 *  and whether it is a list that takes paging. */
type ApiRoute = { kind: "pulls" | "issues"; tail: string; endpoint: GhApiEndpoint; paged: boolean };

// The six `gh api` reads with a rule. _ghParseApiPath finds a route here
// and _ghApiPath writes a path from it, so the two cannot disagree.
const API_ROUTES: ApiRoute[] = [
  { kind: "pulls", tail: "", endpoint: "prGet", paged: false },
  { kind: "pulls", tail: "/files", endpoint: "prFiles", paged: true },
  { kind: "pulls", tail: "/reviews", endpoint: "prReviewList", paged: true },
  { kind: "pulls", tail: "/comments", endpoint: "prReviewCommentList", paged: true },
  { kind: "issues", tail: "", endpoint: "issueGet", paged: false },
  { kind: "issues", tail: "/comments", endpoint: "issueCommentList", paged: true },
];

const API_PATH = /^\/?repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/([^/]+)(\/[^/]+)?$/;
const PAGING_KEYS = ["per_page", "page"];

function routeFor(endpoint: GhApiEndpoint): ApiRoute {
  return API_ROUTES.find((route) => route.endpoint === endpoint)!;
}

/** `{owner}` and `{repo}` together, which gh fills from its own idea of the
 *  repository, become "" for safeBash to fill. One placeholder beside a
 *  name has no rule. */
function apiRepo(owner: string, repo: string): RepoCoord {
  if (owner === "{owner}" && repo === "{repo}") {
    return { owner: "", repo: "" };
  }
  if (owner === "{owner}" || repo === "{repo}") {
    throw new Error("A gh api path uses {owner} and {repo} together, or names both.");
  }
  return checkRepoCoord({ owner, repo });
}

/** A paging value: digits, at least 1, and at most `most` when one is given. */
function pagingValue(key: string, text: string, most: number | null): number {
  const value = DIGITS.test(text) ? Number(text) : 0;
  if (value < 1 || (most !== null && value > most)) {
    const range = most === null ? "a number of 1 or more" : `a number from 1 to ${most}`;
    throw new Error(`gh api's ${key} takes ${range}, got "${text}".`);
  }
  return value;
}

/** One of the six read paths, with its paging. */
export function _ghParseApiPath(text: string): GhApiRead {
  const [path, query, extra] = text.split("?");
  if (extra !== undefined) {
    throw new Error(`A gh api path has one query string, got "${text}".`);
  }
  const match = API_PATH.exec(path);
  const route =
    match === null
      ? undefined
      : API_ROUTES.find((each) => each.kind === match[3] && each.tail === (match[5] ?? ""));
  if (match === null || route === undefined) {
    throw new Error(
      `gh api has a rule for repos/OWNER/REPO/pulls/N with nothing, /files, /reviews, or /comments after it, and repos/OWNER/REPO/issues/N with nothing or /comments after it. Got "${path}".`,
    );
  }
  if (!DIGITS.test(match[4])) {
    throw new Error(`"${match[4]}" is not a pull request or issue number.`);
  }
  const number = Number(match[4]);
  _ghCheckNumber(number);
  const coord = apiRepo(match[1], match[2]);
  const params = new URLSearchParams(query ?? "");
  const keys = Array.from(params.keys());
  if (keys.length > 0 && !route.paged) {
    throw new Error(
      `gh api's ${path} is one ${route.kind === "pulls" ? "pull request" : "issue"}, and takes no query string.`,
    );
  }
  for (const key of keys) {
    if (!PAGING_KEYS.includes(key)) {
      throw new Error(`gh api takes per_page and page in a query string, got "${key}".`);
    }
    if (params.getAll(key).length > 1) {
      throw new Error(`gh api takes ${key} only once.`);
    }
  }
  const perPage = params.has("per_page")
    ? pagingValue("per_page", params.get("per_page")!, GITHUB_MAX_PER_PAGE)
    : GITHUB_DEFAULT_PER_PAGE;
  const page = params.has("page") ? pagingValue("page", params.get("page")!, null) : 1;
  return { endpoint: route.endpoint, owner: coord.owner, repo: coord.repo, number, perPage, page };
}

/** The path safeBash runs for a read, with the names written out and, for a
 *  list, both paging values. */
export function _ghApiPath(read: GhApiRead, owner: string, repo: string): string {
  const route = routeFor(read.endpoint);
  const path = `repos/${owner}/${repo}/${route.kind}/${read.number}${route.tail}`;
  if (!route.paged) {
    return path;
  }
  return `${path}?per_page=${read.perPage}&page=${read.page}`;
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
