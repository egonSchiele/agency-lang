import { BaseNode } from "./base.js";
import { Literal, VariableNameLiteral } from "./literals.js";
import type { Expression, VariableType } from "../types.js";

export type ObjectPatternProperty = {
  type: "objectPatternProperty";
  key: string;
  // ResultPattern is only valid in match-position use; the parser does not
  // produce it in binding-position contexts.
  value: BindingPattern | Literal | ResultPattern;
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
  // ResultPattern is only valid in match-position use; the parser does not
  // produce it in binding-position contexts.
  elements: (BindingPattern | Literal | WildcardPattern | RestPattern | ResultPattern)[];
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

export type ResultPattern = BaseNode & {
  type: "resultPattern";
  kind: "success" | "failure";
  binding: string | null; // null = bare form (no parens), string = binding identifier
};

// A runtime type test in pattern position. Two spellings share this node:
// `is Type` (pattern: null) and the match-arm bind-and-test `pattern: Type`.
// Deliberately NOT part of BindingPattern — type patterns are illegal in
// let/const/for, where `: Type` must stay a static annotation.
export type TypePattern = BaseNode & {
  type: "typePattern";
  pattern: BindingPattern | null;
  typeHint: VariableType;
};

// The lowered carrier for a type pattern: an expression that tests
// `expression` against `typeHint` at runtime. Produced by pattern lowering,
// compiled away by the TypeScript builder (coarse check or schema
// validation); the type checker narrows on it.
export type TypeTestExpression = BaseNode & {
  type: "typeTestExpression";
  expression: Expression;
  typeHint: VariableType;
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
  | Literal
  | ResultPattern
  | TypePattern;

// Convenience union when context doesn't matter
export type Pattern = MatchPattern;
