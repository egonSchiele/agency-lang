import { decoratorDefProblems } from "../preprocessors/decoratorDesugar.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * A `decorator def` in the wrong shape is AG6043 at the def. The decorator
 * stage reports the same mistake when it runs first, from the same data
 * and the same registry entry; the checker repeats it so a program checked
 * on its own is not accepted, and the editor drops this copy when the
 * stage has already reported (lib/lsp/diagnostics.ts).
 */
export function checkDecoratorDefs(ctx: TypeCheckerContext): void {
  for (const { name, problem, loc } of decoratorDefProblems(ctx.programNodes)) {
    ctx.errors.push(diagnostic("decoratorShape", { name, problem }, loc ?? null));
  }
}
