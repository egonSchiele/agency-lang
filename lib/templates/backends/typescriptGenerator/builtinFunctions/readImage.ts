// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/readImage.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `/*
 * @param filePath The absolute or relative path to the image file.
 * @returns The Base64 string, or null if an error occurs.
 */
function _builtinReadImage(filePath: string): string {
    const data = fs.readFileSync(filePath); // Synchronous file reading
    const base64String = data.toString('base64');
    return base64String;
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    