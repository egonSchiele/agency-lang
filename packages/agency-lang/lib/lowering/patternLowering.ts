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
  IfElse,
  MatchBlock,
  MatchBlockCase,
  WhileLoop,
} from "../types.js";
import type { BinOpExpression, Operator } from "../types/binop.js";
import type { AgencyArray } from "../types/dataStructures.js";
import type {
  BindingPattern,
  IsExpression,
  MatchPattern,
  ObjectPatternProperty,
  ObjectPatternShorthand,
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function lowerPatterns(nodes: AgencyNode[]): AgencyNode[] {
  return new PatternLowerer().lower(nodes);
}

class PatternLowerer {
  private counter = 0;

  private freshName(prefix: string): string {
    return `__${prefix}_${++this.counter}`;
  }

  lower(nodes: AgencyNode[]): AgencyNode[] {
    return nodes.flatMap((n) => this.lowerNode(n));
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
      case "returnStatement": {
        const ret = node as { type: "returnStatement"; value?: Expression; loc?: SourceLocation };
        return [
          {
            ...(ret as object),
            value: ret.value !== undefined ? this.lowerExpression(ret.value) : undefined,
          } as AgencyNode,
        ];
      }
      default: {
        // Recurse into every body field on body-bearing nodes (function /
        // graphNode / handleBlock / parallelBlock / seqBlock / blockArgument /
        // functionCall.block / …). For nodes that are also Expressions,
        // additionally walk the expression tree so nested `isExpression` is
        // lowered.
        const withRecursedBodies = mapBodies(node, (b) => this.lower(b));
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
        ? { ...expr.block, body: this.lower(expr.block.body) }
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
        thenBody: [...bindings, ...this.lower(node.thenBody)],
        elseBody: node.elseBody ? this.lower(node.elseBody) : undefined,
      };
    }
    return {
      ...node,
      condition: this.lowerExpression(node.condition),
      thenBody: this.lower(node.thenBody),
      elseBody: node.elseBody ? this.lower(node.elseBody) : undefined,
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
        body: [...bindings, ...this.lower(node.body)],
      };
    }
    return {
      ...node,
      condition: this.lowerExpression(node.condition),
      body: this.lower(node.body),
    };
  }

  // -------------------------------------------------------------------------
  // Match block
  // -------------------------------------------------------------------------

  private lowerMatchBlock(node: MatchBlock): AgencyNode[] {
    if (node.expression.type === "isExpression") {
      return this.lowerMatchIsForm(node);
    }

    // Check if any arm uses patterns or has a guard.
    const hasPatternArms = node.cases.some(
      (c) =>
        c.type === "matchBlockCase" &&
        ((c.caseValue !== "_" && (c.caseValue.type === "objectPattern" || c.caseValue.type === "arrayPattern")) ||
          c.guard !== undefined),
    );

    if (!hasPatternArms) {
      // Pure literal/identifier match — pass through, but still recurse into arm bodies.
      return [
        {
          ...node,
          cases: node.cases.map((c) => (c.type === "matchBlockCase" ? this.lowerMatchCase(c) : c)),
        },
      ];
    }

    // Bind scrutinee to a temp (evaluate exactly once even if expression has side effects).
    const scrutineeName = this.freshName("scrutinee");
    const scrutineeAssign: Assignment = {
      type: "assignment",
      variableName: scrutineeName,
      declKind: "const",
      value: node.expression,
      loc: node.loc,
    };
    const scrutineeRef = varRef(scrutineeName, node.loc);

    const ifChain = this.buildIfChainFromArms(node.cases, scrutineeRef, node.loc);
    return ifChain ? [scrutineeAssign, ifChain] : [scrutineeAssign];
  }

  private lowerMatchIsForm(node: MatchBlock): AgencyNode[] {
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

    // Each arm's caseValue is now a guard expression; build if/else chain over them.
    const ifChain = this.buildIfChainFromGuardArms(node.cases, node.loc);
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

  /** Recurse into the body of a single match arm (without lowering the arm itself). */
  private lowerMatchCase(c: MatchBlockCase): MatchBlockCase {
    const lowered = this.lower([c.body]);
    const body = lowered[0] as MatchBlockCase["body"];
    return { ...c, body };
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
      const armBody = this.lower([arm.body]);

      if (arm.caseValue === "_") {
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

      // Build the condition for this arm
      let condition: Expression;
      let bindings: Assignment[] = [];

      if (guardOnly) {
        // The caseValue IS the guard expression in match(... is ...) form
        condition = arm.caseValue as Expression;
      } else {
        const matchPat = arm.caseValue as MatchPattern;
        const patCond = patternToCondition(matchPat, scrutinee!);
        condition = patCond ?? boolLit(true, loc);
        bindings = this.extractBindings(matchPat as BindingPattern, scrutinee!, "const", loc);
      }

      // Apply guard if present (for non-guardOnly arms)
      if (!guardOnly && arm.guard) {
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
          condition = makeBinOp(condition, "&&", arm.guard, loc);
        } else {
          const innerIf: IfElse = {
            type: "ifElse",
            condition: arm.guard,
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
      return { ...node, body: this.lower(node.body) };
    }
    const tempItem = this.freshName("item");
    const tempRef = varRef(tempItem, node.loc);
    const bindings = this.extractBindings(node.itemVar, tempRef, "const", node.loc);
    return {
      ...node,
      itemVar: tempItem,
      body: [...bindings, ...this.lower(node.body)],
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
      case "arrayPattern":
        return pattern.elements.flatMap((el, i): Assignment[] => {
          if (el.type === "wildcardPattern") return [];
          if (el.type === "restPattern") {
            return [makeAssign(el.identifier, sliceCall(source, i, loc), declKind, loc)];
          }
          return this.extractBindings(el, indexAccess(source, i, loc), declKind, loc);
        });
      case "variableName":
        return [makeAssign(pattern.value, source, declKind, loc)];
      case "wildcardPattern":
      case "restPattern":
        return [];
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

function collectChecks(pattern: MatchPattern, source: Expression, checks: Expression[]): void {
  switch (pattern.type) {
    case "objectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "objectPatternProperty") {
          collectChecks(prop.value as MatchPattern, fieldAccess(source, prop.key, pattern.loc), checks);
        }
        // shorthand and rest do not produce checks (binders only)
      }
      break;
    case "arrayPattern": {
      // Length check — at least as many elements as named (excluding rest).
      const hasRest = pattern.elements.some((e) => e.type === "restPattern");
      const namedCount = pattern.elements.filter((e) => e.type !== "restPattern").length;
      const lenAccess = fieldAccess(source, "length", pattern.loc);
      const op: Operator = hasRest ? ">=" : ">=";
      checks.push(makeBinOp(lenAccess, op, numberLit(namedCount, pattern.loc), pattern.loc));
      pattern.elements.forEach((el, i) => {
        if (
          el.type !== "wildcardPattern" &&
          el.type !== "restPattern" &&
          el.type !== "variableName"
        ) {
          collectChecks(el as MatchPattern, indexAccess(source, i, pattern.loc), checks);
        }
      });
      break;
    }
    case "variableName":
    case "wildcardPattern":
    case "restPattern":
      // Always true (binders match anything)
      break;
    default: {
      // Literal — equality check
      checks.push(makeBinOp(source, "==", pattern as Expression, pattern.loc));
      break;
    }
  }
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
        "shorthand binder in pure-boolean `is` context has nowhere to bind; use `if (x is { ... })` to introduce variables",
        loc,
      );
    }
    if (p.type === "restPattern") {
      throw new PatternLoweringError(
        "rest binder in pure-boolean `is` context has nowhere to bind; use `if (x is { ... })` to introduce variables",
        loc,
      );
    }
    if (p.type === "variableName") {
      throw new PatternLoweringError(
        `bare identifier binder \`${p.value}\` in pure-boolean \`is\` context has nowhere to bind; use \`if (x is pattern)\` to introduce variables`,
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

function sliceCall(source: Expression, start: number, loc: SourceLocation | undefined): ValueAccess {
  return chainAccess(
    source,
    [{ kind: "slice", start: numberLit(start, loc) }],
    loc,
  );
}

function chainAccess(
  source: Expression,
  chain: AccessChainElement[],
  loc: SourceLocation | undefined,
): ValueAccess {
  // If source is already a ValueAccess, append to its chain.
  if (source.type === "valueAccess") {
    return { ...source, chain: [...source.chain, ...chain] };
  }
  return {
    type: "valueAccess",
    base: source as unknown as ValueAccess["base"],
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
    functionName: "__objectRest",
    arguments: [source, keysArray],
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

// Note: no explicit null/undefined checks are emitted. Native JS already throws
// `TypeError: Cannot read properties of null (reading 'foo')` on `__tmp.foo`,
// which is sufficient for users to diagnose destructuring failures.
