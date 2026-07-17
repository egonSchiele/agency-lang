// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/deleteUnscoped.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      set n to note id (item 1 of argv)
      if (password protected of n) then error "note is locked"
      delete n
    end tell`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    