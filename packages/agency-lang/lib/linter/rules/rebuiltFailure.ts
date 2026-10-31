import type { SourceLocation } from "../../types/base.js";
import type { LintContext, LintFinding, LintRule } from "../types.js";
import { lintDiagnostic } from "../diagnostics.js";
import { buildLineIndex, locFromOffsets, statementSpan, walkValues } from "./util.js";

type Node = Record<string, unknown>;

/** The failure a `failure(why)` call rebuilds, when the call sits inside
 *  `if (x is failure(why)) { ... }` and `why` is that failure's message.
 *  Every field of the original is lost in the rebuild. The one the tool
 *  loop reads is `rejected`: without it a rejected interrupt reaches the
 *  model as a tool error it may retry (docs/dev/agents/tool-loop-guards.md). */
type Rebuild = { result: string; message: string; call: Node };

/** The parser lowers `x is failure(why)` to `isFailure(x)` with
 *  `const why = x.error` as the first statement of the branch. */
function failureCheckedVariable(condition: unknown): string | null {
  const cond = condition as Node | undefined;
  if (cond?.type !== "functionCall" || cond.functionName !== "isFailure") {
    return null;
  }
  const args = cond.arguments as Node[] | undefined;
  const only = args?.length === 1 ? args[0] : undefined;
  return only?.type === "variableName" ? (only.value as string) : null;
}

function readsErrorOf(value: unknown, result: string): boolean {
  const access = value as Node | undefined;
  if (access?.type !== "valueAccess") {
    return false;
  }
  const base = access.base as Node | undefined;
  const chain = access.chain as Node[] | undefined;
  return (
    base?.type === "variableName" &&
    base.value === result &&
    chain?.length === 1 &&
    chain[0].kind === "property" &&
    chain[0].name === "error"
  );
}

/** The names the branch binds to the failure's message. */
function messageNamesIn(body: Node[], result: string): string[] {
  return body
    .filter((stmt) => stmt.type === "assignment" && readsErrorOf(stmt.value, result))
    .map((stmt) => stmt.variableName as string);
}

/** A one-argument `failure(...)` whose argument is the message of `result`,
 *  by a bound name or as `result.error` directly. */
function rebuildOf(value: unknown, result: string, messageNames: string[]): Rebuild | null {
  const call = value as Node | undefined;
  if (call?.type !== "functionCall" || call.functionName !== "failure") {
    return null;
  }
  const args = call.arguments as Node[] | undefined;
  const only = args?.length === 1 ? args[0] : undefined;
  if (only?.type === "variableName" && messageNames.includes(only.value as string)) {
    return { result, message: only.value as string, call };
  }
  if (readsErrorOf(only, result)) {
    return { result, message: `${result}.error`, call };
  }
  return null;
}

function rebuildsIn(branch: Node): Rebuild[] {
  const result = failureCheckedVariable(branch.condition);
  const body = branch.thenBody as Node[] | undefined;
  if (result === null || body === undefined) {
    return [];
  }
  const messageNames = messageNamesIn(body, result);
  const found: Rebuild[] = [];
  walkValues(body, (node) => {
    if (node.type === "returnStatement") {
      const rebuild = rebuildOf(node.value, result, messageNames);
      if (rebuild !== null) {
        found.push(rebuild);
      }
    }
  });
  return found;
}

export const rebuiltFailureRule: LintRule = {
  name: "rebuiltFailure",
  run(ctx: LintContext): LintFinding[] {
    const lineIndex = buildLineIndex(ctx.source);
    const rebuilds: Rebuild[] = [];
    walkValues(ctx.program.nodes, (node) => {
      if (node.type === "ifElse") {
        rebuilds.push(...rebuildsIn(node));
      }
    });
    return rebuilds.map(({ result, message, call }) => {
      const { start, end } = statementSpan(ctx.source, call as { loc?: SourceLocation });
      const range = locFromOffsets(ctx.source, start, end, lineIndex);
      const fix = {
        title: `Return '${result}' itself`,
        edits: [{ start, end, newText: result }],
      };
      return lintDiagnostic("rebuiltFailure", { result, message }, range, fix);
    });
  },
};
