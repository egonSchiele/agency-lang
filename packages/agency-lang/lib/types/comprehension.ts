import type { Expression } from "../types.js";
import type { BaseNode } from "./base.js";
import type { ArrayPattern, ObjectPattern } from "./pattern.js";

/** A list comprehension, `[expr for x in xs if cond]`, or its concurrent
 *  form `fork [expr for x in xs if cond]` (spec:
 *  docs/superpowers/specs/2026-07-18-list-comprehensions-design.md).
 *
 *  The binder fields mirror ForLoop deliberately: `itemVar` may be a name
 *  or a destructuring pattern, and `indexVar` is the optional second
 *  binder, meaning the index for arrays and the value for objects.
 *  Reusing that shape means the comprehension inherits the loop's
 *  semantics rather than inventing its own.
 *
 *  Lifecycle: the parser and agencyGenerator (for `agency fmt`) see this
 *  node; comprehensionDesugar rewrites it into map/filter/fork calls
 *  inside parseAgency's `lower` block, so the checker, the builder, and
 *  the runtime never see it. */
export type Comprehension = BaseNode & {
  type: "comprehension";
  expression: Expression;
  itemVar: string | ObjectPattern | ArrayPattern;
  indexVar?: string;
  iterable: Expression;
  condition?: Expression;
  /** True for `fork [...]`. Selects the desugar target: fork vs map. */
  parallel: boolean;
};
