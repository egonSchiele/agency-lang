/**
 * Pattern lowering pass.
 *
 * Walks the AST and transforms all destructuring/pattern-matching syntax into
 * existing Agency constructs (Assignments, IfElse, BinOpExpressions, ValueAccess,
 * FunctionCalls). After this pass, the AST contains NO pattern-specific nodes,
 * so the rest of the pipeline (typechecker, TypeScriptBuilder, preprocessor, LSP)
 * needs zero changes.
 *
 * Runs after parsing, before SymbolTable.build / typechecking.
 */

import type {
  AgencyNode,
  Assignment,
  Expression,
  ForLoop,
  FunctionCall,
  FinalizeBlock,
  GuardBlock,
  FunctionDefinition,
  HandleBlock,
  IfElse,
  MatchBlock,
  MatchBlockCase,
  ReturnStatement,
  VariableType,
  WhileLoop,
} from "../types.js";
import { isExpressionNode } from "../types.js";
import type { MatchYield } from "../types/matchYield.js";
import { LoweringError } from "./loweringError.js";
import { matchValName } from "../matchVal.js";
import type { BinOpExpression, Operator } from "../types/binop.js";
import type { AgencyArray } from "../types/dataStructures.js";
import type {
  BindingPattern,
  IsExpression,
  MatchPattern,
  ObjectPatternProperty,
  ObjectPatternShorthand,
  ResultPattern,
} from "../types/pattern.js";
import type {
  Literal,
  NumberLiteral,
  StringLiteral,
  VariableNameLiteral,
} from "../types/literals.js";
import type { ValueAccess, AccessChainElement } from "../types/access.js";
import type { SourceLocation } from "../types/base.js";
import { mapBodies } from "../utils/mapBodies.js";
import { OBJECT_REST_FN } from "../constants.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function lowerPatterns(nodes: AgencyNode[]): AgencyNode[] {
  return new PatternLowerer().lower(nodes);
}

class PatternLowerer {
  private counter = 0;

  /** True while lowering the top-level (module) node list; flipped to false by
   *  `lowerBody` when descending into any body-bearing container (function /
   *  node / if / loop / match arm / block / handler). Used to reject `match`
   *  expressions in module-level initializers, which have no execution frame
   *  to unwind. */
  private atModuleLevel = true;

  private freshName(prefix: string): string {
    return `__${prefix}_${++this.counter}`;
  }

  lower(nodes: AgencyNode[]): AgencyNode[] {
    return nodes.flatMap((n) => this.lowerNode(n));
  }

  /** Lower a nested body (any body-bearing container): temporarily clears the
   *  `atModuleLevel` flag so `match` expressions inside are allowed. Match
   *  expressions inside a handler body are fine — the builder compiles them to
   *  a self-contained async IIFE in the handler's plain-mode codegen, so they
   *  never touch the runner's `_matchExit` unwind flag. */
  private lowerBody(nodes: AgencyNode[]): AgencyNode[] {
    const prev = this.atModuleLevel;
    this.atModuleLevel = false;
    try {
      return this.lower(nodes);
    } finally {
      this.atModuleLevel = prev;
    }
  }

  private lowerNode(node: AgencyNode): AgencyNode[] {
    switch (node.type) {
      case "assignment":
        return this.lowerAssignment(node);
      case "ifElse":
        return [this.lowerIfElse(node)];
      case "whileLoop":
        return [this.lowerWhileLoop(node)];
      case "matchBlock":
        return this.lowerMatchBlock(node);
      case "forLoop":
        return [this.lowerForLoop(node)];
      case "finalizeBlock": {
        // Same-scope statements: expression-position match/if inside the
        // finalize lowers exactly like anywhere else in the scope.
        const fb = node as FinalizeBlock;
        return [{ ...fb, body: this.lowerBody(fb.body) }];
      }
      case "guardBlock": {
        // Statement-position guard construct: lower its body like any
        // block. Value-position guards (assignment / return values) are
        // handled at their owner cases — a value is not a body slot, so
        // the default mapBodies recursion cannot reach them.
        const gb = node as GuardBlock;
        return [{ ...gb, body: this.lowerBody(gb.body) }];
      }
      case "handleBlock": {
        // Descend both the guarded body and the inline handler body. Non-inline
        // handlers have no body to descend.
        const hb = node as HandleBlock;
        const body = this.lowerBody(hb.body);
        const handler =
          hb.handler.kind === "inline"
            ? { ...hb.handler, body: this.lowerBody(hb.handler.body) }
            : hb.handler;
        return [{ ...hb, body, handler }];
      }
      case "returnStatement": {
        const ret = node as ReturnStatement;
        // A guard construct as the return value: lower its BODY (the
        // value itself is not an expression the region machinery
        // knows). Without this, a `return match(...)` inside the
        // guarded block never lowers and reaches codegen raw.
        if ((ret.value as AgencyNode | undefined)?.type === "guardBlock") {
          const gb = ret.value as unknown as GuardBlock;
          return [
            {
              ...(ret as object),
              value: { ...gb, body: this.lowerBody(gb.body) },
            } as unknown as AgencyNode,
          ];
        }
        // Expression-position `match`/`if`: `return match(E) { ... }` or
        // `return if c then a else b`. Hoist the region and return the temp it
        // produces. Allowed inside handler bodies too: the builder compiles the
        // hoisted region to a self-contained async IIFE there (plain mode), so
        // it never sets the runner's `_matchExit` unwind flag that a handler has
        // no `runner.ifElse` to clear.
        const retRegion = this.expressionRegion(ret.value as AgencyNode | undefined, ret.loc);
        if (retRegion) {
          return [...retRegion.statements, { ...ret, value: retRegion.valueRef }];
        }
        return [
          {
            ...(ret as object),
            value: ret.value !== undefined ? this.lowerExpression(ret.value) : undefined,
          } as AgencyNode,
        ];
      }
      case "matchYield": {
        // Produced by our own arm-rewriting; re-lowered when the enclosing match
        // block's arm bodies are recursively lowered. Lower the yielded value.
        const my = node as MatchYield;
        return [
          {
            ...my,
            value: my.value !== undefined ? this.lowerExpression(my.value) : undefined,
          },
        ];
      }
      default: {
        // Recurse into every body field on body-bearing nodes (function /
        // graphNode / parallelBlock / seqBlock / blockArgument /
        // functionCall.block / …; `handleBlock` is handled explicitly above).
        // For nodes that are also Expressions, additionally walk the expression
        // tree so nested `isExpression` is lowered.
        const withRecursedBodies = mapBodies(node, (b) => this.lowerBody(b));
        if (isExpr(withRecursedBodies as unknown)) {
          return [this.lowerExpression(withRecursedBodies as unknown as Expression) as unknown as AgencyNode];
        }
        return [withRecursedBodies];
      }
    }
  }

