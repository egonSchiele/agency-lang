// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/readUnscoped.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      set n to note id (item 1 of argv)
      set d to (ASCII character 1)
      return (plaintext of n) & d & ((modification date of n) as text)
    end tell`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    