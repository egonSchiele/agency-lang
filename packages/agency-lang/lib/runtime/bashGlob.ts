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

/** The characters that give a value a meaning beyond its own text. */
const GLOB_CHARS = ["*", "?", "[", "\\"];

/** The openers of what a bracket can hold besides plain characters:
 *  `[:alpha:]`, `[=e=]`, and `[.a.]`. Each ends with its own character and
 *  a `]`, and that `]` does not close the bracket. */
const CLASS_KINDS = [":", "=", "."];

/** What a scan of one part has already found missing, so no later `[`
 *  searches for it again: a closing `]`, or the end of a class kind. Each
 *  search goes to the end of the part, and repeating one for every `[`
 *  would take time quadratic in the length of the value. */
type BracketScan = { noClose: boolean; noClassEnd: Record<string, boolean> };

/** Whether `glob`, expanded by bash 3.2, can name the path `name`. A
 *  comparison too long to finish counts as yes. */
export function bashGlobMayName(glob: string, name: string): boolean {
  // Most values hold no glob character, and such a value names only itself.
  if (!GLOB_CHARS.some((char) => glob.includes(char))) {
    return glob === name;
  }
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
  const scan: BracketScan = { noClose: false, noClassEnd: {} };
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
      const bracket = readBracket(pattern, index, scan);
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
 `[`. A bracket holding a class such as `[:alpha:]` matches any character,
 which names more than bash would: a reject rule matches more, not less. */
function readBracket(
  pattern: string,
  start: number,
  scan: BracketScan,
): { token: GlobToken; end: number } {
  let index = start + 1;
  const negated = pattern[index] === "!" || pattern[index] === "^";
  if (negated) {
    index += 1;
  }
  const contentStart = index;
  if (pattern[index] === "]") {
    index += 1;
  }
  const found = findClose(pattern, index, scan);
  if (found.close === -1) {
    return { token: { kind: "char", char: "[" }, end: start + 1 };
  }
  const close = found.close;
  if (found.hasClass) {
    return { token: { kind: "anyClass" }, end: close + 1 };
  }
  const content = pattern.slice(contentStart, close);
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

/* The `]` that closes a bracket whose members start at `from`, stepping
 over each class inside it, so the `]` that ends `[:alpha:]` does not
 close the bracket. -1 when there is none. */
function findClose(
  pattern: string,
  from: number,
  scan: BracketScan,
): { close: number; hasClass: boolean } {
  let hasClass = false;
  if (scan.noClose) {
    return { close: -1, hasClass };
  }
  let index = from;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "]") {
      return { close: index, hasClass };
    }
    const kind = pattern[index + 1];
    const opensClass = char === "[" && kind !== undefined && CLASS_KINDS.includes(kind);
    if (opensClass && scan.noClassEnd[kind] !== true) {
      const classEnd = pattern.indexOf(kind + "]", index + 2);
      if (classEnd !== -1) {
        hasClass = true;
        index = classEnd + 2;
        continue;
      }
      scan.noClassEnd[kind] = true;
    }
    index += 1;
  }
  scan.noClose = true;
  return { close: -1, hasClass };
}
