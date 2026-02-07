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

async function _url(__metadata?: Record<string, any>): Promise<{ hostname: string; port: number }> {
  const __prompt = `extract the hostname and port from \"https://example.com:8080\"`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse:InterruptResponseType|null = __stateStack.interruptData?.interruptResponse || null;
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.object({ "hostname": z.string().describe("hostname of a url"), "port": z.number().describe("port number") })
  });
  
  
  
  const __client = getClientWithConfig({});
  let responseMessage:any;

  if (__toolCalls.length === 0) {
    __messages.push(userMessage(__prompt));
  
  
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
    });
  
    const endTime = performance.now();
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
    });

    const nextEndTime = performance.now();

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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'url':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}

__self.url = await _url({
      messages: __messages,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.url)) {
  
   
   return  __self.url;
   
}await console.log(__stateStack.globals.url)