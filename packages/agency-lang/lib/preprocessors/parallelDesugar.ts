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

/**
 * Statement allowlist enforcement and cross-arm reference checks for `parallel`
 * blocks, plus desugaring of `parallel`/`seq` blocks into the existing `fork`
 * primitive. See docs/dev/parallel-blocks.md for the v1 spec.
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
  return (
    node.type === "assignment" &&
    (node.declKind === "let" || node.declKind === "const")
  );
}

/**
 * Validate a parallel block: enforce statement allowlist at the top level,
 * then check cross-arm references. Throws on violation.
 */
export function validateParallelBlock(pb: ParallelBlock): void {
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
  if (node.type === "matchBlock") {
    for (const c of node.cases) {
      if (c.type === "comment") continue;
      walkForBindings(c.body as any, binds);
    }
    return;
  }
}

/**
 * Collect every variable name referenced (read) anywhere in the subtree.
 * "Referenced" means a `variableName` literal — i.e., a use of the name as a
 * value. Excludes the LHS of declarations (those are bindings, not refs).
 */
export function collectReferences(node: AgencyNode): Set<string> {
  const refs = new Set<string>();
  walkForReferences(node, refs);
  return refs;
}

function walkForReferences(node: AgencyNode, refs: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case "variableName":
      refs.add(node.value);
      return;
    case "assignment": {
      // The LHS variableName is a binding, NOT a reference. The RHS value
      // is the only source of references here. (Compound forms like x.y = z
      // would also produce a reference to x via accessChain, but the v1
      // allowlist bans plain reassignment in parallel arms.)
      walkForReferences(node.value as AgencyNode, refs);
      return;
    }
    case "functionCall": {
      // Function names ARE references — they could collide with bindings
      // declared by sibling arms (e.g., `let foo = ...; let r = foo()`).
      refs.add(node.functionName);
      for (const arg of node.arguments) {
        if (arg.type === "splat") {
          walkForReferences(arg.value as AgencyNode, refs);
        } else if (arg.type === "namedArgument") {
          walkForReferences(arg.value as AgencyNode, refs);
        } else {
          walkForReferences(arg as AgencyNode, refs);
        }
      }
      if (node.block) {
        for (const n of node.block.body) walkForReferences(n, refs);
      }
      return;
    }
    case "binOpExpression":
      walkForReferences(node.left as AgencyNode, refs);
      walkForReferences(node.right as AgencyNode, refs);
      return;
    case "valueAccess":
      walkForReferences(node.base, refs);
      for (const el of node.chain) {
        if (el.kind === "index") walkForReferences(el.index as AgencyNode, refs);
        else if (el.kind === "slice") {
          if (el.start) walkForReferences(el.start as AgencyNode, refs);
          if (el.end) walkForReferences(el.end as AgencyNode, refs);
        } else if (el.kind === "methodCall") {
          for (const arg of el.functionCall.arguments) {
            if (arg.type === "splat" || arg.type === "namedArgument") {
              walkForReferences(arg.value as AgencyNode, refs);
            } else {
              walkForReferences(arg as AgencyNode, refs);
            }
          }
        } else if (el.kind === "call") {
          for (const arg of el.arguments) {
            if (arg.type === "splat" || arg.type === "namedArgument") {
              walkForReferences(arg.value as AgencyNode, refs);
            } else {
              walkForReferences(arg as AgencyNode, refs);
            }
          }
        }
      }
      return;
    case "agencyArray":
      for (const item of node.items) {
        if (item.type === "splat") walkForReferences(item.value as AgencyNode, refs);
        else walkForReferences(item as AgencyNode, refs);
      }
      return;
    case "agencyObject":
      for (const e of node.entries) {
        if ("type" in e && e.type === "splat") {
          walkForReferences(e.value as AgencyNode, refs);
        } else {
          walkForReferences((e as any).value as AgencyNode, refs);
        }
      }
      return;
    case "string":
    case "multiLineString":
      for (const seg of node.segments) {
        if (seg.type === "interpolation") {
          walkForReferences(seg.expression as AgencyNode, refs);
        }
      }
      return;
    case "ifElse": {
      walkForReferences(node.condition as AgencyNode, refs);
      // References inside thenBody/elseBody might bind their own locals —
      // shadowing is handled at outer-arm level since we collect refs and
      // binds independently and subtract. Simpler: just collect all refs,
      // subtract all binds. Same outcome.
      for (const n of node.thenBody) walkForReferences(n, refs);
      if (node.elseBody) for (const n of node.elseBody) walkForReferences(n, refs);
      return;
    }
    case "forLoop": {
      walkForReferences(node.iterable as AgencyNode, refs);
      for (const n of node.body) walkForReferences(n, refs);
      return;
    }
    case "whileLoop": {
      walkForReferences(node.condition as AgencyNode, refs);
      for (const n of node.body) walkForReferences(n, refs);
      return;
    }
    case "returnStatement":
      if (node.value) walkForReferences(node.value as AgencyNode, refs);
      return;
    case "seqBlock":
    case "parallelBlock":
      for (const n of node.body) walkForReferences(n, refs);
      return;
    case "messageThread":
      for (const n of node.body) walkForReferences(n, refs);
      return;
    case "handleBlock":
      for (const n of node.body) walkForReferences(n, refs);
      if (node.handler.kind === "inline") {
        for (const n of node.handler.body) walkForReferences(n, refs);
      }
      return;
    default:
      return;
  }
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

