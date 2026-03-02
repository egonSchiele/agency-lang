import { PromptResult, Result, StreamChunk, ToolCallJSON } from "@/index.js";
import { builtinSleep } from "./builtins.js";
import type { RuntimeContext } from "./state/context.js";
import { GraphState } from "./types.js";

export function isGenerator(variable: any): boolean {
  const toString = Object.prototype.toString.call(variable);
  return (
    toString === "[object Generator]" || toString === "[object AsyncGenerator]"
  );
}

export async function handleStreamingResponse(args: {
  ctx: RuntimeContext<GraphState>;
  completion: AsyncGenerator<StreamChunk>;
  prompt: string;
}): Promise<
  Result<{ completion: PromptResult; toolCalls: ToolCallJSON[] }> | undefined
> {
  const { ctx, completion, prompt } = args;
  const toolCalls: ToolCallJSON[] = [];

  if (!ctx.callbacks.onStream) {
    console.log(
      "No onStream callback provided for streaming response, returning response synchronously",
    );
    ctx.statelogClient.debug(
      "Got streaming response but no onStream callback provided, returning response synchronously",
      {
        prompt,
        callbacks: Object.keys(ctx.callbacks),
      },
    );
    let syncResult: PromptResult;
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
    return { success: true, value: { completion: syncResult!, toolCalls } };
  } else {
    const onStream = ctx.callbacks.onStream;
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

    for await (const chunk of completion) {
      switch (chunk.type) {
        case "text":
          onStream({ type: "text", text: chunk.text });
          break;
        case "tool_call":
          toolCalls.push(chunk.toolCall);
          onStream({
            type: "tool_call",
            toolCall: chunk.toolCall,
          });
          break;
        case "done":
          onStream({ type: "done", result: chunk.result });
          return {
            success: true,
            value: { completion: chunk.result, toolCalls },
          };
        case "error":
          onStream({ type: "error", error: chunk.error });
          break;
      }
    }

    ctx.onStreamLock = false;
  }
}
