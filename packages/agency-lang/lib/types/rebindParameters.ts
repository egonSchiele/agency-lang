import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";

/** Synthetic first statement of a decorated body's block, inserted by the
 *  decorator lowering. It compiles to one `__rebindParameters` call that
 *  stores the decorated function's parameters on the ENCLOSING function's
 *  frame from the record the block was called with, the way a call would:
 *  defaults, the missing-argument failure, the `!` checks
 *  (docs/dev/language/decorators.md). Never parsed, never formatted.
 *
 *  It is registered with no identifiers of its own on purpose: it writes
 *  the enclosing function's parameters and reads the block parameter named
 *  by `record`, and no walker needs that today. */
export type RebindParameters = BaseNode & {
  type: "rebindParameters";
  /** The decorated def, which is also the name of its module-level constant. */
  functionName: string;
  /** The def's non-block parameters, in order. */
  parameters: FunctionParameter[];
  /** The def's block-typed parameters. A record cannot carry a block, so
   *  the rebind keeps their current values and refuses a record that names
   *  one of them. */
  blockParameters: string[];
  /** The block parameter that holds the record: `__args`. */
  record: string;
  /** The decorator's depth in the stack, 0 for the outermost. The runtime
   *  keys its one-running-block-per-decorator claim on it. */
  depth: number;
};
