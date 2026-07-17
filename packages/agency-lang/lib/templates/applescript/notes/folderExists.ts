// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/folderExists.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      return (exists folder (item 1 of argv)) as text
    end tell`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    