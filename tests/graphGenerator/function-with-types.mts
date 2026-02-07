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

export type InterruptResponseType = InterruptResponseApprove | InterruptResponseReject | InterruptResponseModify;
export type InterruptResponseApprove = {
  type: "approve";
};
export type InterruptResponseReject = {
  type: "reject";
};
export type InterruptResponseModify = {
  type: "modify";
  newArguments: Record<string, any>;
};


export async function respondToInterrupt(_interrupt: Interrupt, _interruptResponse: InterruptResponseType) {
  const interrupt = structuredClone(_interrupt);
  const interruptResponse = structuredClone(_interruptResponse);

  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.deserializeMode();
  
  const messages = (__stateStack.other.messages || []).map((json: any) => {
    // create message objects from JSON
    return messageFromJSON(json);
  });

  // start at the last node we visited
  const nodesTraversed = __stateStack.other.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const result = await graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: graph,
      statelogClient: __statelogClient,
      interruptResponse: interruptResponse,
      state: interrupt.__state,
      __stateStack: __stateStack,
    },

    // restore args from the state stack
    data: "<from-stack>"
  });
  return result.data;
}

export async function approveInterrupt(interrupt: Interrupt) {
  return await respondToInterrupt(interrupt, { type: "approve" });
}

export async function rejectInterrupt(interrupt: Interrupt) {
  return await respondToInterrupt(interrupt, { type: "reject" });
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
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
    });
  }

  static fromJSON(json: any): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }
}

let __stateStack = new StateStack();
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

export const __addTool = {
  name: "add",
  description: `Adds two numbers together`,
  schema: z.object({"x": z.number(), "y": z.number(), })
};
export const __greetTool = {
  name: "greet",
  description: `Greets a person by name`,
  schema: z.object({"name": z.string(), })
};
export const __mixedTool = {
  name: "mixed",
  description: `Mixed typed and untyped parameters`,
  schema: z.object({"count": z.number(), "label": z.string(), })
};
export const __processArrayTool = {
  name: "processArray",
  description: `Processes an array of numbers`,
  schema: z.object({"items": z.array(z.number()), })
};
export const __flexibleTool = {
  name: "flexible",
  description: `Handles either a string or number`,
  schema: z.object({"value": z.union([z.string(), z.number()]), })
};

