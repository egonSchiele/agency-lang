import { Expression, AgencyComment, AgencyMultiLineComment, NewLine } from "../types.js";
import { BaseNode, LineComment } from "./base.js";

/** A single comment or blank-line node preserved as trivia. */
export type TriviaNode = AgencyComment | AgencyMultiLineComment | NewLine;

/**
 * Comment / blank-line trivia sitting BEFORE an item. `anchorIndex` is the
 * index of the item/entry the trivia immediately precedes; trivia after the
 * last item is anchored at the item count.
 */
export type BeforeListTrivia = {
  anchorIndex: number;
  comments: TriviaNode[];
  /** Omitted by parsers, so existing ASTs keep their exact shape. */
  placement?: "before";
};

/** A `//` comment on the same line as the item it follows. */
export type TrailingListTrivia = {
  anchorIndex: number;
  placement: "trailing";
  comments: [LineComment];
};

/**
 * Trivia preserved inside a multiline list so `agency fmt` round-trips
 * losslessly. Shared by array literals, object literals, and object *type*
 * bodies (which alias this as `ObjectTypeTrivia`).
 */
export type ListTrivia = BeforeListTrivia | TrailingListTrivia;

/** Long-standing name for the same thing. */
export type Trivia = ListTrivia;

export function isTrailingListTrivia(entry: ListTrivia): entry is TrailingListTrivia {
  return entry.placement === "trailing";
}

/** What a list parser produces: items, plus trivia when any was found. */
export type ParsedList<T> = {
  items: T[];
  trivia?: ListTrivia[];
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
