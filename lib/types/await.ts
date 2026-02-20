import { ValueAccess } from "./access.js";
import { FunctionCall } from "./function.js";
import { Literal } from "./literals.js";

export type AwaitStatement = {
  type: "awaitStatement";
  expression:
  | ValueAccess
  | Literal
  | FunctionCall
};