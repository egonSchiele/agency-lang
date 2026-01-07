



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const statelogClient = new StatelogClient({host: statelogHost, tid: traceId});

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





const addTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "add",
      description:
        "Add two numbers together.
This is a simple addition function.",
      parameters: {
        type: "object",
        properties: {"a":{"type":"string","description":""},"b":{"type":"string","description":""}},
        required: ["a","b"],
        additionalProperties: false,
      },
    },
  };
const greetTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "greet",
      description:
        "Generate a greeting message for the given name.",
      parameters: {
        type: "object",
        properties: {"name":{"type":"string","description":""}},
        required: ["name"],
        additionalProperties: false,
      },
    },
  };
const calculateAreaTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "calculateArea",
      description:
        "Calculate the area of a rectangle.
Parameters:
- width: the width of the rectangle
- height: the height of the rectangle
Returns: the area as a number",
      parameters: {
        type: "object",
        properties: {"width":{"type":"string","description":""},"height":{"type":"string","description":""}},
        required: ["width","height"],
        additionalProperties: false,
      },
    },
  };
const processDataTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "processData",
      description:
        "Single line docstring",
      parameters: {
        type: "object",
        properties: ,
        required: [],
        additionalProperties: false,
      },
    },
  };
//  Test docstrings in functions
async function add({a, b}) {
    
}async function greet({name}) {
    
}async function calculateArea({width, height}) {
    
}async function processData({}) {
    
}