  /**
   * Recursively lower an expression: any `isExpression` found in a pure-boolean
   * context (anywhere except as the direct condition of `if`/`while` or the
   * direct expression of `match`) is converted to its boolean condition form.
   * Binders inside such an `isExpression` are a compile-time error.
   */
  private lowerExpression(expr: Expression): Expression {
    if (expr.type === "isExpression") {
      assertNoBindersInBoolIs(expr.pattern);
      const inner = this.lowerExpression(expr.expression);
      return patternToCondition(expr.pattern, inner) ?? boolLit(true, expr.loc);
    }
    if (expr.type === "binOpExpression") {
      return {
        ...expr,
        left: this.lowerExpression(expr.left),
        right: this.lowerExpression(expr.right),
      };
    }
    if (expr.type === "functionCall") {
      const block = expr.block
        ? { ...expr.block, body: this.lowerBody(expr.block.body) }
        : expr.block;
      return {
        ...expr,
        arguments: expr.arguments.map((a) => {
          if ("type" in a && (a.type === "splat" || a.type === "namedArgument")) {
            return { ...a, value: this.lowerExpression(a.value) };
          }
          return this.lowerExpression(a as Expression);
        }),
        block,
      };
    }
    if (expr.type === "valueAccess") {
      return {
        ...expr,
        chain: expr.chain.map((c) => {
          if (c.kind === "index") return { ...c, index: this.lowerExpression(c.index) };
          if (c.kind === "slice") {
            return {
              ...c,
              start: c.start ? this.lowerExpression(c.start) : c.start,
              end: c.end ? this.lowerExpression(c.end) : c.end,
            };
          }
          return c;
        }),
      };
    }
    if (expr.type === "agencyArray") {
      return {
        ...expr,
        items: expr.items.map((it) =>
          "type" in it && it.type === "splat"
            ? { ...it, value: this.lowerExpression(it.value) }
            : this.lowerExpression(it as Expression),
        ),
      };
    }
    if (expr.type === "agencyObject") {
      return {
        ...expr,
        entries: expr.entries.map((e) => ({
          ...e,
          value: this.lowerExpression(e.value),
        })),
      };
    }
    return expr;
  }

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  private lowerAssignment(node: Assignment): AgencyNode[] {
    // A guard construct as the assignment value: lower its BODY (see
    // the returnStatement case — values are not body slots, so the
    // default recursion cannot reach them).
    if ((node.value as AgencyNode | undefined)?.type === "guardBlock") {
      const gb = node.value as unknown as GuardBlock;
      return [
        {
          ...(node as object),
          value: { ...gb, body: this.lowerBody(gb.body) },
        } as unknown as AgencyNode,
      ];
    }
    // Expression-position `match`/`if`: `const x = match(E) { ... }` or
    // `const x = if c then a else b`. Hoist the region above and rewrite the
    // value to the temp the region produces. Handler bodies ARE allowed: the
    // builder compiles the hoisted region to a self-contained async IIFE there
    // (plain mode), which never sets the runner's `_matchExit` flag.
    const region = this.expressionRegion(node.value as AgencyNode | undefined, node.loc);
    if (region) {
      if (this.atModuleLevel) {
        // A module-level initializer has no execution frame for the match's
        // `_matchExit` unwind, so we can't splice the region inline the way we
        // do inside a function. Instead hoist the region into a synthesized
        // init function and rewrite the initializer to call it. The result is
        // exactly the manual `def`-wrapper workaround:
        //
        //   const x = match(E) { ... }
        //     =>  def matchInit$N() { <region>; return __matchval_N }
        //         const x = matchInit$N()
        //
        // `const x = matchInit$N()` is then an ordinary single-expression
        // initializer that the init-topsort machinery already handles: its
        // depth-1 call expansion walks the synthesized function's body, so `x`
        // still depends on whatever the scrutinee and arms read. The `$` cannot
        // appear in a user identifier (Agency names are [A-Za-z0-9_]), so the
        // name never collides; and NOT starting with `__` routes the call
        // through the runtime dispatch that makes an AgencyFunction callable.
        const fnName = `matchInit$${++this.counter}`;
        const synthFn: FunctionDefinition = {
          type: "function",
          functionName: fnName,
          parameters: [],
          returnType: null,
          body: [
            ...region.statements,
            { type: "returnStatement", value: region.valueRef, loc: node.loc },
          ],
          loc: node.loc,
        };
        const call: FunctionCall = {
          type: "functionCall",
          functionName: fnName,
          arguments: [],
          loc: node.loc,
        };
        return [
          synthFn,
          { ...node, value: call, matchExprSource: { matchId: region.matchId } },
        ];
      }
      return [
        ...region.statements,
        { ...node, value: region.valueRef, matchExprSource: { matchId: region.matchId } },
      ];
    }

    // node.value can be Expression | MessageThread; only walk Expression cases.
    const loweredValue = isExpr(node.value)
      ? this.lowerExpression(node.value as Expression)
      : node.value;

    if (!node.pattern) {
      // Pure-boolean context: walk the value and replace any nested
      // `isExpression` with its boolean condition. Binders are a compile error.
      return [{ ...node, value: loweredValue }];
    }

    const loc = node.loc;
    const userDeclKind: "let" | "const" = node.declKind ?? "const";
    const tempName = this.freshName("tmp");

    // Temp is ALWAYS const — it's never reassigned.
    const tempAssign: Assignment = {
      type: "assignment",
      variableName: tempName,
      declKind: "const",
      value: loweredValue,
      loc,
    };

    const tempRef = varRef(tempName, loc);
    const bindings = this.extractBindings(node.pattern, tempRef, userDeclKind, loc);
    return [tempAssign, ...bindings];
  }

  // -------------------------------------------------------------------------
  // If / While
  // -------------------------------------------------------------------------

  private lowerIfElse(node: IfElse): IfElse {
    if (node.condition.type === "isExpression") {
      const isExp = node.condition;
      const condition = patternToCondition(isExp.pattern, isExp.expression) ?? boolLit(true, node.loc);
      const bindings = this.extractBindings(isExp.pattern, isExp.expression, "const", node.loc);
      return {
        ...node,
        condition,
        thenBody: [...bindings, ...this.lowerBody(node.thenBody)],
        elseBody: node.elseBody ? this.lowerBody(node.elseBody) : undefined,
      };
    }
    return {
      ...node,
      condition: this.lowerExpression(node.condition),
      thenBody: this.lowerBody(node.thenBody),
      elseBody: node.elseBody ? this.lowerBody(node.elseBody) : undefined,
    };
  }

  private lowerWhileLoop(node: WhileLoop): WhileLoop {
    if (node.condition.type === "isExpression") {
      const isExp = node.condition;
      const condition = patternToCondition(isExp.pattern, isExp.expression) ?? boolLit(true, node.loc);
      const bindings = this.extractBindings(isExp.pattern, isExp.expression, "const", node.loc);
      return {
        ...node,
        condition,
        body: [...bindings, ...this.lowerBody(node.body)],
      };
    }
    return {
      ...node,
      condition: this.lowerExpression(node.condition),
      body: this.lowerBody(node.body),
    };
  }

  // -------------------------------------------------------------------------
  // Match block
  // -------------------------------------------------------------------------

  private lowerMatchBlock(node: MatchBlock, matchExprId?: number): AgencyNode[] {
    if (node.expression.type === "isExpression") {
      return this.lowerMatchIsForm(node, matchExprId);
    }

    // Statement position (matchExprId === undefined): a `return` inside an arm
    // would silently return from the enclosing function while the match's value
    // goes unused. Reject it and point at `return match(...)`. Expression matches
    // never reach here with a raw return — Task 6 rewrote theirs to `matchYield`
    // before calling us; any surviving `returnStatement` belongs to an inner
    // statement match, checked on its own recursion.
    if (matchExprId === undefined) {
      this.assertNoStatementArmReturns(node);
    }

    // Lower every arm's expression slots ONCE, before any of the three paths
    // below reads them. `node.cases` stays un-lowered for the `matchSource`
    // snapshot, which the exhaustiveness pass reads and which wants the arms
    // as written.
    const cases = this.lowerArmExpressionsIn(node.cases);

    // Check if any arm uses patterns or has a guard.
    const hasPatternArms = node.cases.some(
      (c) =>
        c.type === "matchBlockCase" &&
        ((c.caseValue !== "_" &&
          (c.caseValue.type === "objectPattern" ||
            c.caseValue.type === "arrayPattern" ||
            c.caseValue.type === "resultPattern" ||
            c.caseValue.type === "typePattern")) ||
          c.guard !== undefined),
    );

    if (!hasPatternArms) {
      // Pure literal/identifier match — pass through, but still recurse into arm
      // bodies. Tag with matchExprId (at construction) when used as an expression.
      return [
        {
          ...node,
          cases: cases.map((c) => (c.type === "matchBlockCase" ? this.lowerMatchCase(c) : c)),
          ...(matchExprId !== undefined ? { matchExprId } : {}),
        },
      ];
    }

    // Bind scrutinee to a temp (evaluate exactly once even if expression has side effects).
    const scrutineeName = this.freshName("scrutinee");
    const scrutineeAssign: Assignment = {
      type: "assignment",
      variableName: scrutineeName,
      declKind: "const",
      // Lower the scrutinee like any other assignment value, so a nested
      // `is` in a compound head (e.g. `match ((x is A) && y) { … }`) is
      // rewritten to its boolean condition instead of surviving raw into
      // codegen, which has no isExpression handler.
      value: this.lowerExpression(node.expression),
      loc: node.loc,
      // Carry a slim, deep-cloned, body-free snapshot of the arms for a later
      // exhaustiveness pass. Cloned so we neither retain the un-lowered case
      // bodies nor alias live AST that scope resolution mutates in place. See
      // Assignment.matchSource.
      matchSource: structuredClone(
        node.cases
          .filter((c): c is MatchBlockCase => c.type === "matchBlockCase")
          .map((c) => ({ caseValue: c.caseValue, guard: c.guard })),
      ),
      // When used as an expression, tag the scrutinee binding so the type
      // checker can find the owning match for exhaustiveness / union typing.
      ...(matchExprId !== undefined ? { matchExprId } : {}),
    };
    const scrutineeRef = this.narrowableScrutineeRef(node.expression, scrutineeName, node.loc);

    const ifChain = this.buildIfChainFromArms(cases, scrutineeRef, node.loc);
    if (!ifChain) return [scrutineeAssign];
    // Tag the root of the lowered if-chain: it is the node that OWNS the
    // matchExprId (yields unwind to it). Attached at construction.
    const taggedChain: IfElse =
      matchExprId !== undefined ? { ...ifChain, matchExprId } : ifChain;
    return [scrutineeAssign, taggedChain];
  }

