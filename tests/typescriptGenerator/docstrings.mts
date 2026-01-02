import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});





//  Test docstrings in functions
async function add() {

}
async function greet() {

}
async function calculateArea() {

}
async function processData() {

}
