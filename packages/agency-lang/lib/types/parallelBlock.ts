import type { ListTrivia } from "./dataStructures.js";
import { AgencyNode, Expression } from "../types.js";
import { BaseNode } from "./base.js";

export type ParallelBlock = BaseNode & {
  type: "parallelBlock";
  body: AgencyNode[];
  /** Optional `shared: <expr>` opt-in from `parallel(shared: true) { ... }`.
   *  Forwarded by `parallelDesugar` onto the synthesized `fork(arms,
   *  shared: <expr>)` call. Absent means isolated (the default). */
  shared?: Expression;
  /** Comments between the named arguments. */
  argumentTrivia?: ListTrivia[];
  /** Set only by the `async` lowering (asyncDesugar.ts) on the block it
   *  builds from `async f()`: arm 0 is the call, arm 1 the rest of the
   *  block. `parallelDesugar` then gives arm 1 the parent's conversation
   *  thread, marks its normal completion, and writes the join check. No
   *  syntax sets it. See docs/dev/runtime/async.md. */
  origin?: "async";
};

export type SeqBlock = BaseNode & {
  type: "seqBlock";
  body: AgencyNode[];
  /** True when written as `destructive { ... }` rather than `seq { ... }`.
   *  Marks the region destructive: parallelDesugar prepends a
   *  `markDestructiveRan` when inlining it, and the formatter prints
   *  `destructive {`. */
  destructive?: boolean;
};
