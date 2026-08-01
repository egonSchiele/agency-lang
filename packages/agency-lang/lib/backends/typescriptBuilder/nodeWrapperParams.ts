import { formatTypeHintTs } from "@/utils/formatType.js";
import { ts } from "../../ir/builders.js";
import type { TsNode } from "../../ir/tsIR.js";
import type { FunctionParameter } from "../../types.js";

/**
 * The exported node wrapper's parameter list — what
 * `async function main(name = \`fallback\`, { messages, callbacks } = {})`
 * is built from: the node's own parameters, with their defaults so TS
 * callers can omit them, plus the trailing options object.
 *
 * Emitting the parsed default straight into a parameter list is safe
 * only because parameter defaults are LITERAL-ONLY — the AST type pins
 * it (`defaultValue?: Literal | AgencyArray | AgencyObject`,
 * lib/types/function.ts), and the parser rejects calls and identifiers.
 * If defaults were ever relaxed to allow expressions, the processed
 * default could reference runtime scope (or become an await) and this
 * would have to switch to optional parameters resolved in the body.
 *
 * Note the interplay with the body-site default: on this wrapper path JS
 * fills the parameter before `data` is built, so the body's
 * undefined-check never fires here — it exists for goto transitions and
 * anything else that feeds `__state.data` directly.
 */
export function nodeWrapperParams(
  args: FunctionParameter[],
  processNode: (node: NonNullable<FunctionParameter["defaultValue"]>) => TsNode,
): { name: string; typeAnnotation?: string; defaultValue?: TsNode }[] {
  const params = args.map((arg) => ({
    name: arg.name,
    typeAnnotation: arg.typeHint ? formatTypeHintTs(arg.typeHint) : "any",
    defaultValue: arg.defaultValue ? processNode(arg.defaultValue) : undefined,
  }));
  params.push({
    name: "{ messages, callbacks }",
    typeAnnotation: "{ messages?: any; callbacks?: any }",
    defaultValue: ts.obj({}),
  });
  return params;
}
