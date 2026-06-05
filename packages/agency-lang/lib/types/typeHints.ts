import { AgencyComment, AgencyMultiLineComment, NewLine } from "../types.js";
import type { FunctionParameter } from "./function.js";
import { BaseNode } from "./base.js";
import type { Tag } from "./tag.js";
import type { Expression } from "../types.js";

/**
 * When adding a new variant to `VariableType`, also add a case to:
 *
 * - `substituteValueArgsInType` and `checkType` in
 *   `lib/typeChecker/valueParamSubstitution.ts` — both functions have
 *   exhaustive switches over this union (enforced by a `never`-typed
 *   default branch, so TypeScript will fail to compile if you forget).
 *
 * Codegen sites (`mapTypeToSchema`, `descriptor`, `hasAnyValidateTag`)
 * also branch on `VariableType.type`; review them when adding a
 * variant.
 */
export type VariableType =
  | PrimitiveType
  | ArrayType
  | StringLiteralType
  | NumberLiteralType
  | BooleanLiteralType
  | UnionType
  | ObjectType
  | TypeAliasVariable
  | BlockType
  | ResultType
  | SchemaType
  | FunctionRefType
  | GenericType;

/**
 * A concrete generic-type usage: Record<string, number>, Container<string>, etc.
 * Built-in generic names (Array, Schema, Record) are normalized by
 * `resolveType` in the type checker; user-defined names are looked up in
 * the type alias registry and substituted.
 */
export type GenericType = {
  type: "genericType";
  name: string;
  typeArgs: VariableType[];
  /**
   * Value arguments at the use site of a value-parameterized alias.
   * Example: `BoundedList<string>(3)` — typeArgs is `[string]`, valueArgs is `[3]`.
   * Restricted to the same expression subset accepted by tag arguments.
   */
  valueArgs?: Expression[];
  tags?: Tag[];
};

/**
 * A type parameter declaration on a generic type alias.
 * Example: in `type Container<T> = { value: T }`, the `T` is a TypeParam.
 * Defaults allow bare use of the alias: `type StringMap<V = any> = Record<string, V>`.
 */
export type TypeParam = {
  name: string;
  default?: VariableType;
};

/**
 * A value-parameter declaration on a value-parameterized type alias.
 * Example: in `type NumberInRange(low: number, high: number) = number`,
 * each of `low` and `high` is a ValueParam.
 *
 * The `default` expression, if present, is restricted to the same
 * subset of expressions accepted by tag arguments (literals,
 * identifiers that resolve to a top-level `static const`, object
 * literals built from the above).
 */
export type ValueParam = {
  name: string;
  type: VariableType;
  default?: Expression;
};

/**
 * Entry in the type alias registry. For non-generic aliases `typeParams`
 * is absent; for generic aliases it carries the declared parameters.
 *
 * `tags` carries `@validate(...)` / `@jsonSchema(...)` annotations from
 * the alias declaration so they propagate across module boundaries and
 * re-exports. They are attached onto the resolved type by `resolveType`.
 */
export type TypeAliasEntry = {
  body: VariableType;
  typeParams?: TypeParam[];
  /**
   * Value parameters for value-parameterized aliases (e.g. `low` and
   * `high` in `type NumberInRange(low: number, high: number) = number`).
   * Carried alongside `typeParams` so the resolver can substitute
   * literal arguments into the alias's tag expressions.
   */
  valueParams?: ValueParam[];
  tags?: Tag[];
};

export type ResultType = {
  type: "resultType";
  successType: VariableType;
  failureType: VariableType;
  tags?: Tag[];
};

/**
 * `Schema<T>` — synthesized type of a `schema(T)` expression. The runtime
 * `Schema` class wraps a zod schema and exposes `.parse(...)` /
 * `.parseJSON(...)`, both returning `Result<T, any>`. Carrying `inner`
 * lets the typechecker track the validated type through the call chain
 * (e.g. `schema(MyType).parse(x)` → `Result<MyType, any>`).
 */
export type SchemaType = {
  type: "schemaType";
  inner: VariableType;
  tags?: Tag[];
};

export type BlockType = {
  type: "blockType";
  params: { name: string; typeAnnotation: VariableType }[];
  returnType: VariableType;
  tags?: Tag[];
};

export type PrimitiveType = {
  type: "primitiveType";
  value: string;
  tags?: Tag[];
};

export type ArrayType = {
  type: "arrayType";
  elementType: VariableType;
  tags?: Tag[];
};

export type StringLiteralType = {
  type: "stringLiteralType";
  value: string;
  tags?: Tag[];
};

export type NumberLiteralType = {
  type: "numberLiteralType";
  value: string;
  tags?: Tag[];
};

export type BooleanLiteralType = {
  type: "booleanLiteralType";
  value: "true" | "false";
  tags?: Tag[];
};

export type UnionType = {
  type: "unionType";
  types: VariableType[];
  tags?: Tag[];
};

export type ObjectProperty = {
  key: string;
  value: VariableType;
  description?: string;
  /**
   * `@validate(...)` and `@jsonSchema(...)` annotations on this property.
   * Parsed inside `objectTypeParser` from any `@tag(...)` lines above
   * the property within an object-type body.
   */
  tags?: Tag[];
};

/**
 * Formatter-only trivia attached to an `ObjectType`. Each entry anchors
 * one or more comments / blank lines at a position in `properties`:
 *
 *   - `anchorIndex: 0` — appears before the first property
 *   - `anchorIndex: N` (0 < N < properties.length) — appears between
 *     properties N-1 and N
 *   - `anchorIndex: properties.length` — appears after the last property
 *
 * Multiple consecutive comments at the same anchor live as multiple
 * elements of `comments`, in source order, each retaining its original
 * node type (`comment` vs. `multiLineComment`). The formatter dispatches
 * on `node.type` and emits each in its original `//` or `/* * /` syntax.
 *
 * Trivia is *not* semantic — no consumer outside the agency formatter
 * should read it.
 */
export type ObjectTypeTrivia = {
  anchorIndex: number;
  comments: (AgencyComment | AgencyMultiLineComment | NewLine)[];
};

export type ObjectType = {
  type: "objectType";
  properties: ObjectProperty[];
  /**
   * Optional comment / blank-line trivia between properties, preserved
   * for the formatter. Sorted by `anchorIndex` ascending; at most one
   * entry per anchor.
   */
  trivia?: ObjectTypeTrivia[];
  tags?: Tag[];
};

export type TypeAlias = BaseNode & {
  type: "typeAlias";
  aliasName: string;
  aliasedType: VariableType;
  typeParams?: TypeParam[];
  /**
   * Value parameters declared after the optional `< ... >` block.
   * Example: `type NumberInRange(low: number, high: number) = number`.
   */
  valueParams?: ValueParam[];
  exported?: boolean;
  docComment?: AgencyMultiLineComment;
  tags?: Tag[];
};

export type FunctionRefType = {
  type: "functionRefType";
  name: string;
  params: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
  tags?: Tag[];
};

export type TypeAliasVariable = {
  type: "typeAliasVariable";
  aliasName: string;
  /**
   * Value arguments at the use site of a value-parameterized alias.
   * Example: `Age(18)` — aliasName is `Age`, valueArgs is `[18]`.
   * Restricted to the same expression subset accepted by tag arguments.
   */
  valueArgs?: Expression[];
  tags?: Tag[];
};
