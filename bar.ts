// @ts-nocheck

import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import {
  assistantMessage,
  getClient,
  userMessage,
  toolMessage,
  messageFromJSON,
} from "smoltalk";
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
};

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
  __state?: PackagedState;
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

export type InterruptResponseType =
  | InterruptResponseApprove
  | InterruptResponseReject
  | InterruptResponseModify;
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

export async function respondToInterrupt(
  interrupt: Interrupt,
  interruptResponse: InterruptResponseType,
) {
  console.log(
    "responseToInterrupt:",
    JSON.stringify({ interrupt, interruptResponse }, null, 2),
  );
  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.setMode("deserialize");
  const messages = (__stateStack.other.messages || []).map((json: any) => {
    return messageFromJSON(json);
  });

  const nodesTraversed = __stateStack.other.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  console.log(`Going to node ${nodeName} with response:`, interruptResponse);
  return graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: graph,
      statelogClient: __statelogClient,
      interruptResponse: interruptResponse,
      state: interrupt.__state,
      __stateStack: __stateStack,
    },
    data: "<from-stack>",
  });
}

class PackagedState {
  public messages?: Message[];
  public nodesTraversed?: string[];
  public toolCall?: Record<string, any>;
  public step?: number;
  public self?: Record<string, any>;
  public global?: Record<string, any>;
  public args?: any;
  constructor(_state: Record<string, any>, args?: any) {
    const state = structuredClone(_state);
    this.messages = state.messages;
    this.nodesTraversed = state.graph?.getNodesTraversed();
    this.toolCall = state.toolCall;
    this.step = state.part;
    this.self = state.self;
    this.global = state.global;
    this.args = state.args;
  }

  toJSON() {
    return {
      messages: this.messages,
      nodesTraversed: this.nodesTraversed,
      toolCall: this.toolCall,
      step: this.step,
      self: this.self,
      global: this.global,
      args: this.args,
    };
  }

  nextStep() {
    this.step ||= 0;
    this.step += 1;
  }
}

class StateStack {
  public stack: StateItem[] = [];
  private mode: "serialize" | "deserialize" = "serialize";
  public globals: Record<string, any> = {};
  public other: Record<string, any> = {};

  constructor(
    stack: StateItem[] = [],
    mode: "serialize" | "deserialize" = "serialize",
  ) {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState(): StateItem | null {
    if (this.mode === "serialize") {
      const newState: StateItem = {
        args: {},
        locals: {},
        step: 0,
      };
      this.stack.push(newState);
      return newState;
    } else if (this.mode === "deserialize") {
      return this.stack.shift() || null;
    }
    return null;
  }

  setMode(mode: "serialize" | "deserialize") {
    this.mode = mode;
  }

  pop(): StateItem | undefined {
    return this.stack.pop();
  }

  toJSON() {
    return structuredClone({
      stack: this.stack,
      globals: this.globals,
      other: this.other,
    });
  }

  static fromJSON(json: any): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    return stateStack;
  }
}

let __stateStack = new StateStack();
function add({ a, b }: { a: number; b: number }): number {
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

export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({ name: z.string() }),
};

