// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/preflight.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      set n to note id (item 1 of argv)
      set c to container of n
{{{accountWalk}}}
      set d to (ASCII character 1)
      return (name of n) & d & (name of c) & d & (name of a) & d & ¬
             ((password protected of n) as text)
    end tell`;

export type TemplateType = {
  accountWalk: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    