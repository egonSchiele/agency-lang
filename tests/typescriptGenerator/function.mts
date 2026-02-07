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
export const __testTool = {
  name: "test",
  description: `No description provided.`,
  schema: z.object({})
};
export const __addTool = {
  name: "add",
  description: `No description provided.`,
  schema: z.object({"a": z.string(), "b": z.string(), })
};

export async function test(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = [];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.locals.foo = 1;
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.foo
        __stack.step++;
      }
      
}await console.log(test([]))
export async function add(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
    const __params = ["a", "b"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        //  multi-param function
        __stack.step++;
      }
      
}