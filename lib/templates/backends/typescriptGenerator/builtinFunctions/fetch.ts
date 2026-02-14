// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/fetch.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `async function _builtinFetch(url, args = {}) {
  const result = await fetch(url, args);
  try {
    const text = await result.text();
    return text;
  } catch (e) {
    throw new Error(\`Failed to get text from $\{url\}: $\{e\}\`);
  }
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    