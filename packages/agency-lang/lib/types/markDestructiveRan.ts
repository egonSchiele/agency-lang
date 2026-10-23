import { BaseNode } from "./base.js";

/** Synthetic, bodyless statement emitted by parallelDesugar when it inlines a
 *  `destructive` seqBlock. Codegen turns it into
 *  `__activation.__destructiveRan = true` on the ENCLOSING function activation,
 *  wherever the region sits, a block argument included
 *  (docs/dev/language/destructive-regions.md). Never parsed, never formatted
 *  (introduced after typecheck). */
export type MarkDestructiveRan = BaseNode & {
  type: "markDestructiveRan";
};
