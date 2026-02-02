



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const statelogClient = new StatelogClient({
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





const greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({})
};
//  This is a single line comment at the top of the file
//  Variable assignment with comment above
const x = 42;
//  Multiple comments
//  can be placed
//  on consecutive lines
const y = `hello`;
//  Comment before function definition
async function greet({}) : Promise<any> {
    const __messages: Message[] = [];
    //  Comment inside function


const message = `Hello, World!`;


//  Another comment


return message


}//  Comment before function call
const result = await greet({});
await console.log(result)//  Testing comments in different contexts
//  1. Before type hints
const age = 25;
//  2. Before conditionals
const status = `active`;
switch (status) {
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


