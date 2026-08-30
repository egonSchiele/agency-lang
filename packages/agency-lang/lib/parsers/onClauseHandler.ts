import type { AgencyNode, Assignment, Expression } from "@/types.js";
import type { IfElse } from "@/types/ifElse.js";
import type { HandleBlock } from "@/types/handleBlock.js";
import type { FunctionParameter } from "@/types/function.js";
import type { MatchBlock, MatchBlockCase } from "@/types/matchBlock.js";
import type { StringLiteral, VariableNameLiteral } from "@/types/literals.js";
import type { ValueAccess } from "@/types/access.js";

/** One parsed `on` clause, produced by `onClauseHandlerParser` and consumed by
 *  the builders below. */
export type ParsedOnClause = {
  /** Normalized effect name, e.g. "std::read". null = the `on _` catch-all. */
  effect: string | null;
  /** The binding from `on eff(param)`. null = `on eff(_)`, `on eff`, or `on _`. */
  binding: string | null;
  /** The clause body exactly as written, before lifting/completion. */
  body: AgencyNode[];
};

// The four verdict builtins a handler can return. A bare tail-position call to
// one of these is the author's verdict (`on std::read(data) { approve() }`),
// even though they wrote no `return`.
const VERDICT_NAMES = ["approve", "reject", "pass", "propagate"] as const;

function isBareVerdictCall(node: AgencyNode): boolean {
  return (
    node.type === "functionCall" &&
    (VERDICT_NAMES as readonly string[]).includes(node.functionName)
  );
}

/** Turn a tail-position bare verdict call into `return <call>`. Descends into a
 *  trailing `if` — with or without an else; each branch that exists is lifted —
 *  and nothing else. A trailing `match` is left as written (the author must
 *  write `return` inside its arms; completion then makes such a clause pass). */
export function liftTailVerdicts(body: AgencyNode[]): AgencyNode[] {
  if (body.length === 0) {
    return body;
  }
  const out = body.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx];

  if (isBareVerdictCall(last)) {
    out[lastIdx] = { type: "returnStatement", value: last as Expression } as AgencyNode;
    return out;
  }

  if (last.type === "ifElse") {
    const ifNode = last as IfElse;
    const lifted: IfElse = { ...ifNode, thenBody: liftTailVerdicts(ifNode.thenBody) };
    if (ifNode.elseBody) {
      lifted.elseBody = liftTailVerdicts(ifNode.elseBody);
    }
    out[lastIdx] = lifted;
  }
  return out;
}

/** Does this statement list return a verdict on every path? A local walk, not a
 *  reuse: the typechecker's definite-return pass (`checkDefiniteReturns`,
 *  lib/typeChecker/definiteReturns.ts) needs scopes and a checker context and
 *  cannot run on a bare statement list at parse time. Mirrors the structure of
 *  `alwaysYields` (lib/lowering/patternLowering.ts:781) — keep the two aligned
 *  so they cannot drift — but keyed on `returnStatement`. Only a return and a
 *  both-branch if/else count, the same shapes lifting produces. Loops never
 *  count (syntactic all-paths rule). */
function definitelyReturns(body: AgencyNode[]): boolean {
  for (const stmt of body) {
    if (stmt.type === "returnStatement") {
      return true;
    }
    if (stmt.type === "ifElse") {
      const ifNode = stmt as IfElse;
      if (
        ifNode.elseBody &&
        definitelyReturns(ifNode.thenBody) &&
        definitelyReturns(ifNode.elseBody)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** After lifting, guarantee the clause returns a verdict on every path. A clause
 *  that produces no verdict means pass — the canonical handler default — so an
 *  unfinished clause gets `return pass()` appended. Without this, a
 *  side-effect-only or else-less conditional clause would trip the
 *  all-paths-return LoweringError (lib/lowering/patternLowering.ts:703) on the
 *  generated `match` the author never wrote. */
export function completeClause(body: AgencyNode[]): AgencyNode[] {
  if (definitelyReturns(body)) {
    return body;
  }
  return [...body, returnPass()];
}

// A private copy of `strLit` — the first lives at
// lib/preprocessors/parallelDesugar.ts:334. If a third consumer appears, extract
// a shared node-constructors helper.
const strLit = (value: string): StringLiteral => ({
  type: "string",
  segments: [{ type: "text", value }],
});

const varName = (value: string): VariableNameLiteral => ({ type: "variableName", value });

/** `intr.<prop>` as a value-access node. */
const intrMember = (prop: string): ValueAccess => ({
  type: "valueAccess",
  base: varName("intr"),
  chain: [{ kind: "property", name: prop }],
});

const intrParam: FunctionParameter = { type: "functionParameter", name: "intr" };

function returnPass(): AgencyNode {
  return {
    type: "returnStatement",
    value: { type: "functionCall", functionName: "pass", arguments: [] } as Expression,
  } as AgencyNode;
}

/** One `on` clause → one match arm. A bound clause prepends
 *  `const <binding> = intr.data`; then the body is lifted and completed. A
 *  multi-statement arm gets `blockBody: true` — the field the parser sets on an
 *  author-written block arm — so the built tree is identical to the parsed
 *  canonical one and the formatter prints the arm as a block. */
export function buildClauseArm(clause: ParsedOnClause): MatchBlockCase {
  const prelude: AgencyNode[] =
    clause.binding !== null
      ? [
          {
            type: "assignment",
            declKind: "const",
            variableName: clause.binding,
            value: intrMember("data"),
          } as Assignment,
        ]
      : [];
  const body = completeClause(liftTailVerdicts([...prelude, ...clause.body]));
  const arm: MatchBlockCase = {
    type: "matchBlockCase",
    caseValue: clause.effect === null ? "_" : strLit(clause.effect),
    body,
  };
  if (body.length > 1) {
    arm.blockBody = true;
  }
  return arm;
}

/** Build the canonical inline handler `(intr) { return match (intr.effect) {
 *  ... } }` from a list of parsed clauses. If no clause is the `on _` catch-all,
 *  a `_ => pass()` arm is appended so unmatched effects fall through to the safe
 *  default. */
export function buildOnClauseHandler(clauses: ParsedOnClause[]): HandleBlock["handler"] {
  const cases: MatchBlockCase[] = clauses.map(buildClauseArm);
  const hasCatchAll = clauses.some((clause) => clause.effect === null);
  if (!hasCatchAll) {
    cases.push({ type: "matchBlockCase", caseValue: "_", body: [returnPass()] });
  }
  const match: MatchBlock = {
    type: "matchBlock",
    expression: intrMember("effect"),
    cases,
  };
  return {
    kind: "inline",
    param: intrParam,
    body: [{ type: "returnStatement", value: match } as AgencyNode],
  };
}
