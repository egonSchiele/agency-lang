import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const __statelogClient = new StatelogClient({
    host: statelogHost,
    traceId: traceId,
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: "agency-lang",
    debugMode: true,
  });

const model = "gpt-5-nano-2025-08-07";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

// Define the function tool for OpenAI
const addTool = {
    type: "function" as const,
    function: {
      name: "add",
      description:
        "Adds two numbers together and returns the result.",
      parameters: {
        type: "object",
        properties: {
          a: {
            type: "number",
            description: "The first number to add",
          },
          b: {
            type: "number",
            description: "The second number to add",
          },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
    },
  };
__stateStack.globals.name = `Alice`;

async function _greeting(name: string, __metadata?: Record<string, any>): Promise<string> {
  const __prompt = `say hi to ${name}`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse:InterruptResponseType|null = __stateStack.interruptData?.interruptResponse || null;
  const __tools = undefined;

  
  
  const __responseFormat = undefined;
  
  
  const __client = getClientWithConfig({});
  let responseMessage:any;

  if (__toolCalls.length === 0) {
    __messages.push(userMessage(__prompt));
  
  
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });
  
    const endTime = performance.now();

    if (isGenerator(__completion)) {
      if (!__callbacks.onStream) {
        console.log("No onStream callback provided for streaming response, returning response synchronously");
        statelogClient.debug(
          "Got streaming response but no onStream callback provided, returning response synchronously",
          {
            prompt: __prompt,
            callbacks: Object.keys(__callbacks),
          },
        );

        let syncResult = "";
        for await (const chunk of __completion) {
          switch (chunk.type) {
            case "tool_call":
              __toolCalls.push(chunk.toolCall);
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
        __completion = { success: true, value: syncResult };
      } else {
        for await (const chunk of __completion) {
          switch (chunk.type) {
            case "text":
              __callbacks.onStream({ type: "text", text: chunk.text });
              break;
            case "tool_call":
              __toolCalls.push(chunk.toolCall);
              __callbacks.onStream({ type: "tool_call", toolCall: chunk.toolCall });
              break;
            case "done":
              __callbacks.onStream({ type: "done", result: chunk.result });
              __completion = { success: true, value: chunk.result };
              break;
            case "error":
              __callbacks.onStream({ type: "error", error: chunk.error });
              break;
          }
        }
      }
    }

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: endTime - startTime,
    });
  
    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
  
    responseMessage = __completion.value;
    __toolCalls = responseMessage.toolCalls || [];

    if (__toolCalls.length > 0) {
      // Add assistant's response with tool calls to message history
      __messages.push(assistantMessage(responseMessage.output, { toolCalls: __toolCalls }));
    }
  }

  // Handle function calls
  if (__toolCalls.length > 0) {
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}
    let haltInterrupt:any = null;

    // Process each tool call
    for (const toolCall of __toolCalls) {
      
    }

    if (haltExecution) {
      statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.interruptData = {
        messages: __messages.map((msg) => msg.toJSON()),
        nodesTraversed: __graph.getNodesTraversed(),
        toolCall: haltToolCall,
      };
      haltInterrupt.__state = __stateStack.toJSON();
      return haltInterrupt;
    }
  
    const nextStartTime = performance.now();
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const nextEndTime = performance.now();

    if (isGenerator(__completion)) {
      if (!__callbacks.onStream) {
        console.log("No onStream callback provided for streaming response, returning response synchronously");
        statelogClient.debug(
          "Got streaming response but no onStream callback provided, returning response synchronously",
          {
            prompt: __prompt,
            callbacks: Object.keys(__callbacks),
          },
        );

        let syncResult = "";
        for await (const chunk of __completion) {
          switch (chunk.type) {
            case "tool_call":
              __toolCalls.push(chunk.toolCall);
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
        __completion = { success: true, value: syncResult };
      } else {
        for await (const chunk of __completion) {
          switch (chunk.type) {
            case "text":
              __callbacks.onStream({ type: "text", text: chunk.text });
              break;
            case "tool_call":
              __toolCalls.push(chunk.toolCall);
              __callbacks.onStream({ type: "tool_call", toolCall: chunk.toolCall });
              break;
            case "done":
              __callbacks.onStream({ type: "done", result: chunk.result });
              __completion = { success: true, value: chunk.result };
              break;
            case "error":
              __callbacks.onStream({ type: "error", error: chunk.error });
              break;
          }
        }
      }
    }

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(assistantMessage(responseMessage.output));
  

  
  return responseMessage.output;
  
}

__self.greeting = await _greeting(__stateStack.globals.name, {
      messages: __messages,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.greeting)) {
  
   
   return  __self.greeting;
   
}await console.log(__stateStack.globals.greeting)