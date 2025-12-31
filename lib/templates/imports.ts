// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/imports.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    