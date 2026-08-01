import type { TsNode } from "@/ir/tsIR.js";
import { ts } from "@/ir/builders.js";
import renderDirectRunArgsCheck from "@/templates/backends/typescriptGenerator/directRunArgsCheck.js";

/**
 * Guard at the top of a compiled file's direct-run block (`node file.js
 * <args>` — the path `agency run file.agency <args>` takes). More argv
 * entries than `main` has parameters exit 1 naming the extras, instead of
 * being silently dropped: the common typo is an extra or mis-quoted
 * trailing argument, and dropping it runs the agent against the wrong
 * input without a word. Missing arguments stay permitted — absent argv
 * entries are undefined, so parameter defaults apply.
 */
export function directRunExtraArgsCheck(mainParamCount: number): TsNode {
  const rendered = renderDirectRunArgsCheck({
    paramCount: mainParamCount,
    // argv[0] is node, argv[1] the script; parameters map from argv[2] on.
    extraStart: 2 + mainParamCount,
  });
  return ts.raw(rendered.trimEnd());
}
