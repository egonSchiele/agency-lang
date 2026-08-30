import type { ListTrivia } from "./dataStructures.js";
import { BaseNode } from "./base.js";
import { Literal, VariableNameLiteral } from "./literals.js";
import type { Expression, VariableType } from "../types.js";

export type ObjectPatternProperty = {
  type: "objectPatternProperty";
  key: string;
  // ResultPattern, EffectPattern, and TypePattern are only valid in
  // match-position use; the parser does not produce them in binding-position
  // contexts.
  value: BindingPattern | Literal | ResultPattern | EffectPattern | TypePattern;
};

export type ObjectPatternShorthand = {
  type: "objectPatternShorthand";
  name: string;
};

export type ObjectPattern = BaseNode & {
  type: "objectPattern";
  properties: (ObjectPatternProperty | ObjectPatternShorthand | RestPattern)[];
  /** Comments between properties. */
  propertyTrivia?: ListTrivia[];
};

export type ArrayPattern = BaseNode & {
  type: "arrayPattern";
  // ResultPattern, EffectPattern, and TypePattern are only valid in
  // match-position use; the parser does not produce them in binding-position
  // contexts.
  elements: (
    | BindingPattern
    | Literal
    | WildcardPattern
    | RestPattern
    | ResultPattern
    | EffectPattern
    | TypePattern
  )[];
  /** Comments between elements. */
  elementTrivia?: ListTrivia[];
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

// An interrupt effect in match position: `std::read` matches any interrupt
// whose effect is `std::read`, and `std::read({ data })` also destructures the
// interrupt's fields. The scrutinee is the whole interrupt (`match(intr)`), so
// the binding is an object pattern over `intr`, not a single identifier.
//
// Like ResultPattern, this lives only in MatchPattern (match arms and after
// `is`), never in BindingPattern, so it is illegal in let/const/for.
export type EffectPattern = BaseNode & {
  type: "effectPattern";
  // The namespaced effect name, e.g. "std::read".
  effect: string;
  // null = bare `std::read`; an object pattern = `std::read({ data })`.
  binding: ObjectPattern | null;
};

// A runtime type test in pattern position. Two spellings share this node:
// `is Type` (pattern: null) and the bind-and-test `pattern: Type`.
//
// The suffix attaches to a whole PATTERN — a binder, an object pattern, or an
// array pattern — never to an object field. `{ name: n }: {name: string}` is
// the spelling; there is no per-field form. It is legal wherever a match
// pattern appears, at any depth.
//
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
  ObjectPattern | ArrayPattern | RestPattern | WildcardPattern | VariableNameLiteral;

// A match pattern: binders OR literal value matchers.
// Used in match arm LHS and after `is`.
export type MatchPattern = BindingPattern | Literal | ResultPattern | TypePattern | EffectPattern;

// Convenience union when context doesn't matter
export type Pattern = MatchPattern;
