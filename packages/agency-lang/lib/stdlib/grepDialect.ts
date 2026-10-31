/**
 * What a bash `grep` command means in terms of the grep tool's own search.
 *
 * safeBash runs a lone `grep` through `_grep` instead of the grep program,
 * so the approval it asks for means exactly what the grep tool's approval
 * means. That is only honest when the search finds what grep would find
 * and the output looks the way grep prints it. This file holds both
 * halves, as pure functions with no file access:
 *
 * - `_grepPatternToRegex` translates a pattern, or refuses it when any
 *   character could mean something different to grep and to JavaScript.
 * - `_renderGrepOutput` prints matches the way GNU grep does.
 *
 * See docs/dev/stdlib/safe-bash.md, "grep".
 */
import { escapeRegex, SKIP_DIRS, type GrepResults } from "./shell.js";

export type GrepSyntax = "basic" | "extended" | "fixed";

/** What a character does in a pattern. */
type CharRole =
  "literal" | "any" | "quantifier" | "start" | "end" | "alternation" | "open" | "close";

const WORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

/** Characters every grep and JavaScript read as themselves. */
const PLAIN_PUNCTUATION = " -/:,=#@%&~'\"<>;!";

function rolesFor(chars: string, role: CharRole): Record<string, CharRole> {
  return Object.fromEntries(chars.split("").map((char) => [char, role]));
}

const BASIC_ROLES: Record<string, CharRole> = {
  ...rolesFor(WORD_CHARS + PLAIN_PUNCTUATION, "literal"),
  ".": "any",
  "*": "quantifier",
  "^": "start",
  $: "end",
};

/** Extended grep adds the operators it shares with JavaScript. In basic
 *  grep these are plain text, so they stay out of BASIC_ROLES. */
const EXTENDED_ROLES: Record<string, CharRole> = {
  ...BASIC_ROLES,
  "+": "quantifier",
  "?": "quantifier",
  "|": "alternation",
  "(": "open",
  ")": "close",
};

/** Every character grep and JavaScript agree on, by syntax. A character
 *  missing from the table is refused. */
const ROLES: Record<"basic" | "extended", Record<string, CharRole>> = {
  basic: BASIC_ROLES,
  extended: EXTENDED_ROLES,
};

/** What a quantifier may follow: something that matches a character. */
const REPEATABLE: CharRole[] = ["literal", "any", "close"];

/** Below this code point, every character is a control character (tab,
 *  newline, ...). */
const FIRST_PRINTABLE = 0x20;
/** DEL, the one control character above FIRST_PRINTABLE in ASCII. */
const DELETE = 0x7f;

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < FIRST_PRINTABLE || code === DELETE;
}

function hasControlCharacter(pattern: string): boolean {
  return pattern.split("").some(isControlCharacter);
}

function isWordText(text: string): boolean {
  return text.length > 0 && text.split("").every((char) => WORD_CHARS.includes(char));
}

/** grep's -w checks the characters on either side of the matched text.
 *  The tool's `\b(?:pattern)\b` checks the boundary at the pattern's own
 *  edges. The two agree when every alternative is made of word characters,
 *  so `grep -w " world"` (no match in "hello world") is refused here. */
function wholeWordAgrees(pattern: string, syntax: GrepSyntax): boolean {
  if (syntax === "extended") {
    return pattern.split("|").every(isWordText);
  }
  return isWordText(pattern);
}

/** True when every character in `pattern` has a role in `roles` and is in
 *  a position where grep and JavaScript read it the same way. */
function sharedMeaning(pattern: string, roles: Record<string, CharRole>): boolean {
  const chars = pattern.split("");
  let depth = 0;
  let previous: CharRole | null = null;
  for (let index = 0; index < chars.length; index++) {
    const role = roles[chars[index]];
    if (role === undefined) {
      return false;
    }
    if (role === "start" && index !== 0) {
      return false;
    }
    if (role === "end" && index !== chars.length - 1) {
      return false;
    }
    if (role === "quantifier" && (previous === null || !REPEATABLE.includes(previous))) {
      return false;
    }
    if (role === "open") {
      depth++;
    }
    if (role === "close") {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
    previous = role;
  }
  return depth === 0;
}

/** The JavaScript regex source that matches exactly what grep would match
 *  for `pattern`, or null when the pattern uses anything whose meaning
 *  differs between grep and JavaScript. `wholeWord` is grep's -w, which
 *  the tool carries out as `\b(?:pattern)\b`. A null sends the command to
 *  the bash path, never to a guess. */
export function _grepPatternToRegex(
  pattern: string,
  syntax: GrepSyntax,
  wholeWord: boolean,
): string | null {
  // grep reads a newline as the start of a second pattern.
  if (hasControlCharacter(pattern)) {
    return null;
  }
  if (wholeWord && !wholeWordAgrees(pattern, syntax)) {
    return null;
  }
  if (syntax === "fixed") {
    return escapeRegex(pattern);
  }
  // Every accepted character means the same thing in both, so the
  // pattern is its own translation.
  if (!sharedMeaning(pattern, ROLES[syntax])) {
    return null;
  }
  return pattern;
}

/** What the command said about printing. The rules that turn this into
 *  grep's output all live in `_renderGrepOutput`. The Agency type of the
 *  same name in stdlib/safeBash/actions.agency must keep these fields. */
export type GrepRender = {
  /** `-n` was given. */
  lineNumbers: boolean;
  /** `-H` gives "always", `-h` gives "never", neither gives "default". */
  fileNames: "default" | "always" | "never";
  /** The path as bash hands it to grep (`GrepTarget.argument`), or ""
   *  when none was written. */
  argument: string;
  /** The path names one file, not a directory. */
  oneFile: boolean;
};

/** How grep names a file: the path as written for one file, else the
 *  match's relative path joined to it. */
function fileName(file: string, render: GrepRender): string {
  if (render.oneFile) {
    return render.argument;
  }
  if (render.argument === "") {
    return file;
  }
  const base = render.argument.replace(/\/+$/, "");
  return `${base}/${file}`;
}

function printsNames(render: GrepRender): boolean {
  if (render.fileNames === "default") {
    return !render.oneFile;
  }
  return render.fileNames === "always";
}

/** grep's output for these matches: `name:line:text` lines, or names
 *  alone for a files-only search, each ending in a newline. */
export function _renderGrepOutput(results: GrepResults, render: GrepRender): string {
  const lines = results.map((result) => {
    if (typeof result === "string") {
      return fileName(result, render);
    }
    const parts: string[] = [];
    if (printsNames(render)) {
      parts.push(fileName(result.file, render));
    }
    if (render.lineNumbers) {
      parts.push(String(result.line));
    }
    parts.push(result.text);
    return parts.join(":");
  });
  return lines.map((line) => `${line}\n`).join("");
}

/** The line safeBash adds after a directory search, built from the list
 *  the walk skips so the two cannot drift apart. */
export function _skippedDirsNote(): string {
  const skipped = [...SKIP_DIRS].join(", ");
  return `(safeBash ran this with the grep tool's search, which skips ${skipped}, and files .gitignore ignores. To include ignored files, call the grep tool with respectGitignore: false.)`;
}
