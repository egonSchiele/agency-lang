import { BaseNode } from "./base.js";

/** Synthetic, bodyless statement emitted by parallelDesugar when it inlines a
 *  `destructive` seqBlock. Codegen turns it into `__self.__destructiveRan = true`
 *  on the ENCLOSING function activation (the seqBlock is inlined, so `__self` is
 *  the function). Never parsed, never formatted (introduced after typecheck). */
export type MarkDestructiveRan = BaseNode & {
  type: "markDestructiveRan";
};
