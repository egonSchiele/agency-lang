



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";

const statelogHost = "http://localhost:1065";
const statelogClient = new StatelogClient(statelogHost);
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





const greetTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "greet",
      description:
        "No description provided.",
      parameters: {
        type: "object",
        properties: ,
        required: [],
        additionalProperties: false,
      },
    },
  };
//  This is a single line comment at the top of the file
//  Variable assignment with comment above
const x = 42;
//  Multiple comments
//  can be placed
//  on consecutive lines
const y = "hello";
//  Comment before function definition
async function greet({}) {
    //  Comment inside function

const message = "Hello, World!";

//  Another comment

return message

}//  Comment before function call
const result = await greet({});
console.log(result)//  Testing comments in different contexts
//  1. Before type hints
const age = 25;
//  2. Before conditionals
const status = "active";
switch (status) {
  //  Comment in match block
  case "active":
console.log("Running")
    break;
  case "inactive":
console.log("Stopped")
    break;
  //  Default case comment
  default:
console.log("Unknown")
    break;
}//  Final comment at end of file


