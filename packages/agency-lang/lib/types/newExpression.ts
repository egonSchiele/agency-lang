import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

/**
 * `new Foo(args)` expression for instantiating a JS class imported from
 * TypeScript (e.g. `new ThreadStore()`, `new RuntimeContext(...)`).
 *
 * Agency does not have its own class-definition syntax — this AST node
 * exists purely as a passthrough to the underlying JS `new` operator.
 */
export type NewExpression = BaseNode & {
  type: "newExpression";
  className: string;
  arguments: Expression[];
};
