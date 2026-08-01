// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/directRunArgsCheck.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__process.argv.length > {{{extraStart}}}) {
  console.error(\`main() takes {{{paramCount}}} argument(s) but got \${__process.argv.length - 2}; extra: \${__process.argv.slice({{{extraStart}}}).join(" ")}\`);
  __process.exit(1);
}
`;

export type TemplateType = {
  extraStart: string | boolean | number;
  paramCount: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    