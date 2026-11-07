import type { AgencyNode, AgencyProgram } from "../types.js";
import type { BlockArgument } from "../types/blockArgument.js";
import type { HandleBlock } from "../types/handleBlock.js";
import { walkNodesArray } from "../utils/node.js";

/** A handle block whose handler is written inline. */
type InlineHandleBlock = HandleBlock & {
  handler: Extract<HandleBlock["handler"], { kind: "inline" }>;
};

/**
 * An inline handler function, `handle { } with (intr) { ... }`, compiles as
 * a block argument: the same shape as the `{ ... }` of `map(xs) as x { }`.
 * A block gets its own step counters and its own frame on every call, so
 * every statement in the handler function runs on every run, each run has
 * its own variables, and a `return` anywhere in it returns from it. A named
 * function used as a handler already works this way; this pass gives an
 * inline one the same shape (issue #1373).
 *
 * The handler stays `kind: "inline"` with its `param`. Its `body` becomes
 * one `blockArgument` whose params are the handler's parameter and whose
 * body is the original statements. Every tree walker already descends into
 * `handler.body`, and every scope resolver already treats a `blockArgument`
 * as a block scope, so no walker changes. `handlerFunctionBlock` is the one
 * place that knows this shape; the builder reads it.
 *
 * Runs in `TypescriptPreprocessor.preprocess` after the hoist pass (so a
 * handler function stays unhoisted, as before) and before scope resolution
 * (so the block gets block scope). Every other consumer of `handler.body`
 * runs before `preprocess()` or on a fresh parse, so the type checker and
 * the formatter see the original tree. Mutates in place, like
 * `desugarAsyncInProgram`; running it twice changes nothing.
 */
export function desugarHandlerFunctionsInProgram(program: AgencyProgram): void {
  // Collect first, then mutate, so the walk is not disturbed. The original
  // statement array moves into the block unchanged, so an inner handle
  // block the walk already found is still the same object.
  const inlineHandlers = walkNodesArray(program.nodes)
    .map(({ node }) => node)
    .filter(
      (node): node is InlineHandleBlock =>
        node.type === "handleBlock" && node.handler.kind === "inline",
    )
    .filter((node) => !handlerFunctionBlock(node.handler));
  for (const node of inlineHandlers) {
    const body = node.handler.body;
    const block: BlockArgument = {
      type: "blockArgument",
      params: [node.handler.param],
      body,
      loc: body[0]?.loc ?? node.loc,
    };
    node.handler.body = [block];
  }
}

/** The block the pass produced for this handler, or undefined when the
 *  handler is a function reference or has not been lowered. */
export function handlerFunctionBlock(handler: HandleBlock["handler"]): BlockArgument | undefined {
  if (handler.kind !== "inline") return undefined;
  const only: AgencyNode | undefined = handler.body.length === 1 ? handler.body[0] : undefined;
  if (only === undefined || only.type !== "blockArgument") return undefined;
  if (only.params.length !== 1 || only.params[0] !== handler.param) return undefined;
  return only;
}