  /** The reference the per-arm conditions and binder reads test against: the
   *  ORIGINAL variable for a bare-variable scrutinee, so narrowing lands on
   *  the name the arm bodies reference; otherwise the `__scrutinee` temp.
   *  An arm body that rebinds the name cannot corrupt the substituted reads:
   *  they all run before any user statement (conditions precede the body,
   *  binder assignments are prepended to it — see `foldArms`) and the runner
   *  memoizes the chosen branch, so nothing re-reads the slot after user code
   *  writes it. The `null` guard: `null` parses as a variableName (value
   *  "null" — the quirk narrowing.ts:230 guards) and is not a reference. */
  private narrowableScrutineeRef(
    scrutinee: MatchBlock["expression"],
    scrutineeName: string,
    loc: SourceLocation | undefined,
  ): Expression {
    if (scrutinee.type !== "variableName" || scrutinee.value === "null") {
      return varRef(scrutineeName, loc);
    }
    return varRef(scrutinee.value, scrutinee.loc);
  }

  /**
   * Lower an expression-position `match`: allocate a match id, rewrite each
   * arm's returns into `matchYield` nodes (enforcing the all-paths-yield rule),
   * lower the resulting match block tagged with the id, and hand back the
   * hoisted statements plus a reference to the `__matchval_<id>` temp the
   * region unwinds into.
   */
  private lowerMatchExpressionCore(
    match: MatchBlock,
    loc: SourceLocation | undefined,
  ): { statements: AgencyNode[]; valueRef: Expression; matchId: number } {
    if (match.expression.type === "isExpression") {
      throw new LoweringError(
        "match(x is pattern) cannot be used as an expression; use it as a statement",
        match.loc,
      );
    }
    const matchId = ++this.counter;
    const cases = match.cases.map((c) =>
      c.type === "matchBlockCase"
        ? { ...c, body: this.rewriteArmForYield(c.body, matchId, c) }
        : c,
    );
    const statements = this.lowerMatchBlock({ ...match, cases }, matchId);
    return { statements, valueRef: varRef(matchValName(matchId), loc), matchId };
  }

  /**
   * If `value` is an expression-position control-flow construct (`match(...)` or
   * `if ... then ... else`), lower it to its hoisted region + value-ref temp;
   * otherwise null. Shared by the assignment and return lowering paths so both
   * forms ride the same hoist / module-level machinery.
   */
  private expressionRegion(
    value: AgencyNode | undefined,
    loc: SourceLocation | undefined,
  ): { statements: AgencyNode[]; valueRef: Expression; matchId: number } | null {
    if (!value) return null;
    if (value.type === "matchBlock") return this.lowerMatchExpressionCore(value as MatchBlock, loc);
    if (value.type === "ifElse") return this.lowerIfExpressionCore(value as IfElse, loc);
    return null;
  }

  /**
   * Lower an expression-position `if`: `const x = if c then a else b`. It rides
   * the EXACT machinery a `match` expression uses — an `IfElse` tagged with
   * `matchExprId` whose branches yield via `matchYield` into the `__matchval_N`
   * temp, consumed through a `matchExprSource` binding. Because it is the same
   * stepped `runner.ifElse` a statement `if` compiles to (NOT a ternary),
   * interrupts / checkpoints inside a branch work. The branches are single
   * expressions (the parser rejects nested `if`/`else if`), so each becomes one
   * `matchYield`. An `is`-pattern condition binds into the then-branch, exactly
   * like a statement `if`.
   */
  private lowerIfExpressionCore(
    node: IfElse,
    loc: SourceLocation | undefined,
  ): { statements: AgencyNode[]; valueRef: Expression; matchId: number } {
    const matchId = ++this.counter;
    // Lower each branch as a STATEMENT-position temp binding, then yield the
    // temp. A branch that is a function call (`if c then confirm() else x`) is
    // then compiled at statement position, where codegen emits the
    // interrupt/checkpoint propagation — so the branch pauses correctly. A bare
    // `matchYield(await __call(f))` (the call as an argument to `exitMatch`)
    // swallows the interrupt, so we never generate that shape.
    const yieldBranch = (expr: Expression): AgencyNode[] => {
      const tmp = this.freshName("ifbranch");
      const binding: Assignment = {
        type: "assignment",
        variableName: tmp,
        declKind: "const",
        value: this.lowerExpression(expr),
        loc: expr.loc,
      };
      const yielded: MatchYield = { type: "matchYield", matchId, value: varRef(tmp, expr.loc), loc: expr.loc };
      return [binding, yielded];
    };
    const elseBody = yieldBranch((node.elseBody as AgencyNode[])[0] as Expression);

    const condIsExpr = node.condition.type === "isExpression";
    const isExp = node.condition as IsExpression;
    const condition = condIsExpr
      ? patternToCondition(isExp.pattern, isExp.expression) ?? boolLit(true, node.loc)
      : this.lowerExpression(node.condition);
    const thenBranch = yieldBranch(node.thenBody[0] as Expression);
    const thenBody = condIsExpr
      ? [...this.extractBindings(isExp.pattern, isExp.expression, "const", node.loc), ...thenBranch]
      : thenBranch;

    const tagged: IfElse = { ...node, condition, thenBody, elseBody, matchExprId: matchId };
    return { statements: [tagged], valueRef: varRef(matchValName(matchId), loc), matchId };
  }

