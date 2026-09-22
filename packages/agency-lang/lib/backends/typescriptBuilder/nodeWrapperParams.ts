import { formatTypeHintTs } from "@/utils/formatType.js";
import { walkNodes } from "@/utils/node.js";
import type { AgencyNode } from "../../types.js";
import { ts } from "../../ir/builders.js";
import type { TsNode } from "../../ir/tsIR.js";
import type { FunctionParameter } from "../../types.js";

/**
 * The exported node wrapper's parameter list — what
 * `async function main(name = \`fallback\`, { messages, callbacks } = {})`
 * is built from: the node's own parameters, with their defaults so TS
 * callers can omit them, plus the trailing options object.
 *
 * A default is emitted into the parameter list only when it stands on
 * its own — a literal, or an array or object of literals. That is not
 * every default: the elements of `xs: number[] = [LIMIT]`, and the
 * interpolations of `s: string = "up to ${LIMIT}"`, are names, and a
 * name compiles to a read of the global store through `__globals()`.
 * A parameter default is evaluated before the call, so it would run
 * before `runNode` installs the async-context frame, and `__globals()`
 * returns undefined with no frame — `TypeError: Cannot read properties
 * of undefined` on `worker()`. Those parameters get `undefined` here
 * instead, and the node body fills them.
 *
 * Nothing is lost by that: the body defaults any `__state.data` slot
 * that is undefined, which is the site every invocation path funnels
 * through. The literal case keeps its default only because a signature
 * that states it reads better for a TypeScript caller.
 */
export function nodeWrapperParams(
  args: FunctionParameter[],
  processNode: (node: NonNullable<FunctionParameter["defaultValue"]>) => TsNode,
): { name: string; typeAnnotation?: string; defaultValue?: TsNode }[] {
  const params = args.map((arg) => {
    const annotation = arg.typeHint ? formatTypeHintTs(arg.typeHint) : "any";
    if (arg.defaultValue && !isSelfContained(arg.defaultValue)) {
      return {
        name: arg.name,
        typeAnnotation: `${annotation} | undefined`,
        defaultValue: ts.id("undefined"),
      };
    }
    return {
      name: arg.name,
      typeAnnotation: annotation,
      defaultValue: arg.defaultValue ? processNode(arg.defaultValue) : undefined,
    };
  });
  // Alias each option to a hidden name so a node parameter named `config`,
  // `traceId`, `messages`, or `callbacks` cannot collide with the destructured
  // options. The runtime owns all behavior; this only packages the arguments.
  // `invocationInput` is the one value the caller says the node was given (an
  // eval input, or a harness that names it); the runtime records it as
  // `agentStart.input`. It is never inferred from the parameters, because a
  // plain one-parameter call and an eval input have the same shape. The key
  // is deliberately not `input`: nodes often have a parameter of that name,
  // and `main(input, { input } = {})` would read as the same value twice.
  // `abortSignal` and `pauseSignal` are the caller's cancel and pause handles,
  // passed straight through to `runNode`.
  params.push({
    name: "{ messages: __invocationMessages, callbacks: __invocationCallbacks, config: __invocationConfig, traceId: __invocationTraceId, invocationInput: __invocationInput, abortSignal: __invocationAbortSignal, pauseSignal: __invocationPauseSignal }",
    typeAnnotation:
      "({ messages?: any; callbacks?: any; invocationInput?: unknown; abortSignal?: AbortSignal; pauseSignal?: AbortSignal } & InvocationOptions)",
    defaultValue: ts.obj({}),
  });
  return params;
}

/** True when a default holds nothing but literals, so it can be evaluated
 *  anywhere. A name inside it (`[LIMIT]`, `"up to ${LIMIT}"`) compiles to a
 *  global-store read, which needs a frame the caller has not entered yet. */
function isSelfContained(defaultValue: NonNullable<FunctionParameter["defaultValue"]>): boolean {
  for (const { node } of walkNodes([defaultValue as AgencyNode])) {
    if (node.type === "variableName" || node.type === "functionCall") return false;
  }
  return true;
}
