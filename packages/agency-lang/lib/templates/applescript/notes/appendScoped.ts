// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/appendScoped.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      set n to note id (item 1 of argv) of folder (item 3 of argv)
{{{appendBody}}}
    end tell`;

export type TemplateType = {
  appendBody: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    