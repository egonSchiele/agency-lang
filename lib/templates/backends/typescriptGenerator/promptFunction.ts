// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<any> {
  __self.__removedTools = __self.__removedTools || [];
  return runPrompt({
    ctx: __ctx,
    prompt: {{{promptCode:string}}},
    messages: __metadata?.messages || new MessageThread(),
    {{#hasResponseFormat}}
    responseFormat: z.object({
      response: {{{zodSchema:string}}}
    }),
    {{/hasResponseFormat}}
    tools: {{{tools}}},
    toolHandlers: [{{{toolHandlers:string}}}],
    clientConfig: {{{clientConfig:string}}},
    stream: {{{isStreaming:boolean}}},
    maxToolCallRounds: {{{maxToolCallRounds:number}}},
    interruptData: __state?.interruptData,
    removedTools: __self.__removedTools,
  });
}

{{#isAsync}}
__self.{{{variableName:string}}} = _{{{variableName:string}}}({{{funcCallParams:string}}});
{{/isAsync}}

{{^isAsync}}
__self.{{{variableName:string}}} = await _{{{variableName:string}}}({{{funcCallParams:string}}});

// return early from node if this is an interrupt
if (isInterrupt(__self.{{{variableName:string}}})) {
  {{#nodeContext}}
  return { messages: __threads, data: __self.{{{variableName:string}}} };
  {{/nodeContext}}
   {{^nodeContext}}
   return  __self.{{{variableName:string}}};
   {{/nodeContext}}
}
{{/isAsync}}`;

export type TemplateType = {
  variableName: string;
  argsStr: string;
  promptCode: string;
  hasResponseFormat: boolean;
  zodSchema: string;
  tools: string | boolean | number;
  toolHandlers: string;
  clientConfig: string;
  isStreaming: boolean;
  maxToolCallRounds: number;
  isAsync: boolean;
  funcCallParams: string;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    