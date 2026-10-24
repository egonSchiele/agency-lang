/**
 * Helpers for one tool invocation inside the tool loop: the frame the
 * body runs in, how a failure is classified for the model, and the
 * constants that decide when a tool is removed. prompt.ts decides when
 * to call them.
 */
import { outputNotice, storeOutput } from "./toolOutputStore.js";
import type { FuncParam, CallType } from "./agencyFunction.js";
import type { AliasCorrection, CanonicalKeysResult } from "../utils/parameterAliases.js";
import { withChildRun, type Run } from "./asyncContext.js";
import { isSuccess } from "./result.js";
import type { RuntimeContext } from "./state/context.js";
import type { MessageThread } from "./state/messageThread.js";
import type { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import type { GraphState } from "./types.js";

/** Unwrap a SUCCESS Result before it goes back to the model: the LLM
 *  should see the tool's value, not the `{__type, success, value}`
 *  envelope (a wrapped envelope makes the model re-derive `.value` and,
 *  worse, reconstruct wrapped objects when echoing them into later tool
 *  arguments — the compile→run CompiledProgram bug). Only the LLM-facing
 *  message unwraps; the Result cached on the branch for Agency code is
 *  untouched. Failures/rejections never reach this point (handled
 *  upstream in the invoke path), but pass through unchanged
 *  defensively. */
export function unwrapToolResultForLlm(result: any, toolName: string): any {
  if (!isSuccess(result)) return result;
  return result.value ?? `${toolName} ran successfully but did not return a value`;
}

/** A failed tool is removed only after this many failures (the circuit
 *  breaker against retry spirals), or immediately on the destructive tier. */
export const MAX_TOOL_FAILURES = 5;

/** Consecutive rejections that remove a tool. Only consecutive: a
 *  successful call resets the count, so a narrow reject rule brushed
 *  against during otherwise-approved work never removes the tool, while
 *  a model rephrasing a refused call with nothing approved in between
 *  loses it quickly. */
export const MAX_TOOL_REJECTIONS = 5;

export const REJECTION_SUFFIX =
  "Do not call this tool with the same arguments again; the call will not be executed.";
export const REJECTION_REMOVAL_SUFFIX =
  "This tool has been rejected too many times and can no longer be called.";

export type FailureTier = "destructive" | "neverStarted" | "idempotent" | "neutral";

/**
 * Run the tool body with `branchStack` recorded on the frame as the tool
 * invocation's stack, so endTurn() and handBack() mark this invocation
 * from anywhere inside the body, including its parallel, fork, and async
 * branches, whose frames copy the slot.
 */
export function runAsToolInvocation<T>(
  run: Run,
  branchStack: StateStack,
  invoke: (run: Run) => Promise<T>,
): Promise<T> {
  return withChildRun(run, { toolInvocationStack: branchStack }, "a tool call", invoke);
}

/**
 * Run `invoke` in a copy of the current ALS frame whose `threads` slot is
 * a fresh, empty ThreadStore. The body keeps the frame's `ctx` and
 * `stack`, which branch-aware cancellation and per-branch state depend
 * on. It must not keep `threads`: an `llm()` call in the body would push
 * onto the outer prompt's thread, whose last message is the assistant's
 * tool call, a shape OpenAI rejects ("An assistant message with
 * 'tool_calls' must be followed by tool messages"). A handoff function is
 * the exception; see runInvokeStep.
 *
 * The store is bare, not `withDefaultActive`, so a leaf tool that never
 * calls llm() does not log a phantom default thread.
 */
export async function invokeOnFreshThreadStore<T>(
  run: Run,
  invoke: (run: Run) => Promise<T>,
): Promise<T> {
  const freshThreads = new ThreadStore();
  freshThreads.setStatelogClient(run.log);
  return withChildRun(run, { threads: freshThreads }, "a tool call", invoke);
}

/**
 * Run `invoke` in a copy of the current ALS frame whose `threads` slot is
 * a view of the caller's store with `thread` active. The view has its own
 * active stack, so two prompts running at once (two `async llm()` calls,
 * say) cannot interleave pushes and pops on a shared one.
 */
export async function invokeOnThread<T>(
  run: Run,
  thread: MessageThread,
  scopeKey: string,
  invoke: (run: Run) => Promise<T>,
): Promise<T> {
  // The body's system messages are tagged with the dispatch's scope key
  // while it runs, so the hand-back can remove them without a marker on
  // the thread. Re-entered when a resume re-runs the dispatch.
  thread.enterHandoffScope(scopeKey);
  try {
    const view = run.threads.viewWithActive(thread, run.log);
    return await withChildRun(run, { threads: view }, "a handoff", invoke);
  } finally {
    thread.exitHandoffScope();
  }
}

/** Classify a tool failure. Most-specific fact wins: a started destructive
 *  operation, then a proved-nothing-ran, then the tool's own idempotent
 *  declaration, else neutral. */
export function failureTier(
  f: { destructiveRan?: boolean; neverStarted?: boolean },
  markers?: { idempotent?: boolean },
): FailureTier {
  if (f.destructiveRan) return "destructive";
  if (f.neverStarted) return "neverStarted";
  if (markers?.idempotent) return "idempotent";
  return "neutral";
}

export const TIER_SUFFIX: Record<FailureTier, string> = {
  destructive:
    "The call failed after starting a destructive operation. This tool can no longer be called in this conversation. Verify state manually.",
  neverStarted: "Nothing was executed. Correct the arguments and call again.",
  idempotent: "This tool is idempotent: calling it again is safe.",
  neutral: "The call failed. You may call this tool again.",
};

/** Default cap on characters of a single tool result fed back to the
 *  LLM. A recursive `ls`/`grep` can return megabytes; without a cap one
 *  tool call can blow the context window. The FULL result is still
 *  returned to Agency code — only what the model sees is truncated. */
export const DEFAULT_TOOL_RESULT_CHARS = 100_000;

/** Coerce an arbitrary tool result to the string the LLM would see.
 *  Strings pass through; everything else is JSON-stringified, with a
 *  `String()` fallback for values JSON can't represent (e.g. circular). */
export function stringifyToolResult(result: any): string {
  if (typeof result === "string") return result;
  try {
    const json = JSON.stringify(result);
    // JSON.stringify returns undefined WITHOUT throwing for symbols,
    // functions, and undefined itself; callers read .length off this.
    return json === undefined ? String(result) : json;
  } catch {
    return String(result);
  }
}

/** Cap a tool result for the LLM. Returns the ORIGINAL value untouched
 *  when its serialized form is within `cap` characters (so smoltalk
 *  serializes it exactly as before) or when the cap is disabled (`cap <= 0`
 *  or non-finite). Over the cap, the whole text is saved in the run's
 *  output store and the model gets a preview naming it, the same notice
 *  `safeBash` gives for long command output. `canRead` says whether the
 *  model has the `readSpill` tool, which decides how the notice ends. */
export function capToolResultForLlm(result: any, cap: number, run: Run, canRead: boolean): any {
  if (!Number.isFinite(cap) || cap <= 0) return result;
  const text = stringifyToolResult(result);
  if (text.length <= cap) return result;
  return outputNotice(text, storeOutput(run, text), null, canRead);
}

/** LLMs routinely emit an explicit `null` for an optional tool argument
 *  they chose not to set (e.g. `bash(command, cwd: null, timeout: null)`).
 *  Agency default-parameter values only fill `undefined`, so a `null` would
 *  sail past the default into the function body — `bash(cwd: null)` reaches
 *  `applyAgentCwd` → `path.resolve(base, null)` and throws. Drop any argument
 *  whose value is `null` when its parameter declares a default, so the call
 *  behaves exactly as if the LLM had omitted the key (the default applies).
 *  Params without a default keep their value untouched: a required arg passed
 *  `null` still surfaces its normal type error for the model to correct, and
 *  an intentionally-nullable param is left alone. */
export function dropNullDefaultedArgs(
  args: Record<string, any> | null | undefined,
  params: readonly FuncParam[],
): Record<string, any> {
  const out: Record<string, any> = { ...args };
  for (const param of params) {
    if (param.hasDefault && out[param.name] === null) {
      delete out[param.name];
    }
  }
  return out;
}

/**
 * The model's arguments as the function will see them: alias keys renamed
 * to the parameter (`url` to `baseUrl`), then null-valued defaulted keys
 * dropped. Never throws. On a conflict between two keys for one parameter
 * the arguments stay as written, and the invoke reports the conflict as a
 * failure that never ran. `argCorrections` lists the renames for the log.
 */
export function toolArgumentsFor(
  handler: {
    params: readonly FuncParam[];
    canonicalizeNamedArgs(args: Record<string, unknown>): CanonicalKeysResult;
  } | null,
  toolCall: { arguments?: Record<string, unknown> | null },
): { namedArgs: Record<string, unknown>; argCorrections: AliasCorrection[] } {
  if (!handler) {
    return { namedArgs: {}, argCorrections: [] };
  }
  const corrected = handler.canonicalizeNamedArgs(toolCall.arguments ?? {});
  return {
    namedArgs: dropNullDefaultedArgs(corrected.args, handler.params),
    argCorrections: corrected.corrections,
  };
}

/** A named call whose arguments came from outside the program (a model, an
 *  HTTP body, the command line), so an alias key is renamed to the
 *  parameter. A call compiled from Agency source never gets this. */
export function callFromOutside(namedArgs: Record<string, unknown>): CallType {
  return { type: "named", positionalArgs: [], namedArgs, forgiveAliases: true };
}

/** Provider APIs (Anthropic, OpenAI) reject an LLM request whose tool list
 *  contains duplicate names, and tool-call dispatch here matches handlers by
 *  name — so duplicate names are always a bug. They're easy to introduce
 *  by accident because `.partial()` / `.describe()` preserve the base
 *  function's name (e.g. `skillsDir` returns `read.partial(dir)`, so four
 *  skill tools are all named `read`). Catch it before the request hits the
 *  wire with a message that names the collision and points at `.rename()`,
 *  instead of an opaque transport-layer 400 that never reaches the statelog. */
export function assertUniqueToolNames(tools: { name: string }[]): void {
  const counts: Record<string, number> = {};
  for (const t of tools) {
    counts[t.name] = (counts[t.name] || 0) + 1;
  }
  const dups = Object.keys(counts).filter((n) => counts[n] > 1);
  if (dups.length > 0) {
    const detail = dups.map((n) => `"${n}" (×${counts[n]})`).join(", ");
    throw new Error(
      `Duplicate tool name(s) passed to an LLM call: ${detail}. Tool names ` +
        `must be unique. This usually happens when several tools are derived ` +
        `from the same function via .partial() or .describe(), which preserve ` +
        `the base name. Give each derived tool a distinct name with ` +
        `.rename("...").`,
    );
  }
}
