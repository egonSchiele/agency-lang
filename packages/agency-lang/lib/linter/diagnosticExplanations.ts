import type { LintDiagnosticName } from "./diagnostics.js";

/** Long-form explanations for `agency explain <code>`, keyed by rule name. */
export const LINT_EXPLANATIONS: Record<LintDiagnosticName, string> = {
  unusedImport: `An import brings in a name the file never references. Unused
imports add noise and can hide a mistake (an import you meant to use). This is a
hint, not an error — the program still compiles and runs. The editor grays the
name out and offers "Remove unused import"; \`agency lint\` reports it. Names
imported from \`std::index\` and \`import test { … }\` imports are not reported.`,
  missingDocstring: `In Agency, functions are tools: an exported function's
docstring becomes the tool description the LLM reads when deciding whether
and how to call it. An exported function without one gives every agent that
imports it a tool with no description. Add a docstring — terse and
user-facing, describing what the tool does. A comment above the function
does not count: comments never reach the LLM.`,
  redundantPreludeImport: `Every Agency file gets the prelude (print, map,
filter, range, and the rest) without importing anything, so importing one of
those names from \`std::index\` is redundant. Not everything in std::index is
prelude, though: types like \`WriteMode\` must be imported, and an aliased
import (\`map as arrMap\`) or one carrying a \`destructive\`/\`idempotent\`
marker does real work — none of those are reported.`,
  rebuiltFailure: `Inside \`if (x is failure(why))\`, returning \`failure(why)\`
builds a new failure from the message alone. Everything else on \`x\` is lost:
its data, its checkpoint, and its \`rejected\` flag, which is how the tool loop
tells "the user said no" from "the tool broke". A rejected interrupt that
passes through such a rebuild reaches the model as a tool error it may
retry. Return \`x\` itself, which keeps every field, or when a line must be
added to the message, copy the failure instead of rebuilding it.`,
};
