// Whether a value, read as the glob bash 3.2 expands, can name a path. The
// policy matcher asks this of a reject or propagate rule, because safeBash
// puts a glob such as `*.json` in a question and bash expands it later.
//
// Written by hand, not with picomatch: the glob comes from the model, and a
// regular expression built from it can backtrack for seconds. This reads
// only bash's syntax (`*`, `?`, `[...]`, and `\`), so `!x`, `{a,b}`, and
// `(a|b)` are plain text, as they are to bash's path expansion.

/** One piece of a glob between slashes. */
type GlobToken =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "char"; char: string }
  | { kind: "set"; members: string; ranges: string[]; negated: boolean }
  | { kind: "anyClass" };

/** How many comparisons one call may make before it gives up. Past this,
 *  the value counts as naming the path, so a reject rule fails closed. A
 *  linear comparison of a megabyte-long command stays far below it. */
const MAX_STEPS = 10_000_000;

/** Whether `glob`, expanded by bash 3.2, can name the path `name`. A
 *  comparison too long to finish counts as yes. */
export function bashGlobMayName(glob: string, name: string): boolean {
  // Bash splits a pattern at `/` before it expands it, and no wildcard
  // matches a `/`, so the two paths must have the same number of parts.
  const globParts = glob.split("/");
  const nameParts = name.split("/");
  if (globParts.length !== nameParts.length) {
    return false;
  }
  const budget = { steps: 0 };
  return globParts.every((part, index) => partMatches(tokenize(part), nameParts[index], budget));
}

// The classic wildcard walk: on a mismatch, go back to the last `*` and
// let it take one more character. It makes at most one pass per character
// the last `*` can take, and the budget caps the total.
function partMatches(tokens: GlobToken[], text: string, budget: { steps: number }): boolean {
  if (text.startsWith(".") && !startsWithPlainDot(tokens)) {
    return false;
  }
  let textIndex = 0;
  let tokenIndex = 0;
  let lastStar = -1;
  let starTook = 0;
  while (textIndex < text.length) {
    budget.steps += 1;
    if (budget.steps > MAX_STEPS) {
      return true;
    }
    const token = tokens[tokenIndex];
    if (token !== undefined && token.kind === "star") {
      lastStar = tokenIndex;
      starTook = textIndex;
      tokenIndex += 1;
    } else if (token !== undefined && tokenMatches(token, text[textIndex])) {
      textIndex += 1;
      tokenIndex += 1;
    } else if (lastStar !== -1) {
      starTook += 1;
      textIndex = starTook;
      tokenIndex = lastStar + 1;
    } else {
      return false;
    }
  }
  while (tokens[tokenIndex]?.kind === "star") {
    tokenIndex += 1;
  }
  return tokenIndex === tokens.length;
}

/* Bash matches a leading `.` only with a plain `.`: not with `*`, `?`, or
 a bracket, even `[.]`. */
function startsWithPlainDot(tokens: GlobToken[]): boolean {
  const first = tokens[0];
  return first !== undefined && first.kind === "char" && first.char === ".";
}

function tokenMatches(token: GlobToken, char: string): boolean {
  switch (token.kind) {
    case "any":
    case "anyClass":
      return true;
    case "char":
      return token.char === char;
    case "set":
      return inSet(token, char) !== token.negated;
    case "star":
      return false;
  }
}

function inSet(token: { members: string; ranges: string[] }, char: string): boolean {
  if (token.members.includes(char)) {
    return true;
  }
  return token.ranges.some((range) => range[0] <= char && char <= range[1]);
}

function tokenize(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*") {
      tokens.push({ kind: "star" });
      index += 1;
    } else if (char === "?") {
      tokens.push({ kind: "any" });
      index += 1;
    } else if (char === "\\" && index + 1 < pattern.length) {
      tokens.push({ kind: "char", char: pattern[index + 1] });
      index += 2;
    } else if (char === "[") {
      const bracket = readBracket(pattern, index);
      tokens.push(bracket.token);
      index = bracket.end;
    } else {
      tokens.push({ kind: "char", char });
      index += 1;
    }
  }
  return tokens;
}

/* A bracket from `start`, which holds `[`. A `]` right after the `[`, or
 after `[!` or `[^`, is a member. A bracket with no closing `]` is a plain
 `[`. A character class such as `[:alpha:]` inside it matches any
 character, which names more than bash would: a reject rule matches more. */
function readBracket(pattern: string, start: number): { token: GlobToken; end: number } {
  let index = start + 1;
  const negated = pattern[index] === "!" || pattern[index] === "^";
  if (negated) {
    index += 1;
  }
  const contentStart = index;
  if (pattern[index] === "]") {
    index += 1;
  }
  const close = pattern.indexOf("]", index);
  if (close === -1) {
    return { token: { kind: "char", char: "[" }, end: start + 1 };
  }
  const content = pattern.slice(contentStart, close);
  if (content.includes("[:")) {
    return { token: { kind: "anyClass" }, end: close + 1 };
  }
  let members = "";
  const ranges: string[] = [];
  let at = 0;
  while (at < content.length) {
    const isRange = content[at + 1] === "-" && at + 2 < content.length;
    if (isRange) {
      ranges.push(content[at] + content[at + 2]);
      at += 3;
    } else {
      members += content[at];
      at += 1;
    }
  }
  return { token: { kind: "set", members, ranges, negated }, end: close + 1 };
}
