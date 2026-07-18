import * as smoltalk from "smoltalk";
import type { AgencyFunction, ToolDefinition } from "./agencyFunction.js";
import type { StateStack } from "./state/stateStack.js";
import type { MessageThread } from "./state/messageThread.js";
import { __threads } from "./asyncContext.js";
import type { StatelogClient } from "../statelogClient.js";
import { invokeCallbacks } from "./hooks.js";
import { saveDraftIntrinsic } from "./saveDraftTool.js";

/** What one intrinsic call sees. Deliberately narrow: an intrinsic
 *  manipulates the RUN (frames, drafts), not the outside world, so it
 *  gets the call, the stack, and the threaded schema — nothing else.
 *  Widen this type only when a new intrinsic genuinely needs more. */
export type IntrinsicCall = {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  stateStack: StateStack;
  /** Zod schema threaded by the llm() codegen (saveDraft's value
   *  type); undefined when the call site had none. */
  draftSchema: unknown;
};

/** A tool the tool loop handles ITSELF, inline in the ordered pass,
 *  instead of dispatching into the concurrent pool. The loop owns all
 *  the generic bookkeeping — resume idempotency, statelog events,
 *  callbacks, the tool-result message — so `handle` is just the
 *  semantics and must be fast, synchronous, and interrupt-free.
 *  The registry is CLOSED: intrinsics touch run state, which is
 *  exactly what user tools must never do, so additions are code
 *  changes here, not a user-facing extension point. */
export type IntrinsicTool = {
  /** Identity check against a tools-array entry (name+module pair,
   *  never object identity — the prelude auto-import means modules
   *  hold their own wrapper objects). */
  matches: (fn: AgencyFunction) => boolean;
  /** The provider-facing definition, replacing the def's own. */
  buildDefinition: (ctx: { draftSchema: unknown }) => ToolDefinition;
  /** Handle one call; the return value is the tool-result text.
   *  Contract note: EVERY call must produce a tool-result message
   *  (providers reject a tool_use with no result), and for now that
   *  result is plain text — every intrinsic is a state write plus an
   *  acknowledgment. If a future intrinsic needs a richer result
   *  (attachments, structured content), widen this return type then;
   *  the loop's plumbing is the only consumer. */
  handle: (call: IntrinsicCall) => string;
};

const INTRINSIC_TOOLS: IntrinsicTool[] = [saveDraftIntrinsic];

export function findIntrinsic(fn: AgencyFunction): IntrinsicTool | undefined {
  return INTRINSIC_TOOLS.find((t) => t.matches(fn));
}

/** One round's calls, split once, declaratively: intrinsic entries
 *  (with their original call-list index, for stable step keys) and
 *  everything else, which dispatches concurrently as always. The loop
 *  never re-derives membership — these two lists are the answer. */
export function partitionIntrinsicCalls<
  T extends { id: string; name: string; arguments: Record<string, unknown> },
>(
  toolCalls: T[],
  toolFunctions: AgencyFunction[],
): {
  intrinsicCalls: { toolCall: T; callIndex: number; intrinsic: IntrinsicTool }[];
  dispatchCalls: T[];
} {
  const intrinsicOf = (toolCall: T) => {
    const handler = toolFunctions.find((fn) => fn.name === toolCall.name);
    return handler ? findIntrinsic(handler) : undefined;
  };
  const intrinsicCalls = toolCalls.flatMap((toolCall, callIndex) => {
    const intrinsic = intrinsicOf(toolCall);
    return intrinsic !== undefined ? [{ toolCall, callIndex, intrinsic }] : [];
  });
  const dispatchCalls = toolCalls.filter(
    (toolCall) => intrinsicOf(toolCall) === undefined,
  );
  return { intrinsicCalls, dispatchCalls };
}

/**
 * Run one intrinsic call: the handler plus every piece of generic
 * bookkeeping a dispatched tool would get — the toolExecution span,
 * the toolCallStart/toolCall statelog events, the onToolCallStart/End
 * hooks, and the tool-result message push. The tool loop's ordered
 * pass calls this inside a `pr.step` (resume idempotency stays with
 * the loop). The lifecycle mirrors the real dispatch path's events
 * inside one span so span-pairing consumers see intrinsic calls too;
 * deliberate differences from that path: one step instead of
 * per-phase branch steps (there is no branch), and timeTaken 0 (an
 * inline state write has no meaningful duration).
 */
export async function runIntrinsicCall(opts: {
  intrinsic: IntrinsicTool;
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  stateStack: StateStack;
  draftSchema: unknown;
  statelogClient: StatelogClient;
  ctx: unknown;
  model: unknown;
  messages: MessageThread;
}): Promise<void> {
  const { intrinsic, toolCall, stateStack, draftSchema, statelogClient } = opts;
  const callArgs = toolCall.arguments ?? {};
  // DELIBERATE divergence from the dispatched-tool branch, which opens
  // with a ctx.isCancelled throw: an intrinsic in a cancelled round
  // still runs. Saving on the way down is salvage-friendly (the draft
  // is the value a rejected trip returns), and answering the call
  // avoids a dangling tool_use. Do not add the cancel check here.
  const toolSpanId = statelogClient.startSpan("toolExecution");
  try {
    statelogClient.toolCallStart({
      toolName: toolCall.name,
      args: callArgs,
      model: JSON.stringify(opts.model),
      threadId: __threads()?.activeId() ?? null,
    });
    await invokeCallbacks({
      ctx: opts.ctx as any,
      name: "onToolCallStart",
      data: { toolName: toolCall.name, args: callArgs },
      stateStack,
    });
    const ack = intrinsic.handle({ toolCall, stateStack, draftSchema });
    await invokeCallbacks({
      ctx: opts.ctx as any,
      name: "onToolCallEnd",
      data: { toolName: toolCall.name, result: ack, timeTaken: 0 },
      stateStack,
    });
    statelogClient.toolCall({
      toolName: toolCall.name,
      args: callArgs,
      output: ack,
      model: JSON.stringify(opts.model),
      timeTaken: 0,
      threadId: __threads()?.activeId() ?? null,
    });
    opts.messages.push(
      smoltalk.toolMessage(ack, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      }),
    );
  } finally {
    statelogClient.endSpan(toolSpanId);
  }
}
