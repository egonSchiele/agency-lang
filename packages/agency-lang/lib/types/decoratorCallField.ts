import type { BaseNode } from "./base.js";

/** Compiler-only decorator metadata with no Agency source syntax. */
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
