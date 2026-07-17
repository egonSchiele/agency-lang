// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/withTimeout.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `on run argv
  with timeout of {{{timeoutSeconds}}} seconds
{{{body}}}
  end timeout
end run`;

export type TemplateType = {
  timeoutSeconds: string | boolean | number;
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    