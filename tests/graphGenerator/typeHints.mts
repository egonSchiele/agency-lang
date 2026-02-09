// @ts-nocheck

import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import { assistantMessage, getClient, userMessage, toolMessage, messageFromJSON } from "smoltalk";
import type { Message } from "smoltalk";

const statelogHost = "https://statelog.adit.io";
const traceId = nanoid();
const statelogConfig = {
    host: statelogHost,
    traceId: traceId,
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: "agency-lang",
    debugMode: false,
  };
const __statelogClient = new StatelogClient(statelogConfig);
const __model: ModelName = "gpt-4o-mini";

const getClientWithConfig = (config = {}) => {
  const defaultConfig = {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    googleApiKey: process.env.GEMINI_API_KEY || "",
    model: __model,
    logLevel: "warn",
  };

  return getClient({ ...defaultConfig, ...config });
};

let __client = getClientWithConfig();

type State = {
  messages: string[];
  data: any;
}

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: false,
  },
  statelog: statelogConfig,
};

const graph = new PieMachine<State>(graphConfig);

// builtins

const not = (val: any): boolean => !val;
const eq = (a: any, b: any): boolean => a === b;
const neq = (a: any, b: any): boolean => a !== b;
const lt = (a: any, b: any): boolean => a < b;
const lte = (a: any, b: any): boolean => a <= b;
const gt = (a: any, b: any): boolean => a > b;
const gte = (a: any, b: any): boolean => a >= b;
const and = (a: any, b: any): boolean => a && b;
const or = (a: any, b: any): boolean => a || b;
const head = <T>(arr: T[]): T | undefined => arr[0];
const tail = <T>(arr: T[]): T[] => arr.slice(1);
const empty = <T>(arr: T[]): boolean => arr.length === 0;

// interrupts

export type Interrupt<T> = {
  type: "interrupt";
  data: T;

  // JSONified StateStack, i.e. serialized execution state
  __state?: Record<string, any>;
};

export function interrupt<T>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    data,
  };
}

export function isInterrupt<T>(obj: any): obj is Interrupt<T> {
  return obj && obj.type === "interrupt";
}

function printJSON(obj: any) {
  console.log(JSON.stringify(obj, null, 2));
}

export type InterruptResponseType = InterruptResponseApprove | InterruptResponseReject;

export type InterruptResponseApprove = {
  type: "approve";
  newArguments?: Record<string, any>;
};
export type InterruptResponseReject = {
  type: "reject";
};

export async function respondToInterrupt(_interrupt: Interrupt, _interruptResponse: InterruptResponseType, metadata: Record<string, any> = {}) {
  const interrupt = structuredClone(_interrupt);
  const interruptResponse = structuredClone(_interruptResponse);

  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.deserializeMode();
  
  const messages = (__stateStack.interruptData.messages || []).map((json: any) => {
    // create message objects from JSON
    return messageFromJSON(json);
  });
  __stateStack.interruptData.messages = messages;
  __stateStack.interruptData.interruptResponse = interruptResponse;

  if (interruptResponse.type === "approve" && interruptResponse.newArguments) {
    __stateStack.interruptData.toolCall = {
      ...__stateStack.interruptData.toolCall,
      arguments: { ...__stateStack.interruptData.toolCall.arguments, ...interruptResponse.newArguments },
    };
    // Error:
    // TypeError: Cannot set property arguments of #<ToolCall> which has only a getter
    //         toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
    //
    // const lastMessage = __stateStack.interruptData.messages[__stateStack.interruptData.messages.length - 1];
    // if (lastMessage && lastMessage.role === "assistant") {
    //   const toolCall = lastMessage.toolCalls?.[lastMessage.toolCalls.length - 1];
    //   if (toolCall) {
    //     toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
    //   }
    // }
  }


  // start at the last node we visited
  const nodesTraversed = __stateStack.interruptData.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const result = await graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: graph,
      statelogClient: __statelogClient,
      __stateStack: __stateStack,
      __callbacks: metadata.callbacks,
    },

    // restore args from the state stack
    data: "<from-stack>"
  });
  return result.data;
}

export async function approveInterrupt(interrupt: Interrupt, metadata: Record<string, any> = {}) {
  return await respondToInterrupt(interrupt, { type: "approve" }, metadata);
}

export async function modifyInterrupt(interrupt: Interrupt, newArguments?: Record<string, any>, metadata: Record<string, any> = {}) {
  return await respondToInterrupt(interrupt, { type: "approve", newArguments }, metadata);
}

export async function rejectInterrupt(interrupt: Interrupt, metadata: Record<string, any> = {}) {
  return await respondToInterrupt(interrupt, { type: "reject" }, metadata);
}

