/**
 * How a `std::grep` call becomes a regular expression.
 *
 * Models write `flags` the way they would for the `grep` command (`n`, `rn`,
 * `gi`), but the search runs in-process on a JavaScript RegExp, which only
 * knows a few single-letter flags. This module owns the translation: each
 * letter is either a real regex flag, a grep habit the tool already
 * satisfies, or a request that belongs to a named parameter. The rule table
 * is the single place that decision lives; the messages it produces go back
 * to the model as the tool's failure text, so they say what to send instead.
 */

/** What the caller asked for: the raw `flags` string plus the named options. */
export type GrepQuery = {
  pattern: string;
  flags: string;
  ignoreCase: boolean;
  wholeWord: boolean;
  filesOnly: boolean;
  invert: boolean;
};

/** The search the walker runs: one compiled regex and two output switches. */
export type GrepPlan = {
  regex: RegExp;
  filesOnly: boolean;
  invert: boolean;
};

type FlagRule =
  /** A JavaScript regex flag, passed through to the RegExp constructor. */
  | { kind: "regexFlag" }
  /** A grep letter for something the tool always does; accepted and ignored. */
  | { kind: "alreadyOn" }
  /** A grep letter whose behavior lives in a named parameter instead. */
  | { kind: "useParameter"; parameter: string };

const FLAG_RULES: Record<string, FlagRule> = {
  i: { kind: "regexFlag" },
  m: { kind: "regexFlag" },
  s: { kind: "regexFlag" },
  u: { kind: "regexFlag" },
  // grep -n: line numbers are always in the result.
  n: { kind: "alreadyOn" },
  // grep -r / -R: the search is always recursive.
  r: { kind: "alreadyOn" },
  R: { kind: "alreadyOn" },
  // JavaScript's g: every matching line is returned regardless.
  g: { kind: "alreadyOn" },
  // grep -E / -P: the pattern is already a full regex.
  E: { kind: "alreadyOn" },
  P: { kind: "alreadyOn" },
  w: { kind: "useParameter", parameter: "wholeWord" },
  l: { kind: "useParameter", parameter: "filesOnly" },
  v: { kind: "useParameter", parameter: "invert" },
};

const REGEX_FLAG_LETTERS = Object.keys(FLAG_RULES)
  .filter((letter) => FLAG_RULES[letter].kind === "regexFlag")
  .join(", ");

const IGNORED_FLAG_LETTERS = Object.keys(FLAG_RULES)
  .filter((letter) => FLAG_RULES[letter].kind === "alreadyOn")
  .join(", ");

/** Turn a query into the regex the walker runs, or throw a message that
 *  tells the caller which flag was wrong and what to send instead. */
export function compileGrepQuery(query: GrepQuery): GrepPlan {
  const letters = query.flags
    .split("")
    .filter((letter, index, all) => all.indexOf(letter) === index);
  const regexFlags = letters.filter((letter) => keepsFlag(letter));
  if (query.ignoreCase && !regexFlags.includes("i")) {
    regexFlags.push("i");
  }
  const source = query.wholeWord ? `\\b(?:${query.pattern})\\b` : query.pattern;
  return {
    regex: new RegExp(source, regexFlags.join("")),
    filesOnly: query.filesOnly,
    invert: query.invert,
  };
}

/** True when the letter reaches the RegExp; false when it is a grep habit to
 *  drop; throws when it names behavior that lives in a parameter or is unknown. */
function keepsFlag(letter: string): boolean {
  const rule = FLAG_RULES[letter];
  if (rule === undefined) {
    throw new Error(
      `grep does not take the flag "${letter}". flags holds JavaScript regex flags (${REGEX_FLAG_LETTERS}); the grep letters ${IGNORED_FLAG_LETTERS} are accepted and ignored because the tool already searches recursively and returns line numbers.`,
    );
  }
  if (rule.kind === "useParameter") {
    throw new Error(
      `grep does not take the flag "${letter}". Pass ${rule.parameter}: true instead.`,
    );
  }
  return rule.kind === "regexFlag";
}
