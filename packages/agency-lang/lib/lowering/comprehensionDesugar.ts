import type {
  AgencyNode,
  Assignment,
  Expression,
  NamedArgument,
} from "../types.js";
import type { BlockArgument } from "../types/blockArgument.js";
import type { Comprehension } from "../types/comprehension.js";
import type { FunctionCall } from "../types/function.js";
import type { VariableNameLiteral } from "../types/literals.js";

/**
 * Rewrite every `comprehension` node into ordinary `map` / `filter` /
 * `fork` calls carrying block arguments - the exact shape those calls
 * have when written by hand. After this pass the rest of the compiler
 * cannot tell the construct existed, so typing, codegen, interrupts,
 * and fork branch semantics are inherited rather than reimplemented.
 *
 * Runs inside parseAgency's `if (lower)` block, BEFORE lowerPatterns, so
 * a destructuring binder becomes an ordinary pattern assignment that
 * lowerPatterns then handles with its existing machinery.
 *
 * MUTATES IN PLACE, for the same reason guardDesugar does: consumers
 * hold references to the same node objects, so a copying rewrite would
 * leave half the pipeline looking at stale bodies. Idempotent - a second
 * run finds no comprehension nodes.
 *
 * The `fork` case emits a real `fork` functionCall node rather than
 * calling a helper. `fork` is NOT a function: the builder intercepts it
 * at typescriptBuilder.ts processFunctionCall and compiles the block body
 * differently, supplying the branch stack and per-branch frames. A helper
 * receiving an ordinary lifted block would get none of that.
 * parallelDesugar.ts synthesizes the same shape for `parallel { }`, which
 * proves it compiles.
 */
export function desugarComprehensionsInBody(
  body: AgencyNode[],
): AgencyNode[] {
  body.forEach((node, i) => {
    body[i] = desugarNode(node);
  });
  return body;
}

/** The generated block parameter. Double underscore is compiler-reserved,
 *  so it cannot collide with a user binder. */
const PARAM = "__comprehensionItem";

/**
 * Apply `fn` to every object-valued child and put the result back.
 *
 * Deliberately generic rather than driven by `bodySlots` or
 * `expressionChildren`. `bodySlots` covers statement bodies only, and
 * `expressionChildren` is a read view with no writer, so neither alone
 * reaches every place a comprehension can appear: call arguments, object
 * literal fields, array items, binary operands, interpolations. A
 * hardcoded key list develops coverage holes; this cannot.
 *
 * `loc` is skipped because it holds plain position data, not nodes.
 */
function mapChildren(node: any, fn: (child: any) => any): void {
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((item, i) => {
        if (item && typeof item === "object") child[i] = fn(item);
      });
    } else if (child && typeof child === "object") {
      node[key] = fn(child);
    }
  }
}

function desugarNode(node: AgencyNode): AgencyNode {
  if (!node || typeof node !== "object") return node;

  // Recurse first, so nested comprehensions lower innermost-out.
  mapChildren(node, desugarNode);

  if (node.type !== "comprehension") return node;
  return lower(node as Comprehension);
}

function varRef(name: string): VariableNameLiteral {
  return { type: "variableName", value: name };
}

function blockArg(body: AgencyNode[], paramName: string): BlockArgument {
  return {
    type: "blockArgument",
    params: [{ type: "functionParameter", name: paramName }],
    body,
  };
}

function call(
  functionName: string,
  args: (Expression | NamedArgument)[],
  block: BlockArgument,
): FunctionCall {
  return { type: "functionCall", functionName, arguments: args, block };
}

/** mode -> the call the comprehension lowers to. Keyed on the type, so
 *  a new mode is a compile error here rather than a silent fallthrough. */
const CALL_NAME: Record<Comprehension["mode"], string> = {
  seq: "map",
  fork: "fork",
  race: "race",
};

/** The `shared: true` named argument, in exactly the shape the parser
 *  produces for hand-written `fork(xs, shared: true)` and the builder
 *  pulls off in processForkCall. BooleanLiteral value is a real boolean
 *  (unlike NumberLiteral, whose value is a string). */
function sharedArg(): NamedArgument {
  return {
    type: "namedArgument",
    name: "shared",
    value: { type: "boolean", value: true },
  };
}

function returnStmt(value: Expression): AgencyNode {
  return { type: "returnStatement", value } as AgencyNode;
}

/** The block parameter name. A single-name binder becomes the parameter
 *  directly, which keeps the user's own name in generated code and in
 *  diagnostics. Every other shape needs unpacking in the body, so it
 *  takes the reserved name. */
function paramNameFor(node: Comprehension): string {
  return typeof node.itemVar === "string" && !node.indexVar
    ? node.itemVar
    : PARAM;
}

/** `<paramName>[position]` - recovers one binder from a pair. The block
 *  parameter name is passed in rather than assuming PARAM, so this cannot
 *  silently read an out-of-scope name if paramNameFor ever grows a case.
 *  NumberLiteral carries its value as a STRING (lib/types/literals.ts,
 *  and parallelDesugar's numLit helper). */
