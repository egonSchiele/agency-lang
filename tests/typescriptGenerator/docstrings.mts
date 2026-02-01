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

const addTool = {
  name: "add",
  description: "Add two numbers together.
This is a simple addition function.",
  schema: z.object({"a": z.string(), "b": z.string(), })
};
const greetTool = {
  name: "greet",
  description: "Generate a greeting message for the given name.",
  schema: z.object({"name": z.string(), })
};
const calculateAreaTool = {
  name: "calculateArea",
  description: "Calculate the area of a rectangle.
Parameters:
- width: the width of the rectangle
- height: the height of the rectangle
Returns: the area as a number",
  schema: z.object({"width": z.string(), "height": z.string(), })
};
const processDataTool = {
  name: "processData",
  description: "Single line docstring",
  schema: z.object({})
};
//  Test docstrings in functions
async function add({a, b}) : Promise<any> {
    const __messages: Message[] = [];
    
}async function greet({name}) : Promise<any> {
    const __messages: Message[] = [];
    
}async function calculateArea({width, height}) : Promise<any> {
    const __messages: Message[] = [];
    
}async function processData({}) : Promise<any> {
    const __messages: Message[] = [];
    
}