export async function add(args, __metadata={}) : Promise<number> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = ["x", "y"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(x: string, y: string, __metadata?: Record<string, any>): Promise<string> {
  const __prompt = `add ${x} and ${y}`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __metadata?.toolCall ? [__metadata.toolCall] : [];
  const __interruptResponse:InterruptResponseType|undefined = __metadata?.interruptResponse;
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
    });
  
    const endTime = performance.now();
    await statelogClient.promptCompletion({
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
      await statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.other = {
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

    await statelogClient.promptCompletion({
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

__self.result = await _result(__stack.args.x, __stack.args.y, {
      messages: __messages,
      interruptResponse: __interruptResponse,
      toolCall: __toolCall,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.result)) {
  return { ...state, data: __self.result };
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return __stack.locals.result
        __stack.step++;
      }
      
}
export async function greet(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = ["name"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _message(name: string, __metadata?: Record<string, any>): Promise<string> {
  const __prompt = `Hello ${name}!`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __metadata?.toolCall ? [__metadata.toolCall] : [];
  const __interruptResponse:InterruptResponseType|undefined = __metadata?.interruptResponse;
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
    });
  
    const endTime = performance.now();
    await statelogClient.promptCompletion({
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
      await statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.other = {
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

    await statelogClient.promptCompletion({
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

__self.message = await _message(__stack.args.name, {
      messages: __messages,
      interruptResponse: __interruptResponse,
      toolCall: __toolCall,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.message)) {
  return { ...state, data: __self.message };
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return __stack.locals.message
        __stack.step++;
      }
      
}
export async function mixed(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = ["count", "label"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _output(label: string, count: string, __metadata?: Record<string, any>): Promise<string> {
  const __prompt = `${label}: ${count}`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __metadata?.toolCall ? [__metadata.toolCall] : [];
  const __interruptResponse:InterruptResponseType|undefined = __metadata?.interruptResponse;
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
    });
  
    const endTime = performance.now();
    await statelogClient.promptCompletion({
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
      await statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.other = {
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

    await statelogClient.promptCompletion({
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

__self.output = await _output(__stack.args.label, __stack.args.count, {
      messages: __messages,
      interruptResponse: __interruptResponse,
      toolCall: __toolCall,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.output)) {
  return { ...state, data: __self.output };
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return __stack.locals.output
        __stack.step++;
      }
      
}
export async function processArray(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = ["items"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(items: string, __metadata?: Record<string, any>): Promise<string> {
  const __prompt = `Processing array with ${items} items`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __metadata?.toolCall ? [__metadata.toolCall] : [];
  const __interruptResponse:InterruptResponseType|undefined = __metadata?.interruptResponse;
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
    });
  
    const endTime = performance.now();
    await statelogClient.promptCompletion({
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
      await statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.other = {
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

    await statelogClient.promptCompletion({
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

__self.result = await _result(__stack.args.items, {
      messages: __messages,
      interruptResponse: __interruptResponse,
      toolCall: __toolCall,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.result)) {
  return { ...state, data: __self.result };
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return __stack.locals.result
        __stack.step++;
      }
      
}
export async function flexible(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = ["value"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(value: string, __metadata?: Record<string, any>): Promise<string> {
  const __prompt = `Received value: ${value}`;
  const startTime = performance.now();
  const __messages: Message[] = __metadata?.messages || [];

  // These are to restore state after interrupt.
  // TODO I think this could be implemented in a cleaner way.
  let __toolCalls = __metadata?.toolCall ? [__metadata.toolCall] : [];
  const __interruptResponse:InterruptResponseType|undefined = __metadata?.interruptResponse;
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
    });
  
    const endTime = performance.now();
    await statelogClient.promptCompletion({
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
      await statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });

      __stateStack.other = {
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

    await statelogClient.promptCompletion({
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

__self.result = await _result(__stack.args.value, {
      messages: __messages,
      interruptResponse: __interruptResponse,
      toolCall: __toolCall,
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.result)) {
  return { ...state, data: __self.result };
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return __stack.locals.result
        __stack.step++;
      }
      
}
graph.node("foo", async (state): Promise<any> => {
    const __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    
    // if `state.__metadata?.__stateStack` is set, that means we are resuming execution
    // at this node after an interrupt. In that case, this is the line that restores the state.
    if (state.__metadata?.__stateStack) {
      __stateStack = structuredClone(state.__metadata.__stateStack);
      
      // clear the state stack from metadata so it doesn't propagate to other nodes.
      state.__metadata.__stateStack = undefined;
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

    // If we're resuming after an interrupt, these will be set.
    // There should be a cleaner way to handle this,
    // instead of littering this scope with these variables
    const __interruptResponse: InterruptResponseType | undefined = state.__metadata?.interruptResponse;
    const __toolCall: Record<string, any>|undefined = __stateStack.other?.toolCall;

    // TODO pretty sure this isn't needed, check and remove
    if (state.__metadata?.state?.global) {
      __global = state.__metadata.state.global;
    }

    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await console.log(`This is a node with a return type`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        return { ...state, data: `Node completed`}
        __stack.step++;
      }
      
    
    // this is just here to have a default return value from a node if the user doesn't specify one
    return { ...state, data: undefined };
});
//  Call the functions
__stateStack.globals.sum = await add([5, 10]);
__stateStack.globals.greeting = await greet([`Alice`]);
__stateStack.globals.labeled = await mixed([42, `Answer`]);
__stateStack.globals.processed = await processArray([[1, 2, 3, 4, 5]]);
__stateStack.globals.flexResult = await flexible([`test`]);



export async function foo({ messages } = {}): Promise<string> {

  const data = [  ];
  const result = await graph.run("foo", { messages: messages || [], data });
  return result.data;
}

export default graph;