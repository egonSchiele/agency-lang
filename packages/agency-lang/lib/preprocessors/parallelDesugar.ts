import {
  AgencyNode,
  Assignment,
  Expression,
  FunctionCall,
  ParallelBlock,
  AgencyArray,
  AgencyObject,
  IfElse,
  ReturnStatement,
  StringLiteral,
  VariableNameLiteral,
  ValueAccess,
  NumberLiteral,
} from "@/types.js";
import { BinOpExpression } from "@/types/binop.js";
import { BlockArgument } from "@/types/blockArgument.js";
import { isNullLiteral, walkNodes } from "@/utils/node.js";
import { mapBodies } from "@/utils/mapBodies.js";
import { expressionSlots } from "@/utils/expressionSlots.js";

/**
 * Statement allowlist enforcement and cross-arm reference checks for `parallel`
 * blocks, plus desugaring of `parallel`/`seq` blocks into the existing `fork`
 * primitive. See docs/dev/language/parallel-blocks.md for the v1 spec.
 *
 * Outline:
 *   parallel { stmt0; stmt1; seq { ... } }
 * desugars to:
 *   let __arms_<n> = fork(["arm_0", "arm_1", "arm_2"]) as __arm_<n> {
 *     if (__arm_<n> == "arm_0") { <stmt0>; return { ...bindings } }
 *     if (__arm_<n> == "arm_1") { <stmt1>; return { ...bindings } }
 *     if (__arm_<n> == "arm_2") { <seq.body>; return { ...bindings } }
 *   }
 *   let X = __arms_<n>[i].X    // for each hoisted binding
 *
 * `seq { ... }` outside a `parallel` block is inlined: its body replaces the
 * seq node in the enclosing body. Variables declared inside leak to the
 * enclosing scope, matching the spec's "no runtime effect outside parallel".
 */

// Sentinel names. The suffix is appended at desugar time so nested parallel
// blocks don't collide.
const ARMS_VAR_PREFIX = "__arms";
const ARM_PARAM_PREFIX = "__arm";

let parallelCounter = 0;

function nextSuffix(): string {
  return String(parallelCounter++);
}

// Reset the counter — used in tests to make output deterministic.
export function resetParallelCounter(): void {
  parallelCounter = 0;
}

const ALLOWED_ARM_TYPES = new Set([
  "assignment",
  "functionCall",
  "valueAccess",
  "seqBlock",
  "parallelBlock",
  "comment",
  "multiLineComment",
  "newLine",
]);

const COMMENT_TYPES = new Set(["comment", "multiLineComment", "newLine"]);

function isAssignmentDecl(node: AgencyNode): node is Assignment {
  return node.type === "assignment" && (node.declKind === "let" || node.declKind === "const");
}

/**
 * Validate a parallel block: enforce statement allowlist at the top level,
 * then check cross-arm references. Throws on violation.
 */
export function validateParallelBlock(pb: ParallelBlock): void {
  // An `async` block is built by asyncDesugar from allowed shapes, and its
  // side arm reads only snapshot temporaries, so neither check below can
  // fire on one. If one does, the lowering is wrong, and the user should
  // not see a message about a `parallel` block they never wrote.
  if (pb.origin === "async") {
    try {
      validateUserParallelBlock(pb);
    } catch (err) {
      throw new Error(
        `Internal error lowering an \`async\` call: ${(err as Error).message} This is a compiler bug.`,
      );
    }
    return;
  }
  validateUserParallelBlock(pb);
}

function validateUserParallelBlock(pb: ParallelBlock): void {
  // A `destructive { }` region inside an arm is allowed. Its flip is written
  // to `__activation`, which a fork branch reaches lexically, so it marks the
  // calling function the same way a bare destructive call in an arm does
  // (docs/dev/language/destructive-regions.md).

  // 1. Allowlist check.
  for (const child of pb.body) {
    if (!ALLOWED_ARM_TYPES.has(child.type)) {
      throw new Error(
        `Statement type \`${child.type}\` is not allowed at the top level of a \`parallel\` block. Wrap it in \`seq { ... }\` to use it.`,
      );
    }
    if (child.type === "assignment") {
      // Reassignment to outer-scope variables is banned at the top level.
      // Treat any assignment without a declKind as reassignment.
      const a = child as Assignment;
      if (!a.declKind) {
        throw new Error(
          `Reassignment to \`${a.variableName}\` is not allowed at the top level of a \`parallel\` block. Wrap it in \`seq { ... }\` to use it.`,
        );
      }
    }
  }

  // 2. Cross-arm reference check. For each arm, compute the set of names it
  // binds (deep walk: every let/const at any depth within the arm's subtree)
  // and the set of names it references but doesn't bind locally. For each
  // pair (i, j): error if frees(j) ∩ binds(i) is non-empty.
  const arms = pb.body.filter((n) => !COMMENT_TYPES.has(n.type));
  const armBinds: Set<string>[] = arms.map((arm) => collectBindings(arm));
  const armFrees: Set<string>[] = arms.map((arm, i) =>
    setMinus(collectReferences(arm), armBinds[i]),
  );

  for (let i = 0; i < arms.length; i++) {
    for (let j = 0; j < arms.length; j++) {
      if (i === j) continue;
      for (const name of armFrees[j]) {
        if (armBinds[i].has(name)) {
          throw new Error(
            `Parallel arm references \`${name}\`, which is declared by a sibling arm. Wrap both arms in a single \`seq { ... }\` block to make the dependency explicit.`,
          );
        }
      }
    }
  }
}

