import * as smoltalk from "smoltalk";
import { agencyStore, getRuntimeContext } from "../runtime/asyncContext.js";
import type { ReplyAttachmentPart } from "../runtime/replyAttachments.js";
import { __tryCall, type ResultValue } from "../runtime/result.js";
import { __call } from "../runtime/call.js";
import { CostGuard, TimeGuard } from "../runtime/guard.js";
import { normalizeModelUsage, type ModelUsage } from "../runtime/utils.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

/**
 * std::thread TS implementations for the context-injected builtins
 * registered in `lib/codegenBuiltins/contextInjected.ts`. The agency-
 * side wrappers in `stdlib/thread.agency` call these without any of
 * the prefix args; the TypeScript builder prepends `__ctx`,
 * `__stateStack`, and `__threads` at every context-injected call
 * site.
 *
 * - Message builtins (`*Message`) push onto the active thread of the
 *   caller's `__threads` store. They ignore `_stack` and use
 *   `threads.getOrCreateActive()` so messages injected before the first
 *   `llm()` call still land on a real thread (rather than being
 *   silently dropped by `threads.active()?.push(...)`).
 * - Cost / token builtins (`getCost`, `getTokens`) read the per-branch
 *   accumulator from the caller's `__stateStack` (which has been
 *   seeded by `Runner.runForkAll` / `runRace` to inherit parent
 *   totals). They ignore `_ctx` and `_threads`.
 *
 * See docs/superpowers/specs/2026-05-20-thread-builtins-and-stdlib-
 * design.md for the per-branch cost model.
 */

export async function __internal_systemMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: string,
): Promise<void> {
  threads.getOrCreateActive().push(smoltalk.systemMessage(msg));
}

/** ALS-reading replacement for `__internal_systemMessage`. `label` is an
 *  observability-only debug tag shown in statelog; "" means unlabeled and
 *  is normalized to null. Never sent to the provider. */
export async function _systemMessage(
  msg: string,
  label: string = "",
): Promise<void> {
  const { threads } = getRuntimeContext();
  threads.getOrCreateActive().push(smoltalk.systemMessage(msg), label || null);
}

export async function __internal_userMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: smoltalk.UserContentInput,
): Promise<void> {
  threads.getOrCreateActive().push(smoltalk.userMessage(msg));
}

/** ALS-reading replacement for `__internal_userMessage`. Accepts a plain
 *  string or an array of text strings and image()/file() attachments.
 *  `label` is an observability-only debug tag (see `_systemMessage`). */
export async function _userMessage(
  msg: smoltalk.UserContentInput,
  label: string = "",
): Promise<void> {
  const { threads } = getRuntimeContext();
  threads.getOrCreateActive().push(smoltalk.userMessage(msg), label || null);
}

export async function __internal_assistantMessage(
  _ctx: RuntimeContext<any>,
  _stack: StateStack,
  threads: ThreadStore,
  msg: string,
): Promise<void> {
  threads.getOrCreateActive().push(smoltalk.assistantMessage(msg));
}

/** ALS-reading replacement for `__internal_assistantMessage`. `label` is
 *  an observability-only debug tag (see `_systemMessage`). */
export async function _assistantMessage(
  msg: string,
  label: string = "",
): Promise<void> {
  const { threads } = getRuntimeContext();
  threads
    .getOrCreateActive()
    .push(smoltalk.assistantMessage(msg), label || null);
}

// --- Multimodal attachment builders -------------------------------------
//
// Backing implementations for `std::thread`'s `image()` / `file()`. They
// return plain data objects matching smoltalk's `UserContentPart` /
// `ImageRef` shapes, so the result flows straight into
// `smoltalk.userMessage([...])`. smoltalk does all the I/O (reading paths,
// fetching URLs, MIME inference, size caps) at send time — these builders
// only describe the attachment.
//
// These return-type shapes must stay structurally compatible with the
// `Attachment` / `AttachmentSource` types in stdlib/thread.agency (the single
// source of truth that `llm()`'s typechecker signature references by name).
// The end-to-end fixture in tests/agency-js/multimodal-attachments guards it.

