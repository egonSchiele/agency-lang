// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/fetchJSON.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `async function _builtinFetchJSON(url: string, args: any = {}): any {
  const result = await fetch(url, args);
  try {
    const json = await result.json();
    return json;
  } catch (e) {
    throw new Error(\`Failed to parse JSON from $\{url\}: $\{e\}\`);
  }
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    