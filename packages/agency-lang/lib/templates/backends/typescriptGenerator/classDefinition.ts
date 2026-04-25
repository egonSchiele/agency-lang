// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/classDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `class {{{className}}}{{#hasParent}} extends {{{parentClassName}}}{{/hasParent}} {
{{#fields}}
  {{{this.name}}}: {{{this.typeStr}}};
{{/fields}}

  constructor({{{constructorParamsStr}}}) {
{{#hasParent}}
    super({{{superArgsStr}}});
{{/hasParent}}
{{#fields}}
    this.{{{this.name}}} = {{{this.name}}};
{{/fields}}
  }
{{#methods}}

{{{this}}}
{{/methods}}

  toJSON(): object {
    return {
{{#hasParent}}
      ...super.toJSON(),
{{/hasParent}}
      __class: "{{{classKey}}}",
{{#fields}}
      {{{this.name}}}: this.{{{this.name}}},
{{/fields}}
    };
  }

  static fromJSON(data: any): {{{className}}} {
    const instance = Object.create({{{className}}}.prototype);
{{#allFields}}
    instance.{{{this.name}}} = data.{{{this.name}}};
{{/allFields}}
    return instance;
  }
}

__globalCtx.registerClass("{{{classKey}}}", {{{className}}});`;

export type TemplateType = {
  className: string | boolean | number;
  hasParent: boolean;
  parentClassName: string | boolean | number;
  fields: {
    name: string | boolean | number;
    typeStr: string | boolean | number;
  }[];
  constructorParamsStr: string | boolean | number;
  superArgsStr: string | boolean | number;
  methods: {
  }[];
  classKey: string | boolean | number;
  allFields: {
    name: string | boolean | number;
  }[];
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    