  /**
   * Rewrite a single match arm's body so every path yields a value into the
   * owning match (`matchYield`). Throws a `LoweringError` if any path can fall
   * off the end without yielding.
   */
  private rewriteArmForYield(
    body: AgencyNode[],
    matchId: number,
    arm: MatchBlockCase,
  ): AgencyNode[] {
    if (body.length === 1 && isExpressionNode(body[0])) {
      const expr = body[0] as Expression;
      // Always bind a single-expression arm's value to a temp at STATEMENT
      // position, then yield the temp (#430). A bare `matchYield(<expr>)`
      // compiles to `exitMatch(id, <expr>)`; if the expression is a call that
      // returns a bubbling interrupt, that interrupt is handed straight to
      // `exitMatch` with no propagation check and is silently swallowed. At
      // statement position the value flows through `_processAssignmentInner`,
      // which emits the `hasInterrupts` halt guard. We hoist unconditionally
      // rather than trying to detect which values "may interrupt": that
      // detection is brittle (easy to miss a case) and a missed case silently
      // reintroduces the swallow. The temp is tagged `matchArmValueTemp` so
      // codegen re-applies the graph-node-transition guard (the node call is
      // now hidden from `processMatchYield`, which reads the yielded value).
      const tmp = this.freshName("armval");
      const binding: Assignment = {
        type: "assignment",
        variableName: tmp,
        declKind: "const",
        value: expr,
        loc: expr.loc,
        matchArmValueTemp: true,
      };
      const yielded: MatchYield = {
        type: "matchYield",
        matchId,
        value: varRef(tmp, expr.loc),
        // The type checker types the arm from the original expression, not the
        // temp ref, so literal types and discriminant narrowing survive (#430).
        typeSource: expr,
        loc: expr.loc,
      };
      return [binding, yielded];
    }
    const rewritten = this.rewriteReturnsToYields(body, matchId);
    if (!this.alwaysYields(rewritten)) {
      const loc =
        body[0]?.loc ??
        (arm.caseValue === "_" ? undefined : (arm.caseValue as AgencyNode).loc);
      throw new LoweringError(
        "match arm must return a value on every path when the match is used as an expression",
        loc,
      );
    }
    return rewritten;
  }

  /**
   * Recursively rewrite `return <expr>` into `matchYield { matchId, <expr> }`
   * within a match arm body. Descends ONLY into the return-flow-transparent
   * bodies defined by the shared `returnFlowBodies` boundary (if/else + loop
   * bodies) — the SAME boundary `containsReturn`/`firstReturnLoc` use, so they
   * can never disagree. Every other body-bearing node (nested `matchBlock`
   * arms, `handleBlock` bodies, `blockArgument`/callback bodies, concurrency
   * blocks) is opaque: a `return` inside it does not flow to this arm.
   * `return match(...)` lowers the inner match first, then yields its temp.
   */
  private rewriteReturnsToYields(body: AgencyNode[], matchId: number): AgencyNode[] {
    const out: AgencyNode[] = [];
    for (const stmt of body) {
      if (stmt.type === "returnStatement") {
        if (!stmt.value) {
          throw new LoweringError(
            "match arm must return a value on every path when the match is used as an expression",
            stmt.loc,
          );
        }
        if ((stmt.value as AgencyNode).type === "matchBlock") {
          // nested return match(...): lower inner first, yield its temp
          const inner = this.lowerMatchExpressionCore(stmt.value as MatchBlock, stmt.loc);
          out.push(...inner.statements);
          out.push({ type: "matchYield", matchId, value: inner.valueRef, loc: stmt.loc });
        } else {
          out.push({ type: "matchYield", matchId, value: stmt.value, loc: stmt.loc });
        }
        continue;
      }
      // Return-flow-transparent (if/else, for, while): rewrite its return-flow
      // bodies. `mapBodies` over these node types maps EXACTLY those bodies (they
      // carry no other body fields), so it agrees with `returnFlowBodies`.
      if (returnFlowBodies(stmt).length > 0) {
        out.push(mapBodies(stmt, (b) => this.rewriteReturnsToYields(b, matchId)));
        continue;
      }
      // A standalone `seq` inlines into the enclosing body, and `thread` /
      // `subthread` bodies run inline on this same runner, so a `return` inside
      // them yields into THIS match — the `_matchExit` lands on the arm's own
      // runner. Recurse the rewrite into their bodies. (A `seq` that is an arm
      // of a `parallel` is a concurrent `fork` branch and is never reached here:
      // we never descend into the `parallelBlock` below.)
      if (stmt.type === "seqBlock" || stmt.type === "messageThread") {
        out.push({
          ...stmt,
          body: this.rewriteReturnsToYields(
            (stmt as { body: AgencyNode[] }).body,
            matchId,
          ),
        });
        continue;
      }
      // A `parallel` branch is lifted into a separate `fork` frame whose child
      // runner the `_matchExit` unwind can't reach, and concurrent branches
      // would race the scalar flag — so a `return` that would yield this match
      // is rejected. (A `return` inside a `seq` arm of the parallel is a
      // branch-local result, not seen by `containsReturn`, and stays legal.)
      if (stmt.type === "parallelBlock" && containsReturn(stmt.body)) {
        throw new LoweringError(
          "cannot return from a match arm inside a parallel or fork block",
          stmt.loc,
        );
      }
      out.push(stmt);
    }
    return out;
  }

  /**
   * Syntactic all-paths-yield check (spec v1): a body yields on every path iff
   * it contains a top-level `matchYield`, or an `if`/`else` where BOTH branches
   * always yield. Loops never count (their body may not execute).
   */
  private alwaysYields(body: AgencyNode[]): boolean {
    for (const stmt of body) {
      if (stmt.type === "matchYield") return true;
      // A standalone `seq` and a `thread`/`subthread` body run unconditionally
      // and inline on this runner, so the arm yields on every path iff their
      // body does.
      if (
        (stmt.type === "seqBlock" || stmt.type === "messageThread") &&
        this.alwaysYields((stmt as { body: AgencyNode[] }).body)
      ) {
        return true;
      }
      if (
        stmt.type === "ifElse" &&
        stmt.elseBody &&
        this.alwaysYields(stmt.thenBody) &&
        this.alwaysYields(stmt.elseBody)
      ) {
        return true;
      }
      // loops never count (syntactic all-paths rule, spec v1 restrictions #4)
    }
    return false;
  }

  private lowerMatchIsForm(node: MatchBlock, matchExprId?: number): AgencyNode[] {
    if (matchExprId !== undefined) {
      throw new LoweringError(
        "match(x is pattern) cannot be used as an expression; use it as a statement",
        node.loc,
      );
    }
    // is-form is statement-only, so arm returns are always the unused-value bug.
    this.assertNoStatementArmReturns(node);
    const isExpr = node.expression as IsExpression;
    const scrutineeName = this.freshName("scrutinee");
    const scrutineeAssign: Assignment = {
      type: "assignment",
      variableName: scrutineeName,
      declKind: "const",
      value: isExpr.expression,
      loc: node.loc,
    };
    const scrutineeRef = varRef(scrutineeName, node.loc);
    const bindings = this.extractBindings(isExpr.pattern, scrutineeRef, "const", node.loc);

    // Each arm's caseValue is now a guard expression; build if/else chain over
    // them. Lowered up front, same as the pattern-arm form.
    const ifChain = this.buildIfChainFromGuardArms(
      this.lowerArmExpressionsIn(node.cases),
      node.loc,
    );
    const inside: AgencyNode[] = [...bindings];
    if (ifChain) inside.push(ifChain);

    // If the head pattern includes literal value checks (e.g. `match (x is { type: "a", v })`),
    // gate the bindings + arm chain on those checks. When the pattern doesn't
    // match at runtime the user has indicated a precondition, so we surface
    // the mismatch as a `failure` Result rather than silently no-oping.
    const patCond = patternToCondition(isExpr.pattern, scrutineeRef);
    if (patCond) {
      const failureMsg = "match(... is pattern) head pattern did not match";
      const failureCall: FunctionCall = {
        type: "functionCall",
        functionName: "failure",
        arguments: [stringLit(failureMsg, node.loc)],
        loc: node.loc as SourceLocation,
      };
      const failReturn = {
        type: "returnStatement" as const,
        value: failureCall as Expression,
        loc: node.loc,
      };
      const guardedIf: IfElse = {
        type: "ifElse",
        condition: patCond,
        thenBody: inside,
        elseBody: [failReturn as unknown as AgencyNode],
        loc: node.loc,
      };
      return [scrutineeAssign, guardedIf];
    }

    return [scrutineeAssign, ...inside];
  }

