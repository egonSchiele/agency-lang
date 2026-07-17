// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/accountWalk.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `      set a to container of c
      set acctFound to false
      repeat 10 times
        if (class of a) is account then
          set acctFound to true
          exit repeat
        end if
        set a to container of a
      end repeat
      if not acctFound then error "Could not resolve the account for this note."`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    