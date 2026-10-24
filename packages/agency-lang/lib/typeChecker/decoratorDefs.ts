import {
  aliasResolver,
  decoratorDefDiagnostic,
  decoratorDefProblems,
} from "../preprocessors/decoratorDesugar.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * A `decorator def` in the wrong shape is AG6043 at the def, and a plain
 * def that is a decorator in all but the keyword is AG6045 there. The
 * decorator stage reports the same mistakes when it runs first, from the
 * same data and the same registry entries; the checker repeats them so a
 * program checked on its own is not accepted, and a caller that ran the
 * stage drops these copies (`repeatsDecoratorStage`).
 */
export function checkDecoratorDefs(ctx: TypeCheckerContext): void {
  const resolve = aliasResolver(ctx.scopedTypeAliases.visibleIn(ctx.currentScopeKey));
  for (const found of decoratorDefProblems(ctx.programNodes, resolve)) {
    ctx.errors.push(decoratorDefDiagnostic(found));
  }
}
