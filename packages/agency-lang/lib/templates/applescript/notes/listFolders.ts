// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/applescript/notes/listFolders.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with f in folders
        set c to container of f
        if (class of c) is account then
          set out to out & (id of f) & d & (name of f) & d & ¬
                    ((count of notes of f) as text) & linefeed
        end if
      end repeat
      return out
    end tell`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    