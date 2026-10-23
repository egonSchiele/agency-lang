import type { AgencyNode, FunctionCall } from "../types.js";
import type { DiagnosticName } from "./diagnostics.js";

/**
 * Which diagnostic a type mismatch becomes, at the three sites a decorated
 * def's mistakes reach (docs/dev/language/decorators.md).
 *
 * A decorator tag lowers to a call with the def's body as its block, so a
 * wrong tag argument, a body return that does not fit the block, and a
 * decorator whose return does not fit the def are all caught by the
 * ordinary call and return checks. Those checks would name the synthesized
 * call. This table gives each site a second entry that names the decorator
 * and the def, used when the call carries `decorator`.
 *
 *     @budgeted(cost: "x")          argument:       decoratorArgType
 *     def f(): number {             declaredReturn: decoratorReturnMismatch
 *       return 5                    blockReturn:    decoratorBodyReturn
 *     }
 *
 * With stacked tags (`@a @b def f`), `return b(...)` sits in `a`'s block, so
 * a block return whose value is itself a decorator's call is the two
 * decorators disagreeing, not the body: the `stacked` entry.
 *
 * The table only names the entry. The sites still decide whether there is a
 * mismatch and where it is reported.
 */
export type MismatchSite = "argument" | "blockReturn" | "declaredReturn";

type MismatchForms = {
  plain: DiagnosticName;
  decorated: DiagnosticName;
  stacked?: DiagnosticName;
};

const MISMATCH_FORMS: Record<MismatchSite, MismatchForms> = {
  argument: { plain: "argNotAssignable", decorated: "decoratorArgType" },
  blockReturn: {
    plain: "typeNotAssignableInContext",
    decorated: "decoratorBodyReturn",
    stacked: "decoratorStackedReturn",
  },
  declaredReturn: { plain: "typeNotAssignableInContext", decorated: "decoratorReturnMismatch" },
};

export type MismatchInput = {
  site: MismatchSite;
  /** argument: the call. blockReturn: the call that owns the block.
   *  declaredReturn: the returned value, when it is a call. */
  owner: FunctionCall | undefined;
  /** The checked value. */
  value: AgencyNode;
  /** The plain entry's own params: `actual` and `expected`, plus `fn` and
   *  `param` for an argument and `context` for a return. */
  params: Record<string, string>;
};

/** A registry entry and the params to render it with. */
export type MismatchEntry = { name: DiagnosticName; params: Record<string, string> };

export function mismatchEntry(input: MismatchInput): MismatchEntry {
  const forms = MISMATCH_FORMS[input.site];
  const origin = input.owner?.decorator;
  if (origin === undefined) {
    return { name: forms.plain, params: input.params };
  }
  const params = {
    ...input.params,
    name: origin.name,
    target: origin.target,
    declared: input.params.expected,
  };
  const inner = input.value.type === "functionCall" ? input.value.decorator : undefined;
  if (forms.stacked !== undefined && inner !== undefined) {
    return { name: forms.stacked, params: { ...params, inner: inner.name } };
  }
  return { name: forms.decorated, params };
}
