/**
 * The refusal gate in runPrompt's tool loop: the checks that can refuse
 * a tool call before it runs, and the text each refusal sends the model.
 * See docs/dev/agents/tool-loop-guards.md.
 */
import { sha256Text } from "../utils/hash.js";
import type * as smoltalk from "smoltalk";
import type { AgencyFunction, FuncParam } from "./agencyFunction.js";
import { tooManyHandoffsMessage } from "./handoff.js";

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
  return sha256Text(text);
}

/** The key is stored on the checkpoint, and checkpoints are kept as JSON
 *  in places that reject U+0000 (Postgres jsonb, for one), so the two parts
 *  are joined with a colon. A namespaced tool name has colons of its own,
 *  but the digest is always 64 hex characters, so two different calls can
 *  never produce the same key. */
export function repeatKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${digest(canonicalJson(args))}`;
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

/** The refusal-gate verdict for one tool invocation. Computed exactly
 *  once, inside its own step, and persisted in runnerState: most gates
 *  read frame state that mutates as sibling branches complete, so a
 *  verdict recomputed on resume could differ from the one the call
 *  originally acted on. */
export type GateVerdict =
  | "removed"
  | "unhandled"
  | "tooManyRounds"
  | "tooManyHandoffs"
  | "markup"
  | "priorRejected"
  | "repeated"
  | "proceed";

/** The state of one llm() call that the gate reads. The arrays and the
 *  streak are the live records on the runPrompt frame, which change as
 *  sibling calls finish. */
export type GateState = {
  removedTools: string[];
  rejectedCalls: string[];
  repeatStreak: RepeatStreak;
  toolCallRound: number;
  maxToolCallRounds: number;
  maxRepeatedToolCalls: number;
};

/** One call as the gate sees it. */
export type GateInput = {
  toolCall: smoltalk.ToolCallJSON;
  handler: AgencyFunction | null;
  markupArg: string | null;
  callKey: string;
};

export type GateCall = GateInput & {
  /** The handoff calls of this round that pass every other check, from
   *  `runnableHandoffs`. */
  runnableHandoffs: string[];
};

/** The names of the handoff calls in a round that pass every check
 *  except the one-handoff-per-round rule. Only these count toward that
 *  rule: a handoff that is refused for another reason would not run
 *  anyway, so it must not stop the one that would. Reads mutable state,
 *  so callers compute it once per round, inside a step. */
export function runnableHandoffs(state: GateState, inputs: GateInput[]): string[] {
  return inputs
    .filter((input) => input.handler?.markers?.handoff && checkCall(state, input) === "proceed")
    .map((input) => input.toolCall.name);
}

/** The refusal-gate decision for one call, in refusal-priority order.
 *  Reads mutable state, so callers must run it exactly once, inside the
 *  call's `.gate` step, and persist the verdict in runnerState. */
export function computeGateVerdict(state: GateState, call: GateCall): GateVerdict {
  const verdict = checkCall(state, call);
  // A handoff continues this conversation and runs after the other
  // calls in its round. Two handoff bodies would both write to the
  // conversation, so a round with two runnable handoffs refuses both.
  if (verdict === "proceed" && call.handler?.markers?.handoff && call.runnableHandoffs.length > 1) {
    return "tooManyHandoffs";
  }
  return verdict;
}

/** Every check except the one-handoff-per-round rule. */
function checkCall(state: GateState, input: GateInput): GateVerdict {
  const { toolCall, handler, markupArg, callKey } = input;
  if (state.removedTools.includes(toolCall.name)) {
    return "removed";
  }
  if (handler === null) {
    return "unhandled";
  }
  if (state.toolCallRound >= state.maxToolCallRounds) {
    return "tooManyRounds";
  }
  if (markupArg !== null) {
    return "markup";
  }
  if (state.rejectedCalls.includes(callKey)) {
    // A call identical to one already rejected in this llm() call: no
    // invoke, no re-raised interrupt, no counter movement. Checked
    // before the repeat guard so the model hears "rejected", not
    // "repeated".
    return "priorRejected";
  }
  if (
    state.maxRepeatedToolCalls > 0 &&
    repeatsBefore(state.repeatStreak, callKey) >= state.maxRepeatedToolCalls
  ) {
    return "repeated";
  }
  return "proceed";
}

/** The model-facing text for a refusal verdict. */
export function refusalMessage(
  state: GateState,
  verdict: Exclude<GateVerdict, "proceed">,
  call: GateCall,
): string {
  const name = call.toolCall.name;
  switch (verdict) {
    case "removed":
      return `Error: Tool ${name} has been removed from this conversation after repeated failures or rejections, and will not be executed.`;
    case "unhandled":
      return `Error: No handler found for tool call ${name}`;
    case "tooManyHandoffs":
      return tooManyHandoffsMessage(name, call.runnableHandoffs);
    case "tooManyRounds":
      return `Error: Maximum number of tool call rounds (${state.maxToolCallRounds}) exceeded. This tool call will not be executed.`;
    case "markup":
      // markupArg is non-null whenever the verdict says markup: both
      // derive from the same replay-stable inputs.
      return markupArgumentMessage(name, call.markupArg ?? "");
    case "priorRejected":
      return `This exact call to ${name} was already rejected and will not be executed. Do not retry it.`;
    case "repeated":
      return repeatedCallMessage(name, repeatsBefore(state.repeatStreak, call.callKey));
  }
}