function forkCall(items: Expression[], block: BlockArgument): FunctionCall {
  return {
    type: "functionCall",
    functionName: "fork",
    arguments: [arrayLit(items)],
    block,
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
      // its body after recursively desugaring.
      result.push(...desugarParallelInBody(node.body));
    } else {
      // Recurse into nested control-flow bodies, then keep the node.
      descendIntoSubstructures(node);
      result.push(node);
    }
  }
  return result;
}

function descendIntoSubstructures(node: AgencyNode): void {
  switch (node.type) {
    case "ifElse":
      node.thenBody = desugarParallelInBody(node.thenBody);
      if (node.elseBody) node.elseBody = desugarParallelInBody(node.elseBody);
      return;
    case "forLoop":
    case "whileLoop":
    case "messageThread":
      node.body = desugarParallelInBody(node.body);
      return;
    case "handleBlock":
      node.body = desugarParallelInBody(node.body);
      if (node.handler.kind === "inline") {
        node.handler.body = desugarParallelInBody(node.handler.body);
      }
      return;
    case "matchBlock":
      for (const c of node.cases) {
        if (c.type === "comment") continue;
        c.body = desugarParallelInBody([c.body as any])[0] as any;
      }
      return;
    case "withModifier":
      node.statement = desugarParallelInBody([node.statement as any])[0];
      return;
    case "assignment":
      // The RHS may be a function call that has a block (e.g. fork) whose
      // body might contain a parallel block.
      descendIntoSubstructures(node.value as AgencyNode);
      return;
    case "returnStatement":
      if (node.value) descendIntoSubstructures(node.value as AgencyNode);
      return;
    case "functionCall":
      if (node.block) {
        node.block.body = desugarParallelInBody(node.block.body);
      }
      return;
    case "classDefinition":
      for (const m of node.methods) m.body = desugarParallelInBody(m.body);
      return;
    default:
      return;
  }
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
    } else {
      armStmts = desugarParallelInBody([arm]);
    }

    // Append `return { binding1: binding1, binding2: binding2, ... }`.
    armStmts.push(ret(objectLit(bindings)));

    ifChainBody.push(
      ifStmt(eqExpr(varRef(armParam), strLit(armName)), armStmts),
    );
  }

  // Build the fork call.
  const armNames = arms.map((_, i) => strLit(`arm_${i}`));
  const fork = forkCall(armNames, {
    type: "blockArgument",
    inline: false,
    params: [{ type: "functionParameter", name: armParam }],
    body: ifChainBody,
  });

  const out: AgencyNode[] = [letAssign(armsVar, fork)];

  // Hoist bindings out: `let X = __arms_<n>[i].X` for each arm's bindings.
  for (let i = 0; i < arms.length; i++) {
    for (const name of armBindingsList[i]) {
      out.push(letAssign(name, indexAccess(armsVar, i, name)));
    }
  }

  return out;
}
