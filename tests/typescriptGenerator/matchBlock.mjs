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
//  Test match blocks (pattern matching)
//  Simple match with string literals
__stateStack.globals.action = `start`;
switch (__stateStack.globals.action) {
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
__stateStack.globals.statusCode = 200;
switch (__stateStack.globals.statusCode) {
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
__stateStack.globals.grade = `A`;
__stateStack.globals.points = 0;
switch (__stateStack.globals.grade) {
  case `A`:
__stateStack.globals.a = 100;

    break;
  case `B`:
__stateStack.globals.b = 85;

    break;
  case `C`:
__stateStack.globals.c = 70;

    break;
  case `D`:
__stateStack.globals.d = 55;

    break;
  default:
__stateStack.globals.e = 0;

    break;
}//  Match with function calls in body
__stateStack.globals.level = `debug`;
switch (__stateStack.globals.level) {
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
__stateStack.globals.resultType = `array`;
switch (__stateStack.globals.resultType) {
  case `array`:
__stateStack.globals.data1 = [1, 2, 3];

    break;
  case `object`:
__stateStack.globals.data2 = {"x": 1, "y": 2};

    break;
  default:
__stateStack.globals.data3 = [];

    break;
}//  Match with object results
__stateStack.globals.format = `json`;
switch (__stateStack.globals.format) {
  case `xml`:
__stateStack.globals.output1 = {"type": `xml`, "ext": `.xml`};

    break;
  case `json`:
__stateStack.globals.output2 = {"type": `json`, "ext": `.json`};

    break;
  case `csv`:
__stateStack.globals.output3 = {"type": `csv`, "ext": `.csv`};

    break;
  default:
__stateStack.globals.output4 = {"type": `unknown`, "ext": ``};

    break;
}