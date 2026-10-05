// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/withHandlerWrapper.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__run.ctx.pushRunHandler({{{handler}}}, []);
{{{indent}}}try {
{{{body}}}
{{{indent}}}} finally {
{{{indentInner}}}__run.ctx.popHandler();
{{{indent}}}}`;

export type TemplateType = {
  handler: string | boolean | number;
  indent: string | boolean | number;
  body: string | boolean | number;
  indentInner: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    