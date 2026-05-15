import { BaseNode } from "./base.js";
import { Literal, VariableNameLiteral } from "./literals.js";
import type { Expression } from "../types.js";

export type ObjectPatternProperty = {
  type: "objectPatternProperty";
  key: string;
  value: BindingPattern | Literal;
};

export type ObjectPatternShorthand = {
  type: "objectPatternShorthand";
  name: string;
};

export type ObjectPattern = BaseNode & {
  type: "objectPattern";
  properties: (ObjectPatternProperty | ObjectPatternShorthand | RestPattern)[];
};

export type ArrayPattern = BaseNode & {
  type: "arrayPattern";
  elements: (BindingPattern | Literal | WildcardPattern | RestPattern)[];
};

export type RestPattern = BaseNode & {
  type: "restPattern";
  identifier: string;
};

export type WildcardPattern = BaseNode & {
  type: "wildcardPattern";
};

export type IsExpression = BaseNode & {
  type: "isExpression";
  expression: Expression;
  pattern: MatchPattern;
};

// A binding pattern: only variable bindings, no value-matching.
// Used in let/const LHS and for-loop item position.
export type BindingPattern =
  | ObjectPattern
  | ArrayPattern
  | RestPattern
  | WildcardPattern
  | VariableNameLiteral;

// A match pattern: binders OR literal value matchers.
// Used in match arm LHS and after `is`.
export type MatchPattern =
  | BindingPattern
  | Literal;

// Convenience union when context doesn't matter
export type Pattern = MatchPattern;