/**
 * Collect every let/const variable name introduced anywhere in the subtree of
 * the given node. Crosses into seqBlock, parallelBlock, ifElse branches, loop
 * bodies — but NOT into nested function/graphNode definitions (those
 * introduce their own scope). For nested parallel/seq, all bindings declared
 * inside are still considered bindings of the outer arm because they're
 * hoisted out.
 */
export function collectBindings(node: AgencyNode): Set<string> {
  const binds = new Set<string>();
  walkForBindings(node, binds);
  return binds;
}

function walkForBindings(node: AgencyNode, binds: Set<string>): void {
  if (isAssignmentDecl(node)) {
    binds.add(node.variableName);
    return;
  }
  // Don't descend into nested function/graphNode definitions — they have their
  // own scope and their lets don't leak.
  if (node.type === "function" || node.type === "graphNode") return;

  // Descend into child bodies.
  if (node.type === "ifElse") {
    for (const n of node.thenBody) walkForBindings(n, binds);
    if (node.elseBody) for (const n of node.elseBody) walkForBindings(n, binds);
    return;
  }
  if (
    node.type === "forLoop" ||
    node.type === "whileLoop" ||
    node.type === "messageThread" ||
    node.type === "handleBlock"
  ) {
    for (const n of node.body) walkForBindings(n, binds);
    return;
  }
  if (node.type === "seqBlock" || node.type === "parallelBlock") {
    for (const n of node.body) walkForBindings(n, binds);
    return;
  }
  // `let x = f() with approve` declares `x` in the enclosing scope, the
  // same as the plain assignment it wraps.
  if (node.type === "withModifier") {
    walkForBindings(node.statement, binds);
    return;
  }
  if (node.type === "matchBlock") {
    for (const c of node.cases) {
      if (c.type === "comment") continue;
      if (c.type === "newLine") continue;
      for (const n of c.body) walkForBindings(n, binds);
    }
    return;
  }
}

/**
 * Collect every name mentioned anywhere in the subtree: each variable read,
 * each called function's name, and each assignment target. A name counts
 * whether it is read or written, because either one depends on the value a
 * sibling arm would have to produce first.
 *
 * Walks with `walkNodes`, the descent template hygiene and scope resolution
 * already rely on to reach every expression, so a name inside a `with`
 * statement, a `match` arm, a cast, an interrupt's arguments, or a node kind
 * added later is found. A hand-written switch over node types used to live
 * here and missed all of those: a `seq` arm reading a sibling's binding
 * inside `print(x) with approve` compiled and read `undefined`.
 */
export function collectReferences(node: AgencyNode): Set<string> {
  return new Set(namesMentioned([node]));
}

/** The names `collectReferences` finds, for a list of statements, in the
 *  order they are first met. */
export function namesMentioned(nodes: AgencyNode[]): string[] {
  const names: string[] = [];
  const add = (name: unknown) => {
    if (typeof name === "string" && !names.includes(name)) {
      names.push(name);
    }
  };
  for (const { node } of walkNodes(nodes)) {
    if (node.type === "variableName" && !isNullLiteral(node)) {
      add(node.value);
    } else if (node.type === "functionCall") {
      add(node.functionName);
    } else if (node.type === "assignment") {
      add(node.variableName);
    }
  }
  return names;
}

function setMinus(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const x of a) if (!b.has(x)) result.add(x);
  return result;
}

/* ------------------------------------------------------------------ */
/* AST node builders                                                  */
/* ------------------------------------------------------------------ */

