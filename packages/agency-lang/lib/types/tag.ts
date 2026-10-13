import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

export type Tag = BaseNode & {
  type: "tag";
  name: string;
  arguments: Expression[];
  /** Whether the tag was written with parentheses. `@capabilities()` and
   *  `@capabilities` mean the same thing; the formatter keeps the spelling. */
  parentheses?: boolean;
};
