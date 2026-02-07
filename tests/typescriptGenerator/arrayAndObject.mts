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
//  Test arrays and objects
//  Simple array
__stateStack.globals.nums = [1, 2, 3, 4, 5];
await console.log(__stateStack.globals.nums)//  Array with strings
__stateStack.globals.names = [`Alice`, `Bob`, `Charlie`];
await console.log(__stateStack.globals.names)//  Nested arrays
__stateStack.globals.matrix = [[1, 2], [3, 4], [5, 6]];
await console.log(__stateStack.globals.matrix)//  Simple object
__stateStack.globals.person = {"name": `Alice`, "age": 30};
await console.log(__stateStack.globals.person)//  Object with nested structure
__stateStack.globals.address = {"street": `123 Main St`, "city": `NYC`, "zip": `10001`};
await console.log(__stateStack.globals.address)//  Object with array property
__stateStack.globals.user = {"name": `Bob`, "tags": [`admin`, `developer`]};
await console.log(__stateStack.globals.user)//  Array of objects
__stateStack.globals.users = [{"name": `Alice`, "age": 30}, {"name": `Bob`, "age": 25}];
await console.log(__stateStack.globals.users)//  Nested object
__stateStack.globals.config = {"server": {"host": `localhost`, "port": 8080}, "debug": true};
await console.log(__stateStack.globals.config)//  Array access
__stateStack.globals.firstNum = __stateStack.globals.nums[0];
await console.log(__stateStack.globals.firstNum)//  Object property access
__stateStack.globals.personName = __stateStack.globals.person.name;
await console.log(__stateStack.globals.personName)