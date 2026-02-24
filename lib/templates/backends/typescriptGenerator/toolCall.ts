// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/toolCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (
  toolCall.name === "{{{name:string}}}"
) {
  const args = toolCall.arguments;

  const params = __{{{name:string}}}ToolParams.map((param, index) => {
            return args[param];
          })

  toolCallStartTime = performance.now();
  
  let result;
  if (__interruptResponse && __interruptResponse.type === "reject") {
        __messages.push(smoltalk.toolMessage("tool call rejected", {
        tool_call_id: toolCall.id,
        name: toolCall.name,
     }));
     statelogClient.debug(\`Tool call rejected\`, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      });
  } else {
    await __callHook("onToolCallStart", { toolName: "{{{name}}}", args: params });
    {{#isBuiltin}}
    // if it's a builtin, that means it doesn't take an array of params.
    // use a spread operator to pass in the params as individual arguments.
    result = await {{{internalName?:string}}}(...params);
    {{/isBuiltin}}
    {{^isBuiltin}}
    result = await {{{name}}}(params);
    {{/isBuiltin}}

    result = result || "{{{name}}} ran successfully but did not return a value";

    toolCallEndTime = performance.now();
    await __callHook("onToolCallEnd", { toolName: "{{{name}}}", result, timeTaken: toolCallEndTime - toolCallStartTime });
  
    statelogClient.toolCall({
      toolName: "{{{name:string}}}",
      params,
      output: result,
      model: __clientConfig.model,
      timeTaken: toolCallEndTime - toolCallStartTime,
    });

    if (isInterrupt(result)) {
      haltInterrupt = result;
      haltToolCall = {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }
      haltExecution = true;
      break;
    }
  
      // Add function result to messages
    __messages.push(smoltalk.toolMessage(result, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
    }));
  }
}`;

export type TemplateType = {
  name: string;
  isBuiltin: boolean;
  internalName?: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    