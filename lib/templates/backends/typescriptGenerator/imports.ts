// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/imports.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";

const statelogHost = "http://localhost:1065";
const statelogClient = new StatelogClient(statelogHost);
const model = "gpt-5-nano-2025-08-07";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    