import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const __traceId = nanoid();
const __statelogClient = new StatelogClient({
    host: statelogHost,
    traceId: __traceId,
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: "agency-lang",
    debugMode: true,
  });

const model = "gpt-5-nano-2025-08-07";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
function add({a, b}) {
  return a + b;
}

// Define the function tool for OpenAI
const addTool = {
    type: "function",
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

async function _foo(__metadata) {
  const __prompt = `the string hi`;
  const startTime = performance.now();
  let __messages = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse = __stateStack.interruptData?.interruptResponse || null;
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.literal("hi")
  });
  
  
  
  const __client = __getClientWithConfig({});
  let responseMessage;

  if (__toolCalls.length === 0) {
    __messages.push(smoltalk.userMessage(__prompt));
  
  
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const endTime = performance.now();

    await handleStreamingResponse(__completion);

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: endTime - startTime,
      tools: __tools,
      responseFormat: __responseFormat
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
      __messages.push(smoltalk.assistantMessage(responseMessage.output, { toolCalls: __toolCalls }));
    }

    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: endTime - startTime });

  }

  // Handle function calls
  if (__toolCalls.length > 0) {
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}
    let haltInterrupt = null;

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
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const nextEndTime = performance.now();

    await handleStreamingResponse(__completion);

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: nextEndTime - nextStartTime });
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(smoltalk.assistantMessage(responseMessage.output));
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'foo':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}


__self.foo = _foo({
      messages: __self.messages_0.getMessages(),
    });



async function _bar(__metadata) {
  const __prompt = `the number 42`;
  const startTime = performance.now();
  let __messages = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse = __stateStack.interruptData?.interruptResponse || null;
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.literal(42)
  });
  
  
  
  const __client = __getClientWithConfig({});
  let responseMessage;

  if (__toolCalls.length === 0) {
    __messages.push(smoltalk.userMessage(__prompt));
  
  
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const endTime = performance.now();

    await handleStreamingResponse(__completion);

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: endTime - startTime,
      tools: __tools,
      responseFormat: __responseFormat
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
      __messages.push(smoltalk.assistantMessage(responseMessage.output, { toolCalls: __toolCalls }));
    }

    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: endTime - startTime });

  }

  // Handle function calls
  if (__toolCalls.length > 0) {
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}
    let haltInterrupt = null;

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
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const nextEndTime = performance.now();

    await handleStreamingResponse(__completion);

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: nextEndTime - nextStartTime });
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(smoltalk.assistantMessage(responseMessage.output));
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'bar':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}


__self.bar = _bar({
      messages: __self.messages_0.getMessages(),
    });



async function _baz(__metadata) {
  const __prompt = `the boolean true`;
  const startTime = performance.now();
  let __messages = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse = __stateStack.interruptData?.interruptResponse || null;
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.literal(true)
  });
  
  
  
  const __client = __getClientWithConfig({});
  let responseMessage;

  if (__toolCalls.length === 0) {
    __messages.push(smoltalk.userMessage(__prompt));
  
  
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const endTime = performance.now();

    await handleStreamingResponse(__completion);

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: endTime - startTime,
      tools: __tools,
      responseFormat: __responseFormat
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
      __messages.push(smoltalk.assistantMessage(responseMessage.output, { toolCalls: __toolCalls }));
    }

    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: endTime - startTime });

  }

  // Handle function calls
  if (__toolCalls.length > 0) {
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}
    let haltInterrupt = null;

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
    await __callHook("onLLMCallStart", { prompt: __prompt, tools: __tools, model: __client.getModel() });
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: false
    });

    const nextEndTime = performance.now();

    await handleStreamingResponse(__completion);

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
    __updateTokenStats(responseMessage.usage, responseMessage.cost);
    await __callHook("onLLMCallEnd", { result: responseMessage, usage: responseMessage.usage, cost: responseMessage.cost, timeTaken: nextEndTime - nextStartTime });
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(smoltalk.assistantMessage(responseMessage.output));
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'baz':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}


__self.baz = _baz({
      messages: __self.messages_0.getMessages(),
    });


