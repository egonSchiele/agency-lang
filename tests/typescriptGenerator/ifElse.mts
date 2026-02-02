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

//  Basic if statement with boolean variable
const flag = true;
if (flag) {
const result = `condition was true`;


}
if (isReady()) {
const status = `ready`;


}
//  If statement with property access
const obj = {"active": true};
if (obj.active) {
const message = `object is active`;


}
//  Nested if statements
const outer = true;
if (outer) {
const inner = false;


if (inner) {
const nested = `both true`;


}


}
//  TODO fix
//  If with index access
//  arr = [1, 2, 3]
//  if (arr[0]) {
//    firstElement = "exists"
//  }
//  Multiple statements in then body
const condition = true;
if (condition) {
const a = 1;


const b = 2;


const c = 3;


}
//  Multiple statements in both then and else bodies
const value = false;
if (value) {
const x = 10;


const y = 20;


}