function strLit(value: string): StringLiteral {
  return { type: "string", segments: [{ type: "text", value }] };
}

function numLit(value: number): NumberLiteral {
  return { type: "number", value: String(value) };
}

function varRef(name: string): VariableNameLiteral {
  return { type: "variableName", value: name };
}

function eqExpr(left: Expression, right: Expression): BinOpExpression {
  return { type: "binOpExpression", operator: "==", left, right };
}

function letAssign(name: string, value: Expression): Assignment {
  return {
    type: "assignment",
    declKind: "let",
    variableName: name,
    value,
  };
}

function ret(value: Expression): ReturnStatement {
  return { type: "returnStatement", value } as any;
}

function objectLit(keys: string[]): AgencyObject {
  return {
    type: "agencyObject",
    entries: keys.map((k) => ({ key: k, value: varRef(k) })),
  };
}

/** The arm of an `async` block that runs the statements after the call:
 *  arm 0 is the call, arm 1 the rest of the block. */
const ASYNC_MAIN_ARM = 1;

/** A call to a `__`-prefixed runtime helper, which the builder emits as a
 *  plain direct call. */
function directCall(name: string, args: Expression[]): FunctionCall {
  return { type: "functionCall", functionName: name, arguments: args };
}

/** `__asyncDone({ ... })`: the main arm's marked completion object. The
 *  runtime pair `__asyncDone` / `__asyncFinished` owns the marker's shape,
 *  so generated code never spells it. */
function asyncDoneCall(bindings: AgencyObject): FunctionCall {
  return directCall("__asyncDone", [bindings]);
}

function arrayLit(items: Expression[]): AgencyArray {
  return { type: "agencyArray", items };
}

function indexAccess(baseName: string, idx: number, prop: string): ValueAccess {
  return {
    type: "valueAccess",
    base: varRef(baseName),
    chain: [
      { kind: "index", index: numLit(idx) },
      { kind: "property", name: prop },
    ],
  };
}

function ifStmt(cond: Expression, body: AgencyNode[]): IfElse {
  return { type: "ifElse", condition: cond, thenBody: body };
}

function forkCall(
  items: Expression[],
  block: BlockArgument,
  shared: Expression | undefined,
  mainThread: number | undefined,
): FunctionCall {
  const args: FunctionCall["arguments"] = [arrayLit(items)];
  if (shared !== undefined) {
    args.push({
      type: "namedArgument",
      name: "shared",
      value: shared,
    });
  }
  return {
    type: "functionCall",
    functionName: "fork",
    arguments: args,
    block,
    ...(mainThread !== undefined && { mainThread }),
  };
}

/* ------------------------------------------------------------------ */
/* Desugar transform                                                   */
/* ------------------------------------------------------------------ */

/**
 * Recursively desugar `parallel { ... }` and `seq { ... }` blocks within an
 * AgencyNode array. Replaces each top-level `parallelBlock` with the desugared
 * fork+destructuring sequence. Replaces each top-level `seqBlock` with its
 * body inlined (recursively desugared). Recurses into nested control-flow
 * bodies for any other node types so deeply-nested parallel/seq blocks
 * inside if/for/while/etc. also get processed.
 *
 * Note: `seqBlock` nodes that appear directly as arms of a `parallelBlock`
 * are NOT inlined here — they're handled by `desugarOneParallel`, which
 * treats each arm (including a `seqBlock` arm) as a single arm whose body is
 * the seq's body. Inlining at this level would flatten arm boundaries and
 * confuse the cross-arm reference check.
 */
export function desugarParallelInBody(body: AgencyNode[]): AgencyNode[] {
  const result: AgencyNode[] = [];
  for (const node of body) {
    if (node.type === "parallelBlock") {
      // desugarOneParallel handles arm-aware recursion into its children.
      result.push(...desugarOneParallel(node));
    } else if (node.type === "seqBlock") {
      // Outside a parallel context, a seq block has no runtime effect; inline
      // its body after recursively desugaring. A `destructive` seqBlock also
      // commits: prepend the flip, which codegen writes to the enclosing
      // function's activation (docs/dev/language/destructive-regions.md).
      if (node.destructive) {
        result.push({ type: "markDestructiveRan" } as AgencyNode);
      }
      result.push(...desugarParallelInBody(node.body));
    } else {
      // Recurse into nested bodies, then keep the node.
      result.push(descendIntoSubstructures(node));
    }
  }
  return result;
}

