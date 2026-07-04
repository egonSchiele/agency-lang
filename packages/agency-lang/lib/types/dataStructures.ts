import {
  Expression,
  AgencyComment,
  AgencyMultiLineComment,
  NewLine,
} from "../types.js";
import { BaseNode } from "./base.js";

/**
 * Comment / blank-line trivia preserved inside array and object literals so
 * `agency fmt` round-trips losslessly. `anchorIndex` is the index of the
 * item/entry that the trivia immediately precedes; trailing trivia (after the
 * last item) is anchored at the item count. Same shape as
 * `ObjectTypeTrivia`, which does the equivalent for object *type* bodies.
 */
export type Trivia = {
  anchorIndex: number;
  comments: (AgencyComment | AgencyMultiLineComment | NewLine)[];
};

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
  /** Comments/blank lines between items, preserved for the formatter. */
  trivia?: Trivia[];
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
  /** Comments/blank lines between entries, preserved for the formatter. */
  trivia?: Trivia[];
};
