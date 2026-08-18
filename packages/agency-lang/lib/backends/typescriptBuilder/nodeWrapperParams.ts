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
  // Alias each option to a hidden name so a node parameter named `config`,
  // `traceId`, `messages`, or `callbacks` cannot collide with the destructured
  // options. The runtime owns all behavior; this only packages the arguments.
  // `input` is the one value the caller says the node was given (an eval
  // input, or a harness that names it); the runtime records it on agentStart.
  // It is never inferred from the parameters, because a plain one-parameter
  // call and an eval input have the same shape.
  params.push({
    name: "{ messages: __invocationMessages, callbacks: __invocationCallbacks, config: __invocationConfig, traceId: __invocationTraceId, input: __invocationInput }",
    typeAnnotation: "({ messages?: any; callbacks?: any; input?: unknown } & InvocationOptions)",
    defaultValue: ts.obj({}),
  });
  return params;
}
