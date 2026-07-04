import {
  PromptResult,
  Result,
  StreamChunk,
  ToolCallJSON,
  UserContentInput,
  redactAttachments,
} from "smoltalk";
import { builtinSleep } from "./builtins.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import { GraphState } from "./types.js";
import { isAbortError } from "./errors.js";
import { hasCallbackConsumer, invokeCallbacks, type CallbackMap } from "./hooks.js";

export function isGenerator(variable: any): boolean {
  const toString = Object.prototype.toString.call(variable);
  return (
    toString === "[object Generator]" || toString === "[object AsyncGenerator]"
  );
}

export async function handleStreamingResponse(args: {
  ctx: RuntimeContext<GraphState>;
  completion: AsyncGenerator<StreamChunk>;
  prompt: string | UserContentInput;
  /** The branch-local stack, if this call runs inside a fork/race branch.
   *  Used to discover scoped `callback("onStream")` registrations on the
   *  right frame chain — passed straight through to the callback machinery. */
  stateStack?: StateStack;
}): Promise<
  Result<{ completion: PromptResult; toolCalls: ToolCallJSON[] }> | undefined
> {
  const { ctx, completion, prompt, stateStack } = args;
  const toolCalls: ToolCallJSON[] = [];

  // Resolve `onStream` through the shared callback machinery so a callback
  // registered via the Agency `callback("onStream")` builtin — scoped inside a
  // node or at module top level — is found, not just a TS-passed one on
  // `ctx.callbacks`. See gatherCallbacks / invokeCallbacks in hooks.ts.
  if (!hasCallbackConsumer(ctx, "onStream", stateStack)) {
    console.log(
      "No onStream callback provided for streaming response, returning response synchronously",
    );
    ctx.statelogClient.debug(
      "Got streaming response but no onStream callback provided, returning response synchronously",
      {
        prompt: redactAttachments(prompt),
        callbacks: Object.keys(ctx.callbacks),
      },
    );
    let syncResult: PromptResult;
    try {
      for await (const chunk of completion) {
        switch (chunk.type) {
          case "tool_call":
            toolCalls.push(chunk.toolCall);
            break;
          case "done":
            syncResult = chunk.result;
            break;
          case "error":
            console.error(`Error in LLM response stream: ${chunk.error}`);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error("Unexpected error consuming LLM stream:", error);
      throw error;
    }
    return { success: true, value: { completion: syncResult!, toolCalls } };
  } else {
    // Fire every registered onStream consumer for this chunk. Awaited because
    // Agency-registered callbacks are AgencyFunctions invoked through the
    // runtime (async); this also applies natural backpressure — we finish
    // delivering a chunk before pulling the next.
    const emit = (data: CallbackMap["onStream"]) =>
      invokeCallbacks({ ctx, name: "onStream", data, stateStack });
    // try to acquire lock
    let count = 0;
    // wait 60 seconds to acquire lock
    while (ctx.onStreamLock && count < 10 * 60) {
      await builtinSleep(0.1);
      count++;
    }
    if (ctx.onStreamLock) {
      console.log(`Couldn't acquire lock, ${count}`);
    }
    ctx.onStreamLock = true;

    try {
      let streamError: unknown = undefined;
      for await (const chunk of completion) {
        switch (chunk.type) {
          case "text":
            await emit({ type: "text", text: chunk.text });
            break;
          case "tool_call":
            toolCalls.push(chunk.toolCall);
            await emit({
              type: "tool_call",
              toolCall: chunk.toolCall,
            });
            break;
          case "done":
            await emit({ type: "done", result: chunk.result });
            return {
              success: true,
              value: { completion: chunk.result, toolCalls },
            };
          case "error":
            streamError = chunk.error;
            await emit({ type: "error", error: chunk.error });
            break;
        }
      }
      // Stream ended without a `done` chunk. If the provider signaled an
      // `error` chunk, surface THAT so the real failure reaches the caller
      // (dispatchLLMRequest turns a failure Result into a throw carrying the
      // message) instead of a generic "No completion returned". Mirrors the
      // sync-fallback branch, which never masks the error either.
      return {
        success: false,
        error:
          streamError !== undefined
            ? String(streamError)
            : "Streaming response ended without a completion.",
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error("Unexpected error consuming LLM stream:", error);
      throw error;
    } finally {
      ctx.onStreamLock = false;
    }
  }
}