type StackFrame = {
  args: Record<string, any>;
  locals: Record<string, any>;
  step: number;
};

// See docs for notes on how this works.
class StateStack {
  public stack: StackFrame[] = [];
  private mode: "serialize" | "deserialize" = "serialize";
  public globals: Record<string, any> = {};
  public other: Record<string, any> = {};
  public interruptData: Record<string, any> = {};

  private deserializeStackLength = 0;

  constructor(stack: StackFrame[] = [], mode: "serialize" | "deserialize" = "serialize") {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState(): StackFrame | null {
    if (this.mode === "deserialize" && this.deserializeStackLength <= 0) {
      console.log("Forcing mode to serialize, nothing left to deserialize");
      this.mode = "serialize";
    }
    if (this.mode === "serialize") {
      const newState: StackFrame = {
        args: {},
        locals: {},
        step: 0,
      };
      this.stack.push(newState);
      return newState;
    } else if (this.mode === "deserialize") {
      this.deserializeStackLength -= 1;
      const item = this.stack.shift();
      this.stack.push(item);
      return item;
    }
    return null;
  }

  deserializeMode() {
    this.mode = "deserialize";
    this.deserializeStackLength = this.stack.length;
  }

  pop(): StackFrame | undefined {
    return this.stack.pop();
  }

  toJSON() {
    return structuredClone({
      stack: this.stack,
      globals: this.globals,
      other: this.other,
      interruptData: this.interruptData,
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
    });
  }

  static fromJSON(json: any): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    stateStack.interruptData = json.interruptData || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }
}

let __stateStack = new StateStack();

function isGenerator(variable) {
  const toString = Object.prototype.toString.call(variable);
  return (
    toString === "[object Generator]" ||
    toString === "[object AsyncGenerator]"
  );
}

let __callbacks: Record<string, any> = {};
function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

const addTool = {
  name: "add",
  description: "Adds two numbers together and returns the result.",
  schema: z.object({
    a: z.number().describe("The first number to add"),
    b: z.number().describe("The second number to add"),
  }),
};


graph.node("main", async (state): Promise<any> => {
    let __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    
    // if `state.__metadata?.__stateStack` is set, that means we are resuming execution
    // at this node after an interrupt. In that case, this is the line that restores the state.
    if (state.__metadata?.__stateStack) {
      __stateStack = state.__metadata.__stateStack;
      
      // restore global state
      if (state.__metadata?.__stateStack?.global) {
        __global = state.__metadata.__stateStack.global;
      }

      // clear the state stack from metadata so it doesn't propagate to other nodes.
      state.__metadata.__stateStack = undefined;
    }

    if (state.__metadata?.callbacks) {
      __callbacks = state.__metadata.callbacks;
    }

    // either creates a new stack for this node,
    // or restores the stack if we're resuming after an interrupt,
    // depending on the mode of the state stack (serialize or deserialize).
    const __stack = __stateStack.getNewState();
    
    // We're going to modify __stack.step to keep track of what line we're on,
    // but first we save this value. This will help us figure out if we should execute
    // from the start of this node or from a specific line.
    const __step = __stack.step;

    const __self: Record<string, any> = __stack.locals;

    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _count(__metadata?: Record<string, any>): Promise<number> {
  const __prompt = `the number 42`;
  const startTime = performance.now();
  let __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __stateStack.interruptData?.toolCall ? [__stateStack.interruptData.toolCall] : [];
  const __interruptResponse:InterruptResponseType|null = __stateStack.interruptData?.interruptResponse || null;
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.number()
  });
  
  
  
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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'count':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}

__self.count = await _count({
      messages: __messages,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.count)) {
  
  return { ...state, data: __self.count };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        
async function _message(__metadata?: Record<string, any>): Promise<string> {
  const __prompt = `a greeting message`;
  const startTime = performance.now();
  let __messages: Message[] = __metadata?.messages || [];

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

__self.message = await _message({
      messages: __messages,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.message)) {
  
  return { ...state, data: __self.message };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        await console.log(__stack.locals.count)
        __stack.step++;
      }
      

      if (__step <= 4) {
        await console.log(__stack.locals.message)
        __stack.step++;
      }
      
    
    // this is just here to have a default return value from a node if the user doesn't specify one
    return { ...state, data: undefined };
});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);


export async function main({ messages, callbacks } = {}): Promise<any> {

  const data = [  ];
  __callbacks = callbacks || {};
  const result = await graph.run("main", { messages: messages || [], data });
  return result.data;
}

export default graph;