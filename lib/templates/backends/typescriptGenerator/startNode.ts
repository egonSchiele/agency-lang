// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/startNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
      const initialState = { messages: new ThreadStore(), data: {} };
      await main(initialState);
    } catch (__error: any) {
      console.error(\`\nAgent crashed: \${__error.message}\`);
      throw __error;
    }
}
`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    