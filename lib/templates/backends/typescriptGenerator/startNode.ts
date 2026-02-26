// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/startNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const __resumeFile = process.env.AGENCY_RESUME_FILE;
  if (__resumeFile) {
    const __stateJSON = JSON.parse(readFileSync(__resumeFile, 'utf-8'));
    let result = await _resumeFromState({ ctx: __ctx, stateJSON: __stateJSON });
    while (isInterrupt(result.data)) {
      const interruptData = result.data;
      const userResponse = await _builtinInput(\`(builtin handler) Agent interrupted: "\${interruptData.data}". Approve? (yes/no) \`);
      if (userResponse.toLowerCase() === 'yes') {
        result = await _approveInterrupt({ ctx: __ctx, interruptObj: interruptData });
      } else {
        result = await _rejectInterrupt({ ctx: __ctx, interruptObj: interruptData });
      }
    }
  } else {
    try {
      const initialState = { messages: [], data: {} };
      await main(initialState);
    } catch (__error) {
      __ctx.stateStack.interruptData.nodesTraversed = __ctx.graph.getNodesTraversed();
      const __stateFile = __filename.replace(/\.js$/, '.state.json');
      writeFileSync(__stateFile, JSON.stringify({ __state: __ctx.stateStack.toJSON(), errorMessage: __error.message }, null, 2));
      console.error(\`\nAgent crashed: \${__error.message}\`);
      console.error(\`State saved to: \${__stateFile}\`);
      console.error(\`Resume with: agency run <file>.agency --resume \${__stateFile}\`);
      throw __error;
    }
  }
}
`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    