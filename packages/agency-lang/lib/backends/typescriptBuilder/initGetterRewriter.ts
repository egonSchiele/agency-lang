import type { Literal } from "../../types.js";
import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";

/**
 * Owns the codegen rules for the cross-module init-getter rewrite
 * that fixes #232.
 *
 * Inside the RHS of a top-level `static const X = …` ("static-init
 * context"), every read of a top-level static — same-module or
 * imported — must be rewritten from a bare identifier into a call to
 * the source module's memoized getter:
 *
 *     X            →   await __init_X(__ctx)
 *
 * This class is the single source of truth for:
 *
 *   1. The `__init_<name>` naming convention.
 *   2. The two rewrite-eligibility predicates (same-module static vs
 *      cross-module imported static).
 *   3. The set of cross-module getters that need an additional
 *      `import { __init_X } from "<dep>"` emitted at the top of the
 *      generated module.
 *
 * Lifecycle:
 *
 *   const rewriter = new InitGetterRewriter();
 *   rewriter.setOwnStaticVarNames(names);     // before any rewrite
 *   const node = rewriter.rewrite(literal, importedConstants, currentVar);
 *   if (node) return node;                    // rewrite hit
 *   ...
 *   for (const [name, modulePath] of rewriter.crossModuleGetters()) {
 *     // emit `import { __init_${name} } from "${compiled(modulePath)}"`
 *     // and one `__requireInitVar(...)` validation call
 *   }
 *
 * The class deliberately holds NO references to the builder, the
 * compilation unit, or the program AST. Inputs come in as method
 * args. That makes the rewrite logic easy to unit-test in isolation
 * and removes a layer of order-dependent mutable state from the
 * builder.
 */
export type ImportedConstantInfo = {
  /** Original import-path string (`"./shared.agency"`) as it appeared
   *  in the source. Resolved to a `.js` compiled path at emission
   *  time, NOT here. */
  modulePath: string;
};

export class InitGetterRewriter {
  /** Same-module top-level `static const` names. Populated once via
   *  `setOwnStaticVarNames` before any rewrite call. */
  private ownStaticVarNames: ReadonlySet<string> = new Set();

  /** Cross-module getters that have been used at least once. Keyed by
   *  local (alias-aware) name; value is the original modulePath
   *  string. Codegen iterates this after all rewrites to emit one
   *  `import { __init_X } from "<dep>"` per entry. */
  private readonly crossModuleGetters_: Map<string, string> = new Map();

  setOwnStaticVarNames(names: ReadonlySet<string>): void {
    this.ownStaticVarNames = names;
  }

  /**
   * Decide whether `literal` (a `variableName` Literal) inside a
   * static-init context should be rewritten to an `__init_*` call,
   * and return the rewritten IR node if so. Returns `null` when no
   * rewrite applies (caller emits the default identifier / scopedVar
   * binding).
   *
   * `currentVar` is the name of the static currently being
   * initialized. A read of that same name resolves to `null` here so
   * the trivially-disallowed self-reference (`static const X = X + 1`)
   * doesn't generate a forward-reference to its own undeclared
   * getter; downstream `__initVar` would catch the cycle anyway, but
   * suppressing the rewrite keeps codegen well-defined.
   */
  rewrite(
    literal: Literal & { type: "variableName" },
    importedConstants: Record<string, ImportedConstantInfo>,
    currentVar: string | null,
  ): TsNode | null {
    if (literal.value === currentVar) return null;

    // Imported-static branch — looked up via the compilation unit's
    // `importedConstants` map (populated when an `import { X } from
    // "./mod.agency"` brought a `static const X` into scope).
    if (literal.scope === "imported" || !literal.scope) {
      const info = importedConstants[literal.value];
      if (!info) return null;
      this.crossModuleGetters_.set(literal.value, info.modulePath);
      return this.buildGetterCall(literal.value);
    }

    // Same-module-static branch.
    if (literal.scope === "static" && this.ownStaticVarNames.has(literal.value)) {
      return this.buildGetterCall(literal.value);
    }

    return null;
  }

  /** Iterable of cross-module getter (localName, modulePath) pairs
   *  recorded during rewrites. Codegen consumes this AFTER all RHS
   *  processing is done. */
  crossModuleGetters(): ReadonlyMap<string, string> {
    return this.crossModuleGetters_;
  }

  // ── naming convention (single source of truth) ──

  /** `__init_X` — the exported getter name for a top-level static. */
  static getterName(varName: string): string {
    return `__init_${varName}`;
  }

  /** `__init_X_compute` — the named async function whose body runs
   *  the static's compute. Named (not anonymous) so V8 stack traces
   *  surface participating vars in init-cycle errors. */
  static computeName(varName: string): string {
    return `__init_${varName}_compute`;
  }

  // ── private ──

  private buildGetterCall(varName: string): TsNode {
    return ts.await(
      ts.call(ts.id(InitGetterRewriter.getterName(varName)), [ts.id("__ctx")]),
    );
  }
}
