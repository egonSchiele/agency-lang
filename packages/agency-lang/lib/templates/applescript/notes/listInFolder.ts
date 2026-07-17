// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/listInFolder.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with n in (notes of folder (item 1 of argv))
        {{{noteRow}}}
      end repeat
      return out
    end tell`;

export type TemplateType = {
  noteRow: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    