function pairIndex(paramName: string, position: number): Expression {
  return {
    type: "valueAccess",
    base: varRef(paramName),
    chain: [
      { kind: "index", index: { type: "number", value: String(position) } },
    ],
  } as unknown as Expression;
}

/** `const <name> = <value>` */
function bindName(name: string, value: Expression): Assignment {
  return { type: "assignment", variableName: name, declKind: "const", value };
}

/** `const <pattern> = <value>` - used for destructuring binders, because
 *  a destructured BLOCK PARAMETER does not parse (`map(xs) as ([a, b]) { }`
 *  fails with "expected node body"), while destructuring in a `const`
 *  works fine.
 *
 *  `pattern` is the field lowerPatterns keys on (patternLowering.ts,
 *  `if (!node.pattern)`). It creates its own temp and calls
 *  extractBindings, and never reads `variableName` on that path, so the
 *  empty string is inert rather than a placeholder. */
function bindPattern(
  pattern: Comprehension["itemVar"],
  value: Expression,
): Assignment {
  return {
    type: "assignment",
    variableName: "",
    pattern: pattern as Assignment["pattern"],
    declKind: "const",
    value,
  };
}

/** Bind one binder target, whichever shape it is. */
function bindTarget(
  target: Comprehension["itemVar"],
  value: Expression,
): Assignment {
  return typeof target === "string"
    ? bindName(target, value)
    : bindPattern(target, value);
}

/** The statements the block body must run before the user's expression,
 *  to recover the binders from the block parameter.
 *
 *  Empty for a single-name binder, which IS the parameter. A two-binder
 *  form unpacks both halves of a `_pairsOf` pair. A destructuring binder
 *  binds the whole parameter through its pattern. */
function unpackStatements(
  node: Comprehension,
  paramName: string,
): AgencyNode[] {
  if (node.indexVar) {
    return [
      bindTarget(node.itemVar, pairIndex(paramName, 0)),
      bindName(node.indexVar, pairIndex(paramName, 1)),
    ];
  }
  if (typeof node.itemVar !== "string") {
    return [bindTarget(node.itemVar, varRef(paramName))];
  }
  return [];
}

/** The collection the map runs over.
 *
 *  A two-binder form pairs the items with their indices BEFORE any
 *  filtering, so the index is the position in the SOURCE, matching
 *  Python's enumerate-then-filter order. Filtering first would number the
 *  output instead, which is a silent wrong-answer bug rather than an
 *  error. Order here is load-bearing: `_pairsOf` must be innermost. */
function comprehensionSource(
  node: Comprehension,
  unpack: AgencyNode[],
  paramName: string,
): Expression {
  const paired: Expression = node.indexVar
    ? ({
        type: "functionCall",
        functionName: "_pairsOf",
        arguments: [node.iterable],
      } as FunctionCall)
    : node.iterable;

  if (!node.condition) return paired;

  return call(
    "filter",
    [paired],
    blockArg([...unpack, returnStmt(node.condition)], paramName),
  );
}

/** Copy the comprehension's source location onto a synthesized node and
 *  everything under it. Without this, a type error inside a comprehension
 *  body points at generated `map(...)` internals instead of the line the
 *  user wrote. See docs/dev/locations.md.
 *
 *  Only fills a MISSING loc, so nodes carried over from the user's source
 *  (the body expression, the iterable, the condition) keep their own real
 *  positions. It DOES descend into those carried subtrees: any node the
 *  parser left unstamped picks up the comprehension's location, which is
 *  deliberate - a location on the right line beats no location at all.
 *  Uses the same `mapChildren` traversal as `desugarNode` - one walking
 *  strategy per file. */
function stampLoc<T>(target: T, loc: Comprehension["loc"]): T {
  if (!loc || !target || typeof target !== "object") return target;
  const node = target as any;
  if (node.type && !node.loc) node.loc = loc;
  mapChildren(node, (child) => stampLoc(child, loc));
  return target;
}

function lower(node: Comprehension): FunctionCall {
  const paramName = paramNameFor(node);
  // unpackStatements is called ONCE PER BLOCK, deliberately. The filter
  // block and the map block are different scopes, and scope resolution
  // stamps scope/blockDepth onto assignment and variable nodes per
  // enclosing block. If the two blocks shared the same node instances,
  // whichever block is processed second would overwrite the first
  // block's stamps - the same aliasing hazard Assignment.matchSource
  // deep-clones to avoid.
  const source = comprehensionSource(
    node,
    unpackStatements(node, paramName),
    paramName,
  );

  return stampLoc(
    call(
      CALL_NAME[node.mode],
      // named argument AFTER the positional source, matching how a user
      // writes fork(xs, shared: true)
      node.shared ? [source, sharedArg()] : [source],
      blockArg(
        [...unpackStatements(node, paramName), returnStmt(node.expression)],
        paramName,
      ),
    ),
    node.loc,
  );
}
