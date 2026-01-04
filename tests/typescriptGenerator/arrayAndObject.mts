

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
function add(a:number, b:number):number {
  return a + b;
}

// Define the function tool for OpenAI
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
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
  },
];





//  Test arrays and objects
//  Simple array
const nums = [1, 2, 3, 4, 5];
console.log(nums)//  Array with strings
const names = ["Alice", "Bob", "Charlie"];
console.log(names)//  Nested arrays
const matrix = [[1, 2], [3, 4], [5, 6]];
console.log(matrix)//  Simple object
const person = {"name": "Alice", "age": 30};
console.log(person)//  Object with nested structure
const address = {"street": "123 Main St", "city": "NYC", "zip": "10001"};
console.log(address)//  Object with array property
const user = {"name": "Bob", "tags": ["admin", "developer"]};
console.log(user)//  Array of objects
const users = [{"name": "Alice", "age": 30}, {"name": "Bob", "age": 25}];
console.log(users)//  Nested object
const config = {"server": {"host": "localhost", "port": 8080}, "debug": true};
console.log(config)//  Array access
const firstNum = nums[0];
console.log(firstNum)//  Object property access
const personName = person.name;
console.log(personName)

