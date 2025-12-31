import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});



function test() {
const foo = 1;
return foo;
}
console.log(test())