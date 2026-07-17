import type { AgencyNode, BaseNode, Expression } from "../types.js";
import type { NamedArgument, SplatExpression } from "./dataStructures.js";

/** The `guard(head) { body }` construct (spec:
 *  docs/superpowers/specs/2026-07-17-guard-keyword-design.md). The
 *  head is an ordinary call argument list, parsed by the same
 *  `argumentListParser` function calls use and carried VERBATIM —
 *  validation is not the parser's job. The desugar forwards these
 *  arguments into the `_guard` call, whose signature
 *  (cost/time/label/block, stdlib/index.agency) the existing call
 *  checks enforce, so a bad head gets the same diagnostics a bad call
 *  always got.
 *
 *  Lifecycle: the parser and `patternLowering` see this node; the
 *  TypeChecker desugars it away in its constructor
 *  (lib/preprocessors/guardDesugar.ts), so from typing onward it is a
 *  `_guard` call + blockArgument — the exact shape the legacy
 *  `guard(...) as { }` syntax parsed to. The `_guard` synthesizer case
 *  restores `Result<T>` typing on top of that shape, and the
 *  interrupt-effect analysis sees the call's seeded `std::guard`
 *  effect. The builder and the runtime never see this node. */
export type GuardBlock = BaseNode & {
  type: "guardBlock";
  arguments: (Expression | SplatExpression | NamedArgument)[];
  body: AgencyNode[];
};