export type AttachmentSource =
  | { kind: "path"; path: string; mimeType?: string }
  | { kind: "url"; url: string; mimeType?: string }
  | { kind: "base64"; base64: string; mimeType: string };

export type ImageAttachment = { type: "image"; source: AttachmentSource };
export type FileAttachment = {
  type: "file";
  source: AttachmentSource;
  filename?: string;
};

export function classifySource(
  source: string,
  mimeType: string,
  base64: boolean,
): AttachmentSource {
  // A data: URI is authoritative regardless of the base64 flag.
  if (source.startsWith("data:")) {
    const marker = ";base64,";
    const idx = source.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        "image()/file(): a data: URI must be base64-encoded (data:<mime>;base64,<data>)",
      );
    }
    const uriMime = source.slice("data:".length, idx);
    const data = source.slice(idx + marker.length);
    return { kind: "base64", base64: data, mimeType: mimeType || uriMime };
  }
  if (base64) {
    if (!mimeType) {
      throw new Error(
        "image()/file(): base64 sources require an explicit mimeType",
      );
    }
    return { kind: "base64", base64: source, mimeType };
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return mimeType
      ? { kind: "url", url: source, mimeType }
      : { kind: "url", url: source };
  }
  return mimeType
    ? { kind: "path", path: source, mimeType }
    : { kind: "path", path: source };
}

export function _imageAttachment(
  source: string,
  mimeType: string,
  base64: boolean,
): ImageAttachment {
  return { type: "image", source: classifySource(source, mimeType, base64) };
}

