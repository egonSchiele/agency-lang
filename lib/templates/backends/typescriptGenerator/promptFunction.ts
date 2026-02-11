// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<{{{typeString:string}}}> {
  const __prompt = {{{promptCode:string}}};
  const startTime = performance.now();
  let __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse:InterruptResponseType|null = __stateStack.interruptData?.interruptResponse || null;
  const __tools = {{{tools}}};

  {{#hasResponseFormat}}
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: {{{zodSchema:string}}}
  });
  {{/hasResponseFormat}}
  {{^hasResponseFormat}}
  const __responseFormat = undefined;
  {{/hasResponseFormat}}
  
  const __client = getClientWithConfig({{{clientConfig:string}}});
  let responseMessage:any;

  if (__toolCalls.length === 0) {
    __messages.push(userMessage(__prompt));
  
  
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
      stream: {{{isStreaming:boolean}}}
    });
  
    const endTime = performance.now();

    const handleStreamingResponse = async () => {
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
                console.error(\`Error in LLM response stream: \${chunk.error}\`);
                break;
              default:
                break;
            }
          }
          __completion = { success: true, value: syncResult };
        } else {
          // try to acquire lock
          let count = 0;
          // wait 60 seconds to acquire lock
          while (onStreamLock && count < (10 * 60)) {
            await _builtinSleep(0.1)
            count++
          }
          if (onStreamLock) {
            console.log(\`Couldn't acquire lock, \${count}\`);
          }
          onStreamLock = true;

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

          onStreamLock = false
        }
      }
    }

    await handleStreamingResponse();

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
        \`Error getting response from $\{__model\}: $\{__completion.error\}\`
      );
    }
  
    responseMessage = __completion.value;
    __toolCalls = responseMessage.toolCalls || [];

    if (__toolCalls.length > 0) {
      // Add assistant's response with tool calls to message history
      __messages.push(assistantMessage(responseMessage.output, { toolCalls: __toolCalls }));
    }

    __updateTokenStats(responseMessage.usage, responseMessage.cost);

  }

  // Handle function calls
  if (__toolCalls.length > 0) {
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}
    let haltInterrupt:any = null;

    // Process each tool call
    for (const toolCall of __toolCalls) {
      {{{functionCalls:string}}}
    }

    if (haltExecution) {
      statelogClient.debug(\`Tool call interrupted execution.\`, {
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
      stream: {{{isStreaming:boolean}}}
    });

    const nextEndTime = performance.now();

    await handleStreamingResponse();

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        \`Error getting response from $\{__model\}: $\{__completion.error\}\`
      );
    }
    responseMessage = __completion.value;
    __updateTokenStats(responseMessage.usage, responseMessage.cost);
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(assistantMessage(responseMessage.output));
  {{#hasResponseFormat}}
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable '{{{variableName:string}}}':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  {{/hasResponseFormat}}

  {{^hasResponseFormat}}
  return responseMessage.output;
  {{/hasResponseFormat}}
}

{{#isAsync}}
__self.{{{variableName:string}}} = _{{{variableName:string}}}({{{funcCallParams:string}}});
{{/isAsync}}

{{^isAsync}}
__self.{{{variableName:string}}} = await _{{{variableName:string}}}({{{funcCallParams:string}}});

// return early from node if this is an interrupt
if (isInterrupt(__self.{{{variableName:string}}})) {
  {{#nodeContext}}
  return { ...state, data: __self.{{{variableName:string}}} };
  {{/nodeContext}}
   {{^nodeContext}}
   return  __self.{{{variableName:string}}};
   {{/nodeContext}}
}
{{/isAsync}}`;

export type TemplateType = {
  variableName: string;
  argsStr: string;
  typeString: string;
  promptCode: string;
  tools: string | boolean | number;
  hasResponseFormat: boolean;
  zodSchema: string;
  clientConfig: string;
  isStreaming: boolean;
  functionCalls: string;
  isAsync: boolean;
  funcCallParams: string;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    