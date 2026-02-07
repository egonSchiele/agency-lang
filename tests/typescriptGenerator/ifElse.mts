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
//  Basic if statement with boolean variable
__stateStack.globals.flag = true;
if (__stateStack.globals.flag) {
__stateStack.globals.result = `condition was true`;


}
if (isReady()) {
__stateStack.globals.status = `ready`;


}
//  If statement with property access
__stateStack.globals.obj = {"active": true};
if (__stateStack.globals.obj.active) {
__stateStack.globals.message = `object is active`;


}
//  Nested if statements
__stateStack.globals.outer = true;
if (__stateStack.globals.outer) {
__stateStack.globals.inner = false;


if (__stateStack.globals.inner) {
__stateStack.globals.nested = `both true`;


}


}
//  TODO fix
//  If with index access
//  arr = [1, 2, 3]
//  if (arr[0]) {
//    firstElement = "exists"
//  }
//  Multiple statements in then body
__stateStack.globals.condition = true;
if (__stateStack.globals.condition) {
__stateStack.globals.a = 1;


__stateStack.globals.b = 2;


__stateStack.globals.c = 3;


}
//  Multiple statements in both then and else bodies
__stateStack.globals.value = false;
if (__stateStack.globals.value) {
__stateStack.globals.x = 10;


__stateStack.globals.y = 20;


}