  /**
   * Reject any `return` in a statement-position match arm's ORIGINAL body. In a
   * statement match the arm value is discarded, so a `return` silently exits the
   * enclosing function instead — almost always a mistake. Uses the Task 6
   * `containsReturn` boundary (nested `matchBlock` arms are their own concern;
   * bare `return` counts) and points the user at `return match(...)`.
   */
  private assertNoStatementArmReturns(node: MatchBlock): void {
    for (const c of node.cases) {
      if (c.type !== "matchBlockCase") continue;
      if (containsReturn(c.body)) {
        throw new LoweringError(
          "`return` inside a match arm yields the match's value, but this match's " +
            "value is unused — did you mean `return match(...)`?",
          firstReturnLoc(c.body) ?? c.body[0]?.loc,
        );
      }
      // A `return` hidden inside a `thread { ... }` block within an arm is a
      // raw function return (thread bodies run inline in the same frame), so it
      // would silently keep the old exit-the-function semantics this error
      // exists to make loud. Lifted parallel/seq branch returns are branch
      // results, not function returns, so they stay legal in statement arms.
      const threadLoc = threadBlockReturnLoc(c.body);
      if (threadLoc) {
        throw new LoweringError(
          "`return` inside a `thread` block within a match arm exits the enclosing " +
            "function — move the match out of the arm or restructure; a match arm " +
            "cannot contain a function return",
          threadLoc,
        );
      }
    }
  }

  /** Recurse into the body of a single match arm (without lowering the arm itself). */
  private lowerMatchCase(c: MatchBlockCase): MatchBlockCase {
    const body = this.lowerBody(c.body);
    return { ...c, body };
  }

  /**
   * Lower an arm's two EXPRESSION slots — its `caseValue` when that is an
   * expression rather than a pattern, and its `guard`.
   *
   * The single funnel for both, on purpose. Lowering is opt-in per field, so
   * every consumer that reads one of these slots is a chance to forget:
   * `foldArms` used the guard raw, `lowerMatchCase` passes the caseValue
   * through untouched by design, and `collectChecks`'s literal case pushes the
   * caseValue straight into a comparison. Three readers, one of which can
   * always be missed. Normalizing at the two entry points instead means a
   * reader cannot receive an un-lowered arm no matter what it does with it.
   *
   * A pattern caseValue is left alone — a pattern is not an expression, and
   * `patternToCondition` is what turns it into one. `_` is a bare string.
   */
  private lowerArmExpressions(c: MatchBlockCase): MatchBlockCase {
    const caseValue =
      c.caseValue !== "_" && isExpressionNode(c.caseValue)
        ? this.lowerExpression(c.caseValue as Expression)
        : c.caseValue;
    const guard = c.guard ? this.lowerExpression(c.guard) : c.guard;
    return { ...c, caseValue, guard } as MatchBlockCase;
  }

  /** Apply `lowerArmExpressions` to every arm of a match. */
  private lowerArmExpressionsIn(cases: MatchBlock["cases"]): MatchBlock["cases"] {
    return cases.map((c) => (c.type === "matchBlockCase" ? this.lowerArmExpressions(c) : c));
  }

  /** Build an if/else chain from arms with patterns/guards/literals. */
  private buildIfChainFromArms(
    cases: MatchBlock["cases"],
    scrutinee: Expression,
    loc: SourceLocation | undefined,
  ): IfElse | undefined {
    const arms = cases.filter((c): c is MatchBlockCase => c.type === "matchBlockCase");
    return this.foldArms(arms, scrutinee, loc, false);
  }

  /** Build an if/else chain for `match(expr is pattern)` form (arms are guards). */
  private buildIfChainFromGuardArms(
    cases: MatchBlock["cases"],
    loc: SourceLocation | undefined,
  ): IfElse | undefined {
    const arms = cases.filter((c): c is MatchBlockCase => c.type === "matchBlockCase");
    return this.foldArms(arms, null, loc, true);
  }