export async function greet(args): Promise<string> {
  const __messages: Message[] = [];
  const __stack = __stateStack.getNewState();
  const __step = __stack.step;
  const __self: Record<string, any> = __stack.locals;

  const __params = ["name"];
  console.log({ args });
  args.forEach((item, index) => {
    __stack.args[__params[index]] = item;
  });

  if (__step <= 0) {
    __stack.step++;
  }

  if (__step <= 1) {
    return interrupt(`interrupt in greet`);
    __stack.step++;
  }

  if (__step <= 2) {
    __stateStack.pop();
    return `Kya chal raha jai, ${__stack.args.name}!`;
    __stack.step++;
  }
}
graph.node("sayHi", async (state): Promise<any> => {
  console.log({ state });
  const __messages: Message[] = state.messages || [];
  const __graph = state.__metadata?.graph || graph;
  const statelogClient = state.__metadata?.statelogClient || __statelogClient;
  if (state.__metadata?.stateStack) {
    __stateStack = state.__metadata.stateStack;
  }
  const __stack = __stateStack.getNewState();
  const __step = __stack.step;

  const __self: Record<string, any> = __stack.locals;

  const __interruptResponse: InterruptResponseType | undefined =
    state.__metadata?.interruptResponse;
  const __toolCall: Record<string, any> | undefined =
    state.__metadata?.state?.toolCall;

  if (state.__metadata?.state?.global) {
    __global = state.__metadata.state.global;
  }

  const __params = ["name"];
  if (state.data !== "<from-stack>") {
    state.data.forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });
  }

  if (__step <= 0) {
    __stack.step++;
  }

  if (__step <= 1) {
    await console.log(`Saying hi to ${__stack.args.name}...`);
    __stack.step++;
  }

  if (__step <= 2) {
    async function _response(
      name: string,
      __metadata?: Record<string, any>,
    ): Promise<string> {
      console.log("Inside prompt func, metedata:", __metadata);
      const __prompt = `Greet the user with their name: ${name} using the greet function.`;
      const startTime = performance.now();
      const __messages: Message[] = __metadata?.messages || [];
      let __toolCalls = __metadata?.toolCall ? [__metadata.toolCall] : [];
      const __interruptResponse: InterruptResponseType | undefined =
        __metadata?.interruptResponse;
      const __tools = [__greetTool];

      const __responseFormat = undefined;

      const __client = getClientWithConfig({});
      let responseMessage: any;

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
            `Error getting response from ${__model}: ${__completion.error}`,
          );
        }

        responseMessage = __completion.value;
        __toolCalls = responseMessage.toolCalls || [];

        if (__toolCalls.length > 0) {
          // Add assistant's response with tool calls to message history
          __messages.push(
            assistantMessage(responseMessage.output, {
              toolCalls: __toolCalls,
            }),
          );
        }
      }

      console.log("++++++++++++++++++++++++++");
      console.log(
        "Tool calls to process:",
        JSON.stringify(__toolCalls, null, 2),
      );
      console.log("++++++++++++++++++++++++++");

      // Handle function calls
      if (__toolCalls.length > 0) {
        let toolCallStartTime, toolCallEndTime;
        let haltExecution = false;
        let haltToolCall = {};
        let haltInterrupt: any = null;

        // Process each tool call
        for (const toolCall of __toolCalls) {
          if (toolCall.name === "greet") {
            const args = toolCall.arguments;
            console.log(`>> Tool 'greet' called with arguments:`, args);
            if (__interruptResponse) {
              if (__interruptResponse.type === "approve") {
                args.__metadata = {
                  part: 2,
                };
              }
            }

            toolCallStartTime = performance.now();
            const result = await greet(args);
            toolCallEndTime = performance.now();

            // console.log("Tool 'greet' called with arguments:", args);
            // console.log("Tool 'greet' returned result:", result);

            await statelogClient.toolCall({
              toolName: "greet",
              args,
              output: result,
              model: __client.getModel(),
              timeTaken: toolCallEndTime - toolCallStartTime,
            });

            if (isInterrupt(result)) {
              haltInterrupt = result;
              haltToolCall = {
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              };
              haltExecution = true;
              break;
            }

            // Add function result to messages
            __messages.push(
              toolMessage(result, {
                tool_call_id: toolCall.id,
                name: toolCall.name,
              }),
            );
          }
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
            `Error getting response from ${__model}: ${__completion.error}`,
          );
        }
        responseMessage = __completion.value;
      }

      // Add final assistant response to history
      // not passing tool calls back this time
      __messages.push(assistantMessage(responseMessage.output));

      return responseMessage.output;
    }

    __self.response = await _response(__stack.args.name, {
      messages: __messages,
      interruptResponse: __interruptResponse,
      toolCall: __toolCall,
    });

    if (isInterrupt(__self.response)) {
      return { ...state, data: __self.response };
    }
    __stack.step++;
  }

  if (__step <= 3) {
    await console.log(__stack.locals.response);
    __stack.step++;
  }

  if (__step <= 4) {
    await console.log(`Greeting sent.`);
    __stack.step++;
  }

  if (__step <= 5) {
    return { ...state, data: __stack.locals.response };
    __stack.step++;
  }

  // this is just here to have a default return value from a node if the user doesn't specify one
  return { ...state, data: undefined };
});

export async function sayHi(name, { messages } = {}): Promise<any> {
  const data = [name];
  const result = await graph.run("sayHi", { messages: messages || [], data });
  return result.data;
}

export default graph;
