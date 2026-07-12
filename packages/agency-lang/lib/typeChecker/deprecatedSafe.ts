import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * Warn on user-written uses of the deprecated `safe` keyword — on defs and
 * on `import { safe x }` from a JS module. `safe` is inert from the moment
 * its registry feed was removed, so the "has no effect" wording is truthful.
 * Removed entirely in a later release.
 *
 * This pass runs after `resolveImports`, which replaces user Agency imports
 * (and the auto-imported stdlib prelude) with synthesized imports whose
 * safeNames come from the still-`safe` stdlib, not from the user. Only JS
 * imports (`isAgencyImport === false`) survive resolution unchanged, so the
 * import branch is scoped to them — warning on the synthesized Agency
 * imports would false-positive on every file via the prelude. `safe` on an
 * Agency import or an `export { safe x } from` is therefore not flagged
 * (both are rewritten before this runs); the def case, which covers the
 * stdlib's 253 uses and any user def, is the one that matters.
 */
export function checkDeprecatedSafe(ctx: TypeCheckerContext): void {
  for (const node of ctx.programNodes) {
    if (node.type === "function" && node.safe) {
      ctx.errors.push(diagnostic("deprecatedSafe", {}, node.loc ?? null));
      continue;
    }
    if (node.type === "importStatement" && !node.isAgencyImport) {
      const hasSafe = node.importedNames.some(
        (n) => n.type === "namedImport" && n.safeNames.length > 0,
      );
      if (hasSafe) {
        ctx.errors.push(diagnostic("deprecatedSafe", {}, node.loc ?? null));
      }
    }
  }
}
