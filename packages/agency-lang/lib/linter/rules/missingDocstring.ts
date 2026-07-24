import type { FunctionDefinition } from "../../types/function.js";
import type { LintContext, LintFinding, LintRule } from "../types.js";
import { lintDiagnostic } from "../diagnostics.js";
import { buildLineIndex, nameRange, statementSpan } from "./util.js";

/** Exported functions with no docstring. Functions only: a function's
 *  docstring becomes its tool description in the generated JS
 *  (buildToolDefinition takes a FunctionDefinition); a node's docstring is
 *  read only by `agency doc`. In the lint AST a leading comment is a
 *  sibling node and docComment is never populated (that field is filled by
 *  the TypescriptPreprocessor, which the linter does not run), so the
 *  docString check is the complete test. */
function undocumentedExports(
  ctx: LintContext,
): (FunctionDefinition & { functionName: string })[] {
  return ctx.program.nodes.filter(
    (node): node is FunctionDefinition & { functionName: string } =>
      node.type === "function" &&
      node.exported === true &&
      !node.docString &&
      // A Hole-named function is a template fragment, not a real export.
      typeof node.functionName === "string",
  );
}

export const missingDocstringRule: LintRule = {
  name: "missingDocstring",
  run(ctx: LintContext): LintFinding[] {
    const lineIndex = buildLineIndex(ctx.source);
    return undocumentedExports(ctx).map((fn) => {
      const span = statementSpan(ctx.source, fn);
      const range = nameRange(ctx.source, span.start, span.end, fn.functionName, lineIndex);
      return lintDiagnostic("missingDocstring", { name: fn.functionName }, range);
    });
  },
};
