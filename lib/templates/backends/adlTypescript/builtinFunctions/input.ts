// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/adlTypescript/builtinFunctions/input.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `function _builtinInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    