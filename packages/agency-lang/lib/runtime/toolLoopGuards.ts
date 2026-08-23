/**
 * Two refusals in runPrompt's tool loop, both decided before a tool runs:
 * a call the model keeps repeating with nothing changing, and a string
 * argument that is really the model's own tool-call markup. See
 * docs/dev/tool-loop-guards.md.
 */
import { createHash } from "crypto";
import type { FuncParam } from "./agencyFunction.js";

/** A call is refused once the same tool, with the same arguments, has
 *  returned the same result this many times in a row, with no other call in
 *  between. That is the loop signature: nothing changed, yet the model asks
 *  again (a writer once made 45 identical, successful typecheck calls). The
 *  refusal also restarts the count, so the call is interrupted every N
 *  repeats rather than banned: a status poll that really is waiting on the
 *  world gets to run again after the model says so. `0` disables. */
export const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;

/** The name of an optional string argument whose value is the model's own
 *  tool-call markup, or null. Claude sometimes emits the closing tag of its
 *  call syntax where an optional string it meant to leave empty belongs,
 *  and the next parameter's text leaks in:
 *  `stdin: "</antml name=\"stdin\">\n<parameter name=\"allowedExecutables\">[]"`.
 *  Running that call wastes a round at best (`grep` rejects the regex
 *  flags) and at worst executes with garbage. Deliberately narrow: only a
 *  parameter with a default, and only a value that IS the closing tag
 *  (named for this argument, or followed by leaked parameter markup). A
 *  required parameter, or a string that merely contains such text, is data
 *  a transcript or XML tool may legitimately be given. */
export function markupArgument(
  args: Record<string, unknown>,
  params: readonly FuncParam[],
): string | null {
  for (const param of params) {
    if (!param.hasDefault) continue;
    const value = args[param.name];
    if (typeof value !== "string") continue;
    const tag = /^<\/antml[^>]*>/.exec(value);
    if (tag === null) continue;
    const rest = value.slice(tag[0].length);
    if (tag[0].includes(param.name) || rest.trimStart().startsWith("<parameter")) {
      return param.name;
    }
  }
  return null;
}

export function markupArgumentMessage(toolName: string, argument: string): string {
  return (
    `Error: the \`${argument}\` argument contains tool-call markup (\`</antml...\`), which ` +
    `means it was meant to be empty. This call was not run. Call ${toolName} again and ` +
    `leave \`${argument}\` out.`
  );
}

/** JSON with object keys sorted at every level, so two calls that pass the
 *  same arguments in a different order get the same key. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Arguments and results are kept as digests, never as text: a tool may
 *  take a whole source file or return megabytes, and the streak lives on
 *  the serialized frame. Hashing is linear in the size, which the loop
 *  already pays to stringify the result for the model. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function repeatKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}\u0000${digest(canonicalJson(args))}`;
}

/** The current run of identical calls: one record, because only calls in a
 *  row count. Any other call, a different result, or a refusal resets it. */
export type RepeatStreak = { key: string; result: string; count: number };

export function freshRepeatStreak(): RepeatStreak {
  return { key: "", result: "", count: 0 };
}

/** Record one completed call (`result` is the stringified tool result) and
 *  return how many times in a row this exact call has now produced it. */
export function noteRepeat(streak: RepeatStreak, key: string, result: string): number {
  const resultDigest = digest(result);
  if (streak.key === key && streak.result === resultDigest) {
    streak.count += 1;
  } else {
    streak.key = key;
    streak.result = resultDigest;
    streak.count = 1;
  }
  return streak.count;
}

/** How many identical runs in a row precede a call with this key. */
export function repeatsBefore(streak: RepeatStreak, key: string): number {
  return streak.key === key ? streak.count : 0;
}

export function resetRepeat(streak: RepeatStreak): void {
  Object.assign(streak, freshRepeatStreak());
}

export function repeatedCallMessage(toolName: string, count: number): string {
  return (
    `Error: this is call ${count + 1} to ${toolName} with exactly these arguments, and ` +
    `the previous ${count} all returned the same result. It was not run. Say what you ` +
    `expected to change, then either call it with different arguments or continue without it.`
  );
}