  /**
   * Build a nested if/else chain from match arms.
   *
   * @param scrutinee  The expression to test against. Null when in `match(... is ...)` form,
   *                   where each `caseValue` is itself the boolean guard.
   * @param guardOnly  When true, treat each `caseValue` as a boolean guard expression
   *                   (the bindings have already been extracted).
   */
  private foldArms(
    arms: MatchBlockCase[],
    scrutinee: Expression | null,
    loc: SourceLocation | undefined,
    guardOnly: boolean,
  ): IfElse | undefined {
    let result: IfElse | undefined;
    for (let i = arms.length - 1; i >= 0; i--) {
      const arm = arms[i];
      const armBody = this.lowerBody(arm.body);

      if (arm.caseValue === "_" && !arm.guard) {
        // Default case: becomes an else-body. If we already have an `if`, attach as elseBody.
        if (result) {
          result = { ...result, elseBody: armBody };
        } else {
          // Default with no later arms — just inline body. Wrap in always-true if.
          result = {
            type: "ifElse",
            condition: boolLit(true, loc),
            thenBody: armBody,
            loc,
          };
        }
        continue;
      }

      if (arm.caseValue === "_") {
        // `_ if (cond)`: a conditional arm, not a default. `_` matches
        // anything, so the guard IS the whole condition, and a failing guard
        // falls through like any other arm — which for a trailing `_` means
        // the match matches nothing.
        //
        // Dropping the guard here (the previous behavior) made the arm fire
        // unconditionally, silently. The exhaustiveness checker already models
        // it the right way round: `isCatchAll` returns false for a guarded arm
        // (lib/typeChecker/matchExhaustiveness.ts), so a guarded `_` is
        // reported as NOT covering the remaining cases. Honoring the guard
        // makes the two halves agree.
        result = {
          type: "ifElse",
          condition: arm.guard!,
          thenBody: armBody,
          elseBody: result ? [result] : undefined,
          loc,
        };
        continue;
      }

      // Build the condition for this arm
      let condition: Expression;
      let bindings: Assignment[] = [];

      if (guardOnly) {
        // The caseValue IS the guard expression in match(... is ...) form.
        // Already lowered by lowerArmExpressions at the entry point.
        condition = arm.caseValue as Expression;
      } else {
        const matchPat = arm.caseValue as MatchPattern;
        const patCond = patternToCondition(matchPat, scrutinee!);
        condition = patCond ?? boolLit(true, loc);
        bindings = this.extractBindings(matchPat as BindingPattern, scrutinee!, "const", loc);
      }

      // Apply guard if present (for non-guardOnly arms)
      if (!guardOnly && arm.guard) {
        // Already lowered by lowerArmExpressions, so an `is` here is a
        // boolean test by now and a shorthand binder inside one has already
        // been rejected.
        const guard = arm.guard;
        // Guard may reference bindings, so we need bindings in scope first.
        // Strategy: emit `if (patCond) { let bindings; if (guard) { body } else <next-arm> }
        //                  else <next-arm>`
        // We fold guard into the condition with `&&` only when there are no
        // bindings AND the next arm chain doesn't depend on those bindings —
        // safe because there are no bindings to share. With bindings we must
        // build a nested if and replicate the next-arm chain in BOTH the
        // outer and inner else branches so guard failure falls through to the
        // next arm (it would otherwise exit the match entirely).
        if (bindings.length === 0) {
          condition = makeBinOp(condition, "&&", guard, loc);
        } else {
          const innerIf: IfElse = {
            type: "ifElse",
            condition: guard,
            thenBody: armBody,
            elseBody: result ? [result] : undefined,
            loc,
          };
          const thenBody: AgencyNode[] = [...bindings, innerIf];
          const next: IfElse = {
            type: "ifElse",
            condition,
            thenBody,
            elseBody: result ? [result] : undefined,
            loc,
          };
          result = next;
          continue;
        }
      }

      const thenBody: AgencyNode[] = [...bindings, ...armBody];
      const next: IfElse = {
        type: "ifElse",
        condition,
        thenBody,
        elseBody: result ? [result] : undefined,
        loc,
      };
      result = next;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // For loop
  // -------------------------------------------------------------------------

  private lowerForLoop(node: ForLoop): ForLoop {
    if (typeof node.itemVar === "string") {
      return { ...node, body: this.lowerBody(node.body) };
    }
    const tempItem = this.freshName("item");
    const tempRef = varRef(tempItem, node.loc);
    const bindings = this.extractBindings(node.itemVar, tempRef, "const", node.loc);
    return {
      ...node,
      itemVar: tempItem,
      body: [...bindings, ...this.lowerBody(node.body)],
    };
  }

  // -------------------------------------------------------------------------
  // extractBindings — recursive: builds Assignment nodes from a pattern + source
  // -------------------------------------------------------------------------

  private extractBindings(
    pattern: BindingPattern | MatchPattern,
    source: Expression,
    declKind: "let" | "const",
    loc: SourceLocation | undefined,
  ): Assignment[] {
    switch (pattern.type) {
      case "objectPattern": {
        // Compute named keys up-front for any rest pattern.
        const namedKeys: string[] = pattern.properties.flatMap((p) =>
          p.type === "objectPatternShorthand"
            ? [p.name]
            : p.type === "objectPatternProperty"
              ? [p.key]
              : [],
        );
        return pattern.properties.flatMap((prop): Assignment[] => {
          if (prop.type === "objectPatternShorthand") {
            return [makeAssign(prop.name, fieldAccess(source, prop.name, loc), declKind, loc)];
          }
          if (prop.type === "objectPatternProperty") {
            return this.extractBindings(prop.value, fieldAccess(source, prop.key, loc), declKind, loc);
          }
          // restPattern
          return [makeAssign(prop.identifier, makeObjectRestCall(source, namedKeys, loc), declKind, loc)];
        });
      }
      case "arrayPattern": {
        // Same split as collectChecks: head binders read from the front, the
        // rest takes the middle, tail binders read from the back.
        const { head, tail } = splitAtRest(pattern.elements);
        const headBindings = head.flatMap((el, i): Assignment[] => {
          if (el.type === "wildcardPattern") return [];
          return this.extractBindings(el, indexAccess(source, i, loc), declKind, loc);
        });
        const restBindings = pattern.elements.flatMap((el): Assignment[] =>
          el.type === "restPattern"
            ? [
                makeAssign(
                  el.identifier,
                  restSlice(source, head.length, tail.length, loc),
                  declKind,
                  loc,
                ),
              ]
            : [],
        );
        // A tail binder reads from the end, which aliases a leading binder when
        // the value is too short. Matching cannot reach that state (the length
        // check fails first); a declaration can, so guard the source here.
        const guardedSource =
          tail.length > 0
            ? requireLengthCall(source, head.length + tail.length, loc)
            : source;
        const tailBindings = tail.flatMap((el, i): Assignment[] => {
          if (el.type === "wildcardPattern") return [];
          return this.extractBindings(
            el,
            indexFromEnd(guardedSource, tail.length - i, loc),
            declKind,
            loc,
          );
        });
        return [...headBindings, ...restBindings, ...tailBindings];
      }
      case "variableName":
        return [makeAssign(pattern.value, cloneExpr(source), declKind, loc)];
      case "wildcardPattern":
      case "restPattern":
        return [];
      case "resultPattern": {
        if (pattern.binding === null) return [];
        const field = pattern.kind === "success" ? "value" : "error";
        return [
          makeAssign(
            pattern.binding,
            fieldAccess(source, field, loc),
            declKind,
            loc,
          ),
        ];
      }
      case "typePattern":
        // The type test contributes no bindings of its own; the inner
        // pattern binds from the SAME source — the original value, never a
        // validator-transformed copy (spec Rule 1).
        return pattern.pattern === null
          ? []
          : this.extractBindings(pattern.pattern, source, declKind, loc);
      default:
        // Literal — produces no binding
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// patternToCondition — boolean expression for `is` and match arms
// ---------------------------------------------------------------------------

function patternToCondition(pattern: MatchPattern, source: Expression): Expression | null {
  const checks: Expression[] = [];
  collectChecks(pattern, source, checks);
  if (checks.length === 0) return null;
  return checks.reduce((a, b) => makeBinOp(a, "&&", b, undefined));
}

/** `is object` — non-null, non-array (lib/runtime/typeTest.ts). */
const OBJECT_HINT: VariableType = { type: "primitiveType", value: "object" };
/** `is any[]` — the coarse "is an array" check. */
const ARRAY_HINT: VariableType = {
  type: "arrayType",
  elementType: { type: "primitiveType", value: "any" },
};

/**
 * The shape check an object or array pattern emits before reading into a
 * value: `source != null && __coarseTypeTest(source, kind)`.
 *
 * The coarse test alone is enough at runtime — it already rejects null. The
 * `!= null` in front is there for the TYPE CHECKER: narrowing by `is object`
 * lands on the opaque `object` type, which has no fields, so
 * `{ redirect: { op: ">" } }` against a `Redirect | null` field would report
 * "Property 'op' does not exist on type 'object'". Narrowing by `!= null`
 * filters the union properly and leaves `Redirect`, and the coarse test that
 * follows does not clobber that. Two cheap comparisons buy a pattern that
 * both runs right and typechecks.
 *
 * The `!= null` half can be dropped once that narrowing gap is fixed:
 * docs/superpowers/ideas/2026-07-24-is-object-narrowing-loses-union-members.md
 */
function shapeCheck(
  source: Expression,
  typeHint: VariableType,
  loc: SourceLocation | undefined,
): Expression[] {
  const notNull = makeBinOp(cloneExpr(source), "!=", nullLit(loc), loc);
  const coarse = {
    type: "typeTestExpression",
    expression: cloneExpr(source),
    typeHint,
    loc,
  } as Expression;
  return [notNull, coarse];
}

function collectChecks(pattern: MatchPattern, source: Expression, checks: Expression[]): void {
  switch (pattern.type) {
    case "objectPattern":
      // Shape check FIRST: everything below reads a field off `source`, and a
      // pattern's job is to answer "does this match", so a value of the wrong
      // shape has to fail the arm rather than throw on `null.a` — or match by
      // reading `undefined` off a number. `&&` short-circuits, so this also
      // makes the reads below safe.
      //
      // Note this rejects ARRAYS too, not only null and non-objects: Agency's
      // `object` is non-null and non-array (lib/runtime/typeTest.ts). So
      // `{ length: 2 }` no longer matches an array — `[a, b]` is the spelling
      // for that. One definition of `object`, not two.
      checks.push(...shapeCheck(source, OBJECT_HINT, pattern.loc));
      for (const prop of pattern.properties) {
        if (prop.type === "objectPatternProperty") {
          collectChecks(prop.value as MatchPattern, fieldAccess(source, prop.key, pattern.loc), checks);
        }
        // shorthand and rest do not produce checks (binders only)
      }
      break;
    case "arrayPattern": {
      // Shape check FIRST, for the same reason — and because `.length` alone
      // does not distinguish an array from a string: `"abc"` has length 3 and
      // would otherwise match `[a, b]`, binding characters.
      checks.push(...shapeCheck(source, ARRAY_HINT, pattern.loc));
      // Length check. With a rest binder the pattern names a minimum; without
      // one it names the whole array, so the length must match exactly.
      // `["a", "b"]` used to accept ["a","b","c"] — every array pattern was a
      // prefix match, and there was no way to say "exactly these two".
      const hasRest = pattern.elements.some((e) => e.type === "restPattern");
      const namedCount = pattern.elements.filter((e) => e.type !== "restPattern").length;
      const lenAccess = fieldAccess(source, "length", pattern.loc);
      // `==` emits `__eq(len, n)` where `>=` is native. That asymmetry is
      // deliberate language-wide, not an oversight here: every equality
      // operator routes through `__eq` so null and undefined compare equal,
      // and `===` is documented as a stylistic alias that compiles
      // identically (typescriptBuilder.ts:1379, docs/dev/null-and-undefined.md).
      // Emitting a native comparison would make this one generated check the
      // only equality in the language that skips the helper.
      const op: Operator = hasRest ? ">=" : "==";
      checks.push(makeBinOp(lenAccess, op, numberLit(namedCount, pattern.loc), pattern.loc));

      // A rest binder may sit anywhere, so elements before it are indexed from
      // the front and elements after it from the back. With no rest (or a
      // trailing one) `tail` is empty and this is the original front-indexed
      // walk.
      const { head, tail } = splitAtRest(pattern.elements);
      const needsCheck = (el: { type: string }): boolean =>
        el.type !== "wildcardPattern" &&
        el.type !== "restPattern" &&
        el.type !== "variableName";

      head.forEach((el, i) => {
        if (needsCheck(el)) {
          collectChecks(el as MatchPattern, indexAccess(source, i, pattern.loc), checks);
        }
      });
      tail.forEach((el, i) => {
        if (needsCheck(el)) {
          // 1-based from the end: the last element of `tail` is the last
          // element of the array.
          const fromEnd = tail.length - i;
          collectChecks(el as MatchPattern, indexFromEnd(source, fromEnd, pattern.loc), checks);
        }
      });
      break;
    }
    case "variableName":
    case "wildcardPattern":
    case "restPattern":
      // Always true (binders match anything)
      break;
    case "resultPattern":
      checks.push(resultCheckCall(pattern.kind, source, pattern.loc));
      break;
    case "typePattern": {
      // The runtime type test itself, compiled away by the builder (coarse
      // check or schema validation). Inner-pattern checks run after it.
      checks.push({
        type: "typeTestExpression",
        expression: cloneExpr(source),
        typeHint: pattern.typeHint,
        loc: pattern.loc,
      } as Expression);
      if (pattern.pattern !== null) {
        collectChecks(pattern.pattern as MatchPattern, source, checks);
      }
      break;
    }
    default: {
      // Literal — equality check
      checks.push(makeBinOp(cloneExpr(source), "==", pattern as Expression, pattern.loc));
      break;
    }
  }
}

function resultCheckCall(
  kind: "success" | "failure",
  source: Expression,
  loc: SourceLocation | undefined,
): FunctionCall {
  return {
    type: "functionCall",
    functionName: kind === "success" ? "isSuccess" : "isFailure",
    arguments: [cloneExpr(source)],
    loc: loc as SourceLocation,
  };
}

// ---------------------------------------------------------------------------
// assertNoBindersInBoolIs — compile error if binders appear in pure-boolean `is`
// ---------------------------------------------------------------------------

export class PatternLoweringError extends Error {
  constructor(message: string, public loc?: SourceLocation) {
    super(message);
    this.name = "PatternLoweringError";
  }
}

function assertNoBindersInBoolIs(pattern: MatchPattern): void {
  walkPattern(pattern, (p) => {
    const loc = "loc" in p ? p.loc : undefined;
    if (p.type === "objectPatternShorthand") {
      throw new PatternLoweringError(
        "shorthand binder in pure-boolean `is` context has nowhere to bind; binders are introduced by an `if` or `while` CONDITION, or by a match arm pattern — a match-arm guard is a pure-boolean context even though it is spelled with `if`",
        loc,
      );
    }
    if (p.type === "restPattern") {
      throw new PatternLoweringError(
        "rest binder in pure-boolean `is` context has nowhere to bind; binders are introduced by an `if` or `while` CONDITION, or by a match arm pattern — a match-arm guard is a pure-boolean context even though it is spelled with `if`",
        loc,
      );
    }
    if (p.type === "variableName") {
      throw new PatternLoweringError(
        `bare identifier binder \`${p.value}\` in pure-boolean \`is\` context has nowhere to bind; binders are introduced by an \`if\` or \`while\` CONDITION, or by a match arm pattern — a match-arm guard is a pure-boolean context even though it is spelled with \`if\``,
        loc,
      );
    }
    if (
      p.type === "resultPattern" &&
      (p as ResultPattern).binding !== null
    ) {
      throw new PatternLoweringError(
        `result pattern binder in pure-boolean \`is\` context has nowhere to bind; binders are introduced by an \`if\` or \`while\` CONDITION, or by a match arm pattern — a match-arm guard is a pure-boolean context even though it is spelled with \`if\``,
        loc,
      );
    }
  });
}

function walkPattern(
  pattern: MatchPattern | ObjectPatternProperty | ObjectPatternShorthand,
  visit: (p: MatchPattern | ObjectPatternProperty | ObjectPatternShorthand) => void,
): void {
  visit(pattern);
  if ("type" in pattern) {
    if (pattern.type === "objectPattern") {
      for (const prop of pattern.properties) {
        if (prop.type === "objectPatternProperty") {
          walkPattern(prop, visit);
          walkPattern(prop.value as MatchPattern, visit);
        } else {
          // shorthand or rest
          walkPattern(prop, visit);
        }
      }
    } else if (pattern.type === "arrayPattern") {
      for (const el of pattern.elements) {
        walkPattern(el as MatchPattern, visit);
      }
    } else if (pattern.type === "objectPatternProperty") {
      walkPattern(pattern.value as MatchPattern, visit);
    } else if (pattern.type === "typePattern" && pattern.pattern !== null) {
      walkPattern(pattern.pattern, visit);
    }
  }
}

// ---------------------------------------------------------------------------
// AST factory helpers
// ---------------------------------------------------------------------------

function isExpr(v: unknown): v is Expression {
  if (typeof v !== "object" || v === null || !("type" in v)) return false;
  // Exclude non-Expression node types that may share the union with Expression
  // in some fields (e.g. Assignment.value is `Expression | MessageThread`).
  const t = (v as { type: string }).type;
  return t !== "messageThread";
}

/** Location of the first `thread { ... }` block within the arm's return-flow
 *  that hides a `return`, or undefined. Thread bodies run inline in the same
 *  frame, so a `return` there is a genuine function return; statement-position
 *  arms must reject it to keep the breaking change loud. Walks the shared
 *  `returnFlowBodies` boundary so it sees exactly what `containsReturn`
 *  cannot. */
function threadBlockReturnLoc(nodes: AgencyNode[]): SourceLocation | undefined {
  for (const node of nodes) {
    if (node.type === "messageThread" && containsReturn(node.body)) {
      return node.loc;
    }
    for (const body of returnFlowBodies(node)) {
      const found = threadBlockReturnLoc(body);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * THE single source of truth for the match-arm return-flow descent boundary.
 * Returns the child bodies of `node` that a `return` flows through to reach the
 * enclosing arm: the `if`/`else` branches and `for`/`while` loop bodies ONLY.
 * Every other body-bearing node is opaque here — a `return` inside a nested
 * `matchBlock` arm, a `handleBlock` (guarded body OR `with` handler),
 * `blockArgument`/callback body, or `parallel` branch does NOT flow to this arm
 * (it belongs to that inner construct / a separate frame). Shared by
 * `rewriteReturnsToYields`, `containsReturn`, and `firstReturnLoc` so their
 * boundaries can never diverge again.
 *
 * NOTE: standalone `seq` and `thread`/`subthread` bodies DO flow a `return` to
 * the enclosing match arm (they run inline on the arm's own runner), but that
 * transparency is applied explicitly in `rewriteReturnsToYields`/`alwaysYields`
 * — NOT here — so the statement-arm diagnostics and the `parallel` rejection
 * that consume this boundary keep treating them as opaque.
 */
function returnFlowBodies(node: AgencyNode): AgencyNode[][] {
  if (node.type === "ifElse") {
    return node.elseBody ? [node.thenBody, node.elseBody] : [node.thenBody];
  }
  if (node.type === "forLoop" || node.type === "whileLoop") {
    return [node.body];
  }
  return [];
}

/**
 * True when any node in `nodes` is a `returnStatement` reachable within the
 * arm's own return-flow, using the shared `returnFlowBodies` boundary (does not
 * descend into nested match arms, handler bodies, block args, or concurrency
 * blocks).
 */
function containsReturn(nodes: AgencyNode[]): boolean {
  for (const node of nodes) {
    if (node.type === "returnStatement") return true;
    for (const body of returnFlowBodies(node)) {
      if (containsReturn(body)) return true;
    }
  }
  return false;
}

/**
 * Location of the first `returnStatement` in `nodes` using the same
 * `returnFlowBodies` boundary as `containsReturn`. Used to anchor the
 * statement-position return diagnostic on the offending `return`.
 */
function firstReturnLoc(nodes: AgencyNode[]): SourceLocation | undefined {
  for (const node of nodes) {
    if (node.type === "returnStatement") return node.loc;
    for (const body of returnFlowBodies(node)) {
      const found = firstReturnLoc(body);
      if (found) return found;
    }
  }
  return undefined;
}

function varRef(name: string, loc: SourceLocation | undefined): VariableNameLiteral {
  return { type: "variableName", value: name, loc: loc as SourceLocation };
}

function fieldAccess(source: Expression, key: string, loc: SourceLocation | undefined): ValueAccess {
  return chainAccess(source, [{ kind: "property", name: key }], loc);
}

function indexAccess(source: Expression, i: number, loc: SourceLocation | undefined): ValueAccess {
  return chainAccess(
    source,
    [{ kind: "index", index: numberLit(i, loc) }],
    loc,
  );
}

/**
 * `source[source.length - fromEnd]` — an element counted from the back, for
 * the elements that follow a rest binder. `fromEnd` is 1-based: the last
 * element is 1.
 */
function indexFromEnd(
  source: Expression,
  fromEnd: number,
  loc: SourceLocation | undefined,
): ValueAccess {
  const offset = makeBinOp(
    fieldAccess(cloneExpr(source), "length", loc),
    "-",
    numberLit(fromEnd, loc),
    loc,
  );
  return chainAccess(source, [{ kind: "index", index: offset }], loc);
}

/**
 * The slice a rest binder takes. With nothing after it this is the
 * one-argument `source.slice(start)` — the same node the prefix case has
 * always produced, kept deliberately so lifting this restriction does not
 * churn every existing rest fixture.
 */
/**
 * `__requireLength(source, min)` — the guard a DECLARATION needs and a match
 * gets for free. `collectChecks` emits a length check before any element read;
 * `extractBindings` emits none, because a declaration binds rather than tests.
 * Without this, `const [a, ...m, b] = ["a"]` binds `a` and `b` to the same
 * element, silently.
 */
function requireLengthCall(
  source: Expression,
  min: number,
  loc: SourceLocation | undefined,
): Expression {
  return {
    type: "functionCall",
    functionName: "__requireLength",
    // Lowerer-created, so the undefined-function check skips it.
    synthetic: true,
    arguments: [cloneExpr(source), numberLit(min, loc)],
    loc,
  } as Expression;
}

function restSlice(
  source: Expression,
  start: number,
  tailCount: number,
  loc: SourceLocation | undefined,
): ValueAccess {
  if (tailCount === 0) return sliceCall(source, start, loc);
  const end = makeBinOp(
    fieldAccess(cloneExpr(source), "length", loc),
    "-",
    numberLit(tailCount, loc),
    loc,
  );
  return chainAccess(
    source,
    [{ kind: "slice", start: numberLit(start, loc), end }],
    loc,
  );
}

/**
 * Split an array pattern at its rest binder. `restIndex` is -1 when there is
 * none, in which case everything is head and the two halves behave exactly as
 * they did before rest binders could sit anywhere.
 */
function splitAtRest<T extends { type: string }>(
  elements: readonly T[],
): { head: readonly T[]; tail: readonly T[]; restIndex: number } {
  const restIndex = elements.findIndex((e) => e.type === "restPattern");
  if (restIndex === -1) return { head: elements, tail: [], restIndex };
  return {
    head: elements.slice(0, restIndex),
    tail: elements.slice(restIndex + 1),
    restIndex,
  };
}

function sliceCall(source: Expression, start: number, loc: SourceLocation | undefined): ValueAccess {
  return chainAccess(
    source,
    [{ kind: "slice", start: numberLit(start, loc) }],
    loc,
  );
}

/**
 * Deep-clone an expression before embedding it into generated AST. The pattern
 * lowering reuses one scrutinee (`__scrutinee_N`) reference across every arm's
 * condition and binding; embedding the SAME node object in multiple positions
 * aliases it, and the flow checker keys narrowing on AST-node identity — so a
 * shared scrutinee node would resolve to whichever branch the flow builder
 * walked last (e.g. the `success` arm's `.value` narrowing against the `failure`
 * member). Cloning at each embedding guarantees every occurrence is a distinct
 * node, preserving the one-node-per-occurrence invariant the flow graph relies on.
 */
function cloneExpr<T extends Expression>(e: T): T {
  return structuredClone(e);
}

function chainAccess(
  source: Expression,
  chain: AccessChainElement[],
  loc: SourceLocation | undefined,
): ValueAccess {
  const base = cloneExpr(source);
  // If source is already a ValueAccess, append to its chain.
  if (base.type === "valueAccess") {
    return { ...base, chain: [...base.chain, ...chain] };
  }
  return {
    type: "valueAccess",
    base: base as unknown as ValueAccess["base"],
    chain,
    loc: loc as SourceLocation,
  };
}

/**
 * Emit a call to the synthetic `__objectRest` function. The TS builder
 * intercepts this name and emits an inline IIFE using native JS destructuring,
 * so no runtime helper is needed. The function is registered as a builtin so
 * the typechecker accepts the call.
 *
 * For `let { a, b, ...rest } = obj`, this emits:
 *   __objectRest(__tmp_1, ["a", "b"])
 * which the TS builder turns into:
 *   (({ a: __a, b: __b, ...__r }) => __r)(<resolved source>)
 */
function makeObjectRestCall(
  source: Expression,
  excludedKeys: string[],
  loc: SourceLocation | undefined,
): FunctionCall {
  const keysArray: AgencyArray = {
    type: "agencyArray",
    items: excludedKeys.map((k) => stringLit(k, loc)),
    loc: loc as SourceLocation,
  };
  return {
    type: "functionCall",
    functionName: OBJECT_REST_FN,
    // Not user code: no declaration exists to resolve it to.
    synthetic: true,
    arguments: [cloneExpr(source), keysArray],
    loc: loc as SourceLocation,
  };
}

function stringLit(value: string, loc: SourceLocation | undefined): StringLiteral {
  return {
    type: "string",
    segments: [{ type: "text", value }],
    loc: loc as SourceLocation,
  };
}

function makeAssign(
  name: string,
  value: Expression,
  declKind: "let" | "const",
  loc: SourceLocation | undefined,
): Assignment {
  return {
    type: "assignment",
    variableName: name,
    declKind,
    value,
    loc: loc as SourceLocation,
  };
}

function makeBinOp(
  left: Expression,
  op: Operator,
  right: Expression,
  loc: SourceLocation | undefined,
): BinOpExpression {
  return {
    type: "binOpExpression",
    operator: op,
    left,
    right,
    loc: loc as SourceLocation,
  };
}

function numberLit(value: number, loc: SourceLocation | undefined): NumberLiteral {
  return { type: "number", value: String(value), loc: loc as SourceLocation };
}

function boolLit(value: boolean, loc: SourceLocation | undefined): Literal {
  return { type: "boolean", value, loc: loc as SourceLocation };
}

function nullLit(loc: SourceLocation | undefined): Expression {
  return { type: "null", loc: loc as SourceLocation } as Expression;
}

// Note: BINDING extraction emits no null/undefined checks. Native JS already
// throws `TypeError: Cannot read properties of null (reading 'foo')` on
// `__tmp.foo`, which is sufficient for users to diagnose a failed
// destructuring — and `const { name } = null` producing a failure Result is
// the documented behavior. MATCHING is different: a value that does not match
// must fail the arm, not throw, so `collectChecks` guards its reads. See
// `shapeCheck`.
