import { AgencyNode, Expression } from "../types.js";
import { BaseNode } from "./base.js";

export type ParallelBlock = BaseNode & {
  type: "parallelBlock";
  body: AgencyNode[];
  /** Optional `shared: <expr>` opt-in from `parallel(shared: true) { ... }`.
   *  Forwarded by `parallelDesugar` onto the synthesized `fork(arms,
   *  shared: <expr>)` call. Absent means isolated (the default). */
  shared?: Expression;
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
