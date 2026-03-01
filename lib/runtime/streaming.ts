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
  completion: any;
  prompt: string;
  toolCalls: any[];
}): Promise<any> {
  const { ctx, completion, prompt, toolCalls } = args;

  if (isGenerator(completion)) {
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
      let syncResult = "";
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
      return { success: true, value: syncResult };
    } else {
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
            ctx.callbacks.onStream({ type: "text", text: chunk.text });
            break;
          case "tool_call":
            toolCalls.push(chunk.toolCall);
            ctx.callbacks.onStream({
              type: "tool_call",
              toolCall: chunk.toolCall,
            });
            break;
          case "done":
            ctx.callbacks.onStream({ type: "done", result: chunk.result });
            return { success: true, value: chunk.result };
          case "error":
            ctx.callbacks.onStream({ type: "error", error: chunk.error });
            break;
        }
      }

      ctx.onStreamLock = false;
    }
  }
}
