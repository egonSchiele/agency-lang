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
export const __testTool = {
  name: "test",
  description: `No description provided.`,
  schema: z.object({})
};

export const __testToolParams = [];export const __addTool = {
  name: "add",
  description: `No description provided.`,
  schema: z.object({"a": z.string(), "b": z.string(), })
};

export const __addToolParams = ["a","b"];
export async function test(args, __metadata={}) {
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;

    // args are always set whether we're restoring from state or not.
    // If we're not restoring from state, args were obviously passed in through the code.
    // If we are restoring from state, the node that called this function had to have passed
    // these arguments into this function call.
    // if we're restoring state, this will override __stack.args (which will be set),
    // but with the same values, so it doesn't matter that those values are being overwritten.
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
      
}
await console.log(test([], {
        statelogClient,
        graph: __graph,
        messages: __self.messages_0.getMessages(),
      })
)
export async function add(args, __metadata={}) {
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;

    // args are always set whether we're restoring from state or not.
    // If we're not restoring from state, args were obviously passed in through the code.
    // If we are restoring from state, the node that called this function had to have passed
    // these arguments into this function call.
    // if we're restoring state, this will override __stack.args (which will be set),
    // but with the same values, so it doesn't matter that those values are being overwritten.
    const __params = ["a", "b"];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    
      if (__step <= 0) {
        //  multi-param function
        __stack.step++;
      }
      
}
