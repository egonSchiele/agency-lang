// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/noteRow.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `set c to container of n
{{{accountWalk}}}
        set out to out & (id of n) & d & (name of n) & d & (name of c) & d & ¬
                  (name of a) & d & ((modification date of n) as text) & d & ¬
                  ((password protected of n) as text) & linefeed`;

export type TemplateType = {
  accountWalk: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    