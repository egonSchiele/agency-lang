import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

export type SplatExpression = {
  type: "splat";
  value: Expression;
};

export type NamedArgument = {
  type: "namedArgument";
  name: string;
  value: Expression;
};

export type AgencyArray = BaseNode & {
  type: "agencyArray";
  items: (Expression | SplatExpression)[];
};

export type AgencyObjectKV = {
  /** Static key. When `computedKey` is set, this is `""` and consumers
   *  should use `computedKey` instead. */
  key: string;
  /** Computed key expression (`{ [expr]: value }`). When set, the entry's
   *  key is determined at runtime; consumers that need a static key must
   *  fall back to treating the containing object as `Record<string, V>`. */
  computedKey?: Expression;
  value: Expression;
};
export type AgencyObject = BaseNode & {
  type: "agencyObject";
  entries: (AgencyObjectKV | SplatExpression)[];
};
