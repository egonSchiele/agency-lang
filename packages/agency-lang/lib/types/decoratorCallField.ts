import type { BaseNode } from "./base.js";

/** Metadata requested by decorator lowering and supplied by code generation.
 *  A synthetic expression with no Agency source form. */
export type DecoratorCallField = BaseNode &
  (
    | {
        type: "decoratorCallField";
        field: "id";
        /** Original definition name, unaffected by renamed or partial copies. */
        functionName: string;
      }
    | {
        type: "decoratorCallField";
        field: "inToolCall";
      }
  );
