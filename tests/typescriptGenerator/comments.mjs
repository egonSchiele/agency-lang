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
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({})
};

export const __greetToolParams = [];//  This is a single line comment at the top of the file
//  Variable assignment with comment above
__stateStack.globals.x = 42;
//  Multiple comments
//  can be placed
//  on consecutive lines
__stateStack.globals.y = `hello`;
//  Comment before function definition

export async function greet(args, __metadata={}) {
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
        //  Comment inside function
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.locals.message = `Hello, World!`;
//  Another comment
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stateStack.pop();
return __stack.locals.message
        __stack.step++;
      }
      
}
//  Comment before function call
__stateStack.globals.result = greet([], {
        statelogClient,
        graph: __graph,
        messages: __self.messages_0.getMessages(),
      });

await console.log(__stateStack.globals.result)//  Testing comments in different contexts
//  1. Before type hints
__stateStack.globals.age = 25;
//  2. Before conditionals
__stateStack.globals.status = `active`;
switch (__stateStack.globals.status) {
  //  Comment in match block
  case `active`:
await console.log(`Running`)
    break;
  case `inactive`:
await console.log(`Stopped`)
    break;
  //  Default case comment
  default:
await console.log(`Unknown`)
    break;
}//  Final comment at end of file