function basename(source: string): string {
  const clean = source.split(/[?#]/)[0];
  const segments = clean.split("/");
  return segments[segments.length - 1] || "";
}

export function _fileAttachment(
  source: string,
  filename: string,
  mimeType: string,
  base64: boolean,
): FileAttachment {
  const src = classifySource(source, mimeType, base64);
  let name = filename;
  if (!name && (src.kind === "path" || src.kind === "url")) {
    name = basename(source);
  }
  return name
    ? { type: "file", source: src, filename: name }
    : { type: "file", source: src };
}

/** Backs `std::thread.attachToReply`. Queues an attachment on the CALLING
 *  TOOL INVOCATION's branch-local stack bag; the LLM tool loop harvests it
 *  when the invocation completes and shows it to the model as a labeled
 *  user message after the tool round (see lib/runtime/replyAttachments.ts).
 *  Outside a tool invocation there is no tool loop to harvest, so the
 *  attachment is dropped with a statelog error — never a throw (a tool
 *  must not crash because its host context changed). */
export function _attachToReply(attachment: unknown): void {
  const frame = agencyStore.getStore();
  if (!frame?.stack) {
    return;
  }
  if (!frame.ctx?.isInsideToolCall()) {
    frame.ctx?.statelogClient?.error({
      errorType: "toolError",
      message:
        "attachToReply called outside a tool invocation; attachment dropped",
      functionName: "attachToReply",
    });
    return;
  }
  frame.stack.queueReplyAttachment(attachment as ReplyAttachmentPart);
}

export async function __internal_getCost(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<number> {
  return stack.localCost;
}

/** ALS-reading replacement for `__internal_getCost`. */
export async function _getCost(): Promise<number> {
  const { stack } = getRuntimeContext();
  return stack.localCost;
}

export async function __internal_getTokens(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<number> {
  return stack.localTokens;
}

/** ALS-reading replacement for `__internal_getTokens`. */
export async function _getTokens(): Promise<number> {
  const { stack } = getRuntimeContext();
  return stack.localTokens;
}

/** True when the active message thread has no messages yet. Stdlib agents
 * use this to send their system prompt exactly once per thread: a fresh
 * thread has no messages, while a resumed session already carries its
 * prompt. */
export async function _threadIsNew(): Promise<boolean> {
  const { threads } = getRuntimeContext();
  const activeId = threads.activeId();
  if (activeId === undefined) {
    return true;
  }
  return threads.get(activeId).messages.length === 0;
}

export type ModelCost = ModelUsage;

/**
 * Per-model usage breakdown from the global `__tokenStats.models`
 * accumulator (populated by `updateTokenStats` on every LLM call,
 * including subagent/tool branches that pointer-share it). Returned
 * sorted by cost descending so callers can show the priciest model
 * first. Unlike `_getCost`/`_getTokens`, this reads the process-wide
 * total (not the per-branch accumulator), which is the right scope for
 * a `/cost` summary that attributes spend across every model used.
 */
export async function _getModelCosts(): Promise<ModelCost[]> {
  const { ctx } = getRuntimeContext();
  const stats = ctx?.globals?.getTokenStats?.();
  return normalizeModelUsage(stats?.models);
}

/**
 * Open 0..2 guard scopes on the caller's stack, depending on which
 * limits were passed. Returns the count actually pushed so the
 * surrounding `guard` stdlib function knows how many to pop. Either
 * argument may be `null` (meaning "no limit on this dimension"); at
 * least one must be non-null.
 *
 * When both cost and time are set, both guards trip independently —
 * whichever exceeds its limit first throws GuardExceededError. They
 * are pushed in order [cost, time] so popping LIFO returns the time
 * guard first (uninstall ordering doesn't matter for correctness, but
 * matters for the structured guard.uninstall stack-mutation cleanup).
 *
 * See lib/runtime/guard.ts.
 */
function pushGuardImpl(
  stack: StateStack,
  costLimit: number | null,
  timeLimit: number | null,
  label?: string | null,
): string[] {
  if (costLimit == null && timeLimit == null) {
    throw new Error(
      "guard() requires at least one of: cost, time",
    );
  }
  // Return the pushed guards' ids (innermost-last) so the caller can scope a
  // `try` to convert ONLY its own guards' trips (C2 ownedGuardIds). The array
  // length also drives the LIFO pop, replacing the old count.
  // A null OR negative limit disables that dimension: no guard is pushed,
  // so the block runs unmetered for it. Negative-as-disabled lets callers
  // with an optional cap (e.g. run()'s maxCost) keep a single guarded call
  // site instead of branching on "no limit".
  const ids: string[] = [];
  if (costLimit != null && costLimit >= 0) {
    const g = new CostGuard(costLimit, label ?? undefined);
    stack.pushGuard(g);
    ids.push(g.guardId);
  }
  // Time: a NON-POSITIVE limit disables (0 would otherwise trip instantly and
  // has no useful meaning). Cost differs on purpose: cost 0 is a real limit
  // meaning "no paid spend" (local-models-only), since check() trips on
  // spent > limit (strict).
  if (timeLimit != null && timeLimit > 0) {
    const g = new TimeGuard(timeLimit, label ?? undefined);
    stack.pushGuard(g);
    ids.push(g.guardId);
  }
  // Stamp every member with the whole scope: one Agency-level guard()
  // call IS this id array (a cost+time guard is two runtime objects),
  // and either member must be able to find its sibling — the trip
  // interrupt carries the scope, and approve resolves it by these ids.
  // Serialized with each guard; TimeGuard.cloneForBranch hand-copies it.
  for (const g of stack.guards) {
    if (ids.includes(g.guardId)) g.scopeIds = ids;
  }
  return ids;
}

export async function __internal_pushGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  costLimit: number | null,
  timeLimit: number | null,
): Promise<string[]> {
  return pushGuardImpl(stack, costLimit, timeLimit);
}

/** ALS-reading replacement for `__internal_pushGuard`. */
export async function _pushGuard(
  costLimit: number | null,
  timeLimit: number | null,
  label: string | null = null,
): Promise<string[]> {
  const { stack } = getRuntimeContext();
  return pushGuardImpl(stack, costLimit, timeLimit, label);
}

/**
 * Close the most-recently-opened guard scopes on the caller's stack — one
 * per id in `ids`. Paired with `pushGuard`'s returned id array so the caller
 * pops exactly the guards it pushed.
 */
function popGuardImpl(stack: StateStack, ids: string[]): void {
  for (let i = 0; i < ids.length; i++) {
    stack.popGuard();
  }
}

export async function __internal_popGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  ids: string[],
): Promise<void> {
  popGuardImpl(stack, ids);
}

/** ALS-reading replacement for `__internal_popGuard`. */
export async function _popGuard(ids: string[]): Promise<void> {
  const { stack } = getRuntimeContext();
  popGuardImpl(stack, ids);
}

/** Impl of the Agency `saveDraft(value)` builtin. All the real logic —
 *  which frame owns the draft, cloning, the global-scope rejection —
 *  lives in `StateStack.setSavedDraft`. */
export async function _saveDraft(value: unknown): Promise<void> {
  const { stack } = getRuntimeContext();
  stack.setSavedDraft(value);
}

/**
 * Run the guarded block under a `try` that owns exactly the guards in `ids`,
 * so a `guardTrip` is converted to a Failure ONLY when it belongs to one of
 * THIS guard()'s guards (an outer guard's trip re-throws past it).
 *
 * WHY THIS IS TS AND NOT AGENCY: the routing is `__tryCall(..., {
 * ownedGuardIds })`, and the agency `try block()` expression has no syntax to
 * pass `ownedGuardIds` into its `__tryCall` (it lowers to a fixed
 * `{ checkpoint, functionName, args }` — see processTryExpression in
 * lib/backends/typescriptBuilder.ts). Stashing the owned ids on the stack
 * frame for `__tryCall` to read globally is NOT an option either: a plain
 * `try` nested inside the guarded block must own NOTHING (so it re-throws the
 * guard's trip rather than swallowing it — see the fixture
 * guard-trip-not-swallowed-by-inner-try), so the owned set has to be scoped to
 * THIS specific `try` boundary, not read from the frame. Hence this small TS
 * seam. (The alternative is to extend the `try` codegen to carry
 * owned-guard-ids — a larger codegen change.)
 *
 * Because this replaces the stdlib `guard`'s former agency-level `try block()`,
 * it MUST forward the same FailureOpts that `try` injected ({ checkpoint,
 * functionName, args }) so a guard failure keeps its checkpoint / functionName
 * / args (retry + reporting depend on them) — only `ownedGuardIds` is added.
 */
export async function _runGuarded(
  ids: string[],
  block: unknown,
): Promise<ResultValue> {
  const { ctx, stack } = getRuntimeContext();
  try {
    // Invoke the block through __call (NOT a plain block()) so it runs through
    // the same Agency call machinery the codegen `try block()` used — that is
    // what lets a guard trip inside the block surface as an AgencyAbort with its
    // guardTrip cause instead of a generic error. `stack.lastFrame()` is
    // guard()'s own frame here (a TS call pushes no agency frame), so `.args`
    // matches what the codegen `try block()` captured via `__stack.args`.
    return await __tryCall(
      () => __call(block, { type: "positional", args: [] }),
      {
        ownedGuardIds: ids,
        checkpoint: ctx.getResultCheckpoint(),
        functionName: "guard",
        args: stack.lastFrame()?.args,
      },
    );
  } finally {
    // The block has exited and the Result (or a rethrown outer trip) is
    // this guard()'s answer, whatever it is. Between here and _popGuard
    // there is exactly one more runner step, and the owned guards must
    // not be able to trip during it: a clock crossing its limit AFTER
    // the work concluded would raise a question about nothing (approve
    // grants time to work that is already done) or, via a late timer
    // fire, flip a computed success into a failure. Suspending pauses
    // the clock, cancels the armed timer, and makes both the runner's
    // step-boundary probe and check() decline; the guards are popped at
    // the very next step. Suspension is never serialized, so a
    // checkpoint taken during the _popGuard step resumes unsettled —
    // the window then reopens for that one replayed step, which can
    // re-ask; harmless, and not worth a serialized flag.
    stack.settleGuards(ids);
  }
}
