import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});





//  This is a single line comment at the top of the file
//  Variable assignment with comment above
const x = 42;
//  Multiple comments
//  can be placed
//  on consecutive lines
const y = "hello";
//  Comment before function definition
async function greet() {
//  Comment inside function

const message = "Hello, World!";

//  Another comment

return
return message

}
//  Comment before function call
const result = await greet();
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
