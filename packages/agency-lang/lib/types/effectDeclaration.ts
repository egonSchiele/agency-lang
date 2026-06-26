import { BaseNode } from "./base.js";
import type { ObjectType } from "./typeHints.js";
import type { AgencyMultiLineComment } from "../types.js";

/** `effect std::read { dir: string }` — declares the payload type carried by
 *  interrupts of a given effect. Compile-time only (erases in codegen). */
export type EffectDeclaration = BaseNode & {
  type: "effectDeclaration";
  effect: string; // e.g. "std::read", "deploy"
  payloadType: ObjectType; // the `{ ... }` payload object type
  docComment?: AgencyMultiLineComment;
};
