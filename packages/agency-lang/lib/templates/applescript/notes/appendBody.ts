// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/appendBody.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `      if (password protected of n) then error "note is locked"
      set body of n to (body of n) & (item 2 of argv)
      set c to container of n
{{{accountWalk}}}
      set d to (ASCII character 1)
      return (id of n) & d & (name of n) & d & (name of c) & d & (name of a) & d & ¬
             ((modification date of n) as text) & d & ((password protected of n) as text)`;

export type TemplateType = {
  accountWalk: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    