/** Desugar every parallel and seq block nested anywhere inside `node`: in
 *  its statement bodies (`bodySlots`, through `mapBodies`) and inside its
 *  expressions (`expressionSlots`), which is where a block argument passed
 *  as a call's argument or a `fork` on an assignment's right-hand side
 *  keeps its body. Driven by the two slot tables so a new body-bearing
 *  node is covered without a case here. */
function descendIntoSubstructures(node: AgencyNode): AgencyNode {
  let out = mapBodies(node, desugarParallelInBody);
  for (const slot of expressionSlots(out)) {
    out = slot.write(out, descendIntoSubstructures(slot.expr));
  }
  return out;
}

function desugarOneParallel(pb: ParallelBlock): AgencyNode[] {
  validateParallelBlock(pb);

  const arms = pb.body.filter((n) => !COMMENT_TYPES.has(n.type));
  const suffix = nextSuffix();
  const armsVar = `${ARMS_VAR_PREFIX}_${suffix}`;
  const armParam = `${ARM_PARAM_PREFIX}_${suffix}`;

  // Build the if-chain body for the fork.
  const ifChainBody: AgencyNode[] = [];
  const armBindingsList: string[][] = [];

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const armName = `arm_${i}`;
    const bindings = Array.from(collectBindings(arm));
    armBindingsList.push(bindings);

    // The arm's stmts: for seqBlock, use its body (the seq is the arm wrapper,
    // not a separate stmt). Recursively desugar so any nested parallel/seq
    // inside the arm gets rewritten before we splice it into the if-chain.
    let armStmts: AgencyNode[];
    if (arm.type === "seqBlock") {
      armStmts = desugarParallelInBody([...arm.body]);
      // A `destructive { }` region written directly as an arm: the seq
      // wrapper is dropped here, so its flip has to be kept by hand. A region
      // nested deeper in the arm is handled by desugarParallelInBody.
      if (arm.destructive) {
        armStmts.unshift({ type: "markDestructiveRan" } as AgencyNode);
      }
    } else {
      armStmts = desugarParallelInBody([arm]);
    }

    // Append `return { binding1: binding1, binding2: binding2, ... }`. The
    // main arm of an `async` block marks its object as a normal completion,
    // so the join can tell it from a value the arm returned early.
    const completion = objectLit(bindings);
    armStmts.push(
      ret(pb.origin === "async" && i === ASYNC_MAIN_ARM ? asyncDoneCall(completion) : completion),
    );

    ifChainBody.push(ifStmt(eqExpr(varRef(armParam), strLit(armName)), armStmts));
  }

  // Build the fork call. `pb.shared` (from `parallel(shared: true)
  // { ... }`) is forwarded onto the synthesized `fork` as a named arg
  // so per-branch isolation can be opted out of at the call site.
  const armNames = arms.map((_, i) => strLit(`arm_${i}`));
  const fork = forkCall(
    armNames,
    {
      type: "blockArgument",
      inline: false,
      params: [{ type: "functionParameter", name: armParam }],
      body: ifChainBody,
    },
    pb.shared,
    pb.origin === "async" ? ASYNC_MAIN_ARM : undefined,
  );

  const out: AgencyNode[] = [letAssign(armsVar, fork)];

  // The join check of an `async` block, between the fork and the hoists:
  //   if (!__asyncFinished(__arms_n[1])) { return __arms_n[1] }
  // A main arm that ran to its end returned the marked object. Anything
  // else is a value the arm returned early: a user `return` at any depth,
  // the `return` the hoist pass later writes for a `?`, a bare `return`,
  // or the failure of an interrupt rejected in the arm. That value is the
  // enclosing function's (or node's) return value, so return it. It must
  // come before the hoists, which read properties off the marked object.
  // Only this function knows `__arms_n`, so the check is written here and
  // not by the async lowering. See docs/dev/runtime/async.md.
  if (pb.origin === "async") {
    const mainArm: ValueAccess = {
      type: "valueAccess",
      base: varRef(armsVar),
      chain: [{ kind: "index", index: numLit(ASYNC_MAIN_ARM) }],
    };
    out.push(
      ifStmt(
        {
          type: "binOpExpression",
          operator: "!",
          left: { type: "boolean", value: true },
          right: directCall("__asyncFinished", [mainArm]),
        } as BinOpExpression,
        [ret(mainArm)],
      ),
    );
  }

  // Hoist bindings out: `let X = __arms_<n>[i].X` for each arm's bindings.
  for (let i = 0; i < arms.length; i++) {
    for (const name of armBindingsList[i]) {
      out.push(letAssign(name, indexAccess(armsVar, i, name)));
    }
  }

  return out;
}
