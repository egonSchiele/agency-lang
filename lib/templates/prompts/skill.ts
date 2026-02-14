// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/prompts/skill.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
You can also read a skill file to augment your capabilities for a specific task using the "readSkill" tool. This allows you to access specialized knowledge and instructions that are relevant to particular scenarios.


Available skills:
{{{skills:string}}}`;

export type TemplateType = {
  skills: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    