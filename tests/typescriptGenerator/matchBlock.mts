



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





//  Test match blocks (pattern matching)
//  Simple match with string literals
const action = `start`;
switch (action) {
  case `start`:
await console.log(`Starting...`)
    break;
  case `stop`:
await console.log(`Stopping...`)
    break;
  case `restart`:
await console.log(`Restarting...`)
    break;
  default:
await console.log(`Unknown action`)
    break;
}//  Match with number literals
const statusCode = 200;
switch (statusCode) {
  case 200:
await console.log(`OK`)
    break;
  case 404:
await console.log(`Not Found`)
    break;
  case 500:
await console.log(`Internal Server Error`)
    break;
  default:
await console.log(`Unknown status`)
    break;
}//  Match with variable assignment in body
const grade = `A`;
const points = 0;
switch (grade) {
  case `A`:
const a = 100;

    break;
  case `B`:
const b = 85;

    break;
  case `C`:
const c = 70;

    break;
  case `D`:
const d = 55;

    break;
  default:
const e = 0;

    break;
}//  Match with function calls in body
const level = `debug`;
switch (level) {
  case `debug`:
await console.log(`Debug mode enabled`)
    break;
  case `info`:
await console.log(`Info level logging`)
    break;
  case `warn`:
await console.log(`Warning level`)
    break;
  case `error`:
await console.log(`Error level`)
    break;
}//  Match with array results
const resultType = `array`;
switch (resultType) {
  case `array`:
const data1 = [1, 2, 3];

    break;
  case `object`:
const data2 = {"x": 1, "y": 2};

    break;
  default:
const data3 = [];

    break;
}//  Match with object results
const format = `json`;
switch (format) {
  case `xml`:
const output1 = {"type": `xml`, "ext": `.xml`};

    break;
  case `json`:
const output2 = {"type": `json`, "ext": `.json`};

    break;
  case `csv`:
const output3 = {"type": `csv`, "ext": `.csv`};

    break;
  default:
const output4 = {"type": `unknown`, "ext": ``};

    break;
}

