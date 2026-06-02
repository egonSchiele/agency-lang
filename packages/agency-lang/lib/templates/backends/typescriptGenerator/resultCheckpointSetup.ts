// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/resultCheckpointSetup.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// \`__resultCheckpointId\` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and \`runner.halt\`
// builds a Failure carrying the entry checkpoint for \`result.retry(...)\`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// per-keystroke cost inside std::ui's repl loop. The cost of always
// pinning outweighs the retry-on-failure feature, so it is disabled.
// \`ctx.checkpoints.get(-1)\` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
{{{paramsStr}}}
}
`;

export type TemplateType = {
  paramsStr: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    