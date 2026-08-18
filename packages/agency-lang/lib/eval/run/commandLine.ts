import {
  failure,
  many1,
  many1WithJoin,
  map,
  noneOf,
  oneOf,
  or,
  quotedString,
  sepBy1,
  type Parser,
} from "tarsec";

export const TASK_PLACEHOLDER = "{task}";

/** One message, used by both the early check (resolveEvalTarget) and the
 *  invariant guard (substituteTask), so the two cannot drift. */
export const MISSING_TASK_PLACEHOLDER_ERROR = `--agent-cmd must contain ${TASK_PLACEHOLDER} — the command never receives the input's task without it`;

// The grammar: a command is tokens separated by whitespace; a token is one
// or more adjacent chunks; a chunk is a double-quoted span, a single-quoted
// span, or a bare run. Adjacency joins, so `--flag="a b"` is one token
// `--flag=a b`. NOTHING shell-like — no expansion, operators, or escapes;
// a hostile task is inert by construction, since substitution happens after
// tokenization, per token.
const whitespace = many1(oneOf(" \t\n\r"));

// tarsec's quotedString, guarded to `"` and `'` (it also accepts backticks,
// which shells don't group) and unwrapped — the same delegate-with-guard
// shape as simpleStringParser in lib/parsers/parsers.ts. NOT
// between(char, char, manyWithJoin(noneOf)): that formulation takes ~14s to
// FAIL on an unclosed quote (pathological backtracking inside tarsec);
// quotedString fails in constant time with a clear message.
const quoted: Parser<string> = (input: string) => {
  const first = input[0];
  if (first !== '"' && first !== "'") {
    return failure(`expected '"' or "'"`, input);
  }
  return map(quotedString, (s) => s.slice(1, -1))(input);
};
const bare = many1WithJoin(noneOf(" \t\n\r\"'"));
const token: Parser<string> = map(many1(or(quoted, bare)), (chunks) => chunks.join(""));
const commandParser: Parser<string[]> = sepBy1(whitespace, token);

export function tokenizeCommand(command: string): string[] {
  // try/catch as well as the success check: an unclosed quote can make
  // tarsec throw internally (observed: "Invalid array length" from sepBy1)
  // rather than return a failure — both spellings mean the same mistake.
  let result;
  try {
    result = commandParser(command.trim());
  } catch {
    throw new Error(`--agent-cmd has an unbalanced quote: ${command}`);
  }
  if (!result.success || result.rest !== "") {
    throw new Error(`--agent-cmd has an unbalanced quote: ${command}`);
  }
  return result.result;
}

/** Replace every {task} occurrence with the test's input. (The placeholder
 *  token stays `{task}` — it is user-facing; renaming it is a separate
 *  decision.) Objects serialize as JSON. With an input, at least one
 *  occurrence is required — a command that never receives the input is the
 *  silent-drop bug in new clothing. A test with no input leaves the command
 *  as written (the preflight already refused a placeholder in that case). */
export function substituteInput(
  tokens: string[],
  input: string | Record<string, any> | undefined,
): string[] {
  if (input === undefined) return tokens;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (!tokens.some((t) => t.includes(TASK_PLACEHOLDER))) {
    throw new Error(MISSING_TASK_PLACEHOLDER_ERROR);
  }
  return tokens.map((t) => t.split(TASK_PLACEHOLDER).join(text));
}
