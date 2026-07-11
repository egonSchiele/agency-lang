/**
 * Tool-position binding validator.
 *
 * Implements the primary (compile-time) layer of the function-typed-tool-
 * parameter check described in `docs/superpowers/specs/2026-06-03-tool-params-blocks-and-variadics-design.md`
 * §4.2(e). Every classification routes through a named helper so there is
 * exactly one definition of each rule:
 *
 *   - `isFunctionTyped` (lib/typeChecker/utils.ts)  — shared with the
 *     schema generator (lib/backends/typescriptBuilder.ts) and the runtime
 *     backstop (lib/runtime/agencyFunction.ts :: validateForLLM).
 *   - `isBound`, `classifyToolParam`, `resolveStaticTools`, `paramsOfTool`
 *     — defined here; consumed only by this validator.
 *   - registry entries toolRequiredParamUnbound[Typed] / toolOptionalParamsDropped
 *     (lib/runtime/toolBlockDiagnostics.ts) — shared with the runtime so
 *     compile-time and runtime error wording cannot drift.
 *
 * The validator walks every `llm(...)` call, finds its statically-known
 * tool expressions, classifies each function-typed parameter, and emits
 * the right diagnostics. Dynamically-assembled tool arrays (spreads,
 * identifiers) are intentionally skipped here — the runtime backstop
 * (`AgencyFunction.validateForLLM`) covers them at request time.
 */
import { diagnostic } from "./diagnostics.js";
import {
  AgencyNode,
  AgencyProgram,
  FunctionParameter,
  ValueAccess,
} from "../types.js";
import { walkNodes } from "../utils/node.js";
import { formatTypeHint } from "../utils/formatType.js";
import { isFunctionTyped } from "./utils.js";
import type { TypeCheckerContext } from "./types.js";

/** Per-parameter outcome from a single tool expression. Total: every param
 *  contributes exactly one classification. */
type ParamClassification =
  | { kind: "ok"; param: FunctionParameter }
  | { kind: "required-unbound"; param: FunctionParameter }
  | { kind: "optional-unbound"; param: FunctionParameter };

/**
 * True if `paramName` is statically observable as bound on `toolExpr`.
 *
 * Walks the method-call chain on a `valueAccess` looking for
 * `.partial(<name>: ...)` calls. Other chain methods (`.describe`,
 * `.preapprove`) pass through transparently — they don't bind or unbind
 * parameters.
 *
 * Conservative: returns false when the chain is too dynamic to inspect
 * (e.g. computed indices). The runtime backstop covers what we can't see.
 */
function isBound(toolExpr: AgencyNode, paramName: string): boolean {
  if (toolExpr.type !== "valueAccess") return false;
  for (const element of toolExpr.chain) {
    if (element.kind !== "methodCall") continue;
    if (element.functionCall.functionName !== "partial") continue;
    for (const arg of element.functionCall.arguments) {
      if (arg.type === "namedArgument" && arg.name === paramName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolve a `tools:` option value to the list of statically-known tool
 * expressions. Returns `[]` for shapes the validator cannot inspect
 * (spread elements, bare identifiers, non-array expressions); the runtime
 * backstop handles those cases at LLM-request time.
 */
function resolveStaticTools(opt: AgencyNode | undefined): AgencyNode[] {
  if (!opt) return [];
  if (opt.type !== "agencyArray") return [];
  // If the array contains *any* spread, defer the whole thing to the
  // runtime backstop. We can't see what the spread expands to, so
  // emitting diagnostics for the visible elements alone would force
  // users into awkward patterns ("validate must be either always
  // present or always absent depending on whether you spread"). The
  // spec (§5.2 #22) pins this behavior.
  if (opt.items.some((item) => item.type === "splat")) return [];
  return opt.items as AgencyNode[];
}

/** Extract the bare function name from a tool expression. Returns
 *  undefined for shapes the validator cannot resolve. */
function toolBaseName(toolExpr: AgencyNode): string | undefined {
  if (toolExpr.type === "variableName") return toolExpr.value;
  if (toolExpr.type === "valueAccess" && toolExpr.base.type === "variableName") {
    return toolExpr.base.value;
  }
  return undefined;
}

/**
 * Resolve a tool expression to its declared parameter list. Looks in
 * `ctx.functionDefs` first (local definitions), then
 * `ctx.importedFunctions` (cross-module). Returns undefined when the
 * callable can't be resolved — happens for tools defined dynamically or
 * imported via JS, and is the validator's signal to skip.
 */
function paramsOfTool(
  toolExpr: AgencyNode,
  ctx: TypeCheckerContext,
): FunctionParameter[] | undefined {
  const name = toolBaseName(toolExpr);
  if (!name) return undefined;
  const def = ctx.functionDefs[name];
  if (def) return def.parameters;
  const imported = ctx.importedFunctions[name];
  if (imported) return imported.parameters;
  return undefined;
}

/** Per-param classifier — required vs optional vs already-bound. */
function classifyToolParam(
  param: FunctionParameter,
  toolExpr: AgencyNode,
): ParamClassification {
  if (isBound(toolExpr, param.name)) return { kind: "ok", param };
  // "Optional" === has a default value (the function body can run without
  // an LLM-supplied value). A variadic without an explicit default is
  // still required for the purposes of this check: if the function's body
  // calls into the variadic-of-functions, it expects callables. The spec
  // (§2 "Variadic whose element type is a function type") makes this
  // explicit.
  if (param.defaultValue !== undefined) {
    return { kind: "optional-unbound", param };
  }
  return { kind: "required-unbound", param };
}

/** Locate the `tools:` value inside an `llm(...)` call's options object. */
function findToolsOption(llmCall: AgencyNode): AgencyNode | undefined {
  if (llmCall.type !== "functionCall") return undefined;
  if (llmCall.functionName !== "llm") return undefined;
  const optsArg = llmCall.arguments[1];
  if (!optsArg) return undefined;
  // Options arg may itself be an unwrapped expression (positional) or a
  // namedArgument (rare). For llm(prompt, { tools: [...] }) it's the
  // agencyObject literal at arguments[1].
  const inner = optsArg.type === "namedArgument" ? optsArg.value : optsArg;
  if (inner.type !== "agencyObject") return undefined;
  for (const entry of inner.entries) {
    if ("type" in entry) continue; // splat: dynamic, skip
    if (entry.computedKey) continue;
    if (entry.key === "tools") return entry.value as AgencyNode;
  }
  return undefined;
}

/** Walk the program, emit diagnostics for each llm() call's tools array. */
export function checkToolBlockBindings(
  program: AgencyProgram,
  ctx: TypeCheckerContext,
): void {
  for (const { node: llmCall } of walkNodes(program.nodes)) {
    if (llmCall.type !== "functionCall" || llmCall.functionName !== "llm") {
      continue;
    }
    const toolsOpt = findToolsOption(llmCall);
    for (const toolExpr of resolveStaticTools(toolsOpt)) {
      const params = paramsOfTool(toolExpr, ctx) ?? [];
      const classifications = params
        .filter(isFunctionTyped)
        .map((p) => classifyToolParam(p, toolExpr));
      emitDiagnostics(llmCall, toolExpr, classifications, ctx);
    }
  }
}

/**
 * Sole emit site for the compile-time tool-binding diagnostics. Wording now
 * lives in the diagnostic registry (toolRequiredParamUnbound[Typed] /
 * toolOptionalParamsDropped); the runtime backstop keeps its own formatters
 * (lib/runtime/toolBlockDiagnostics.ts). Two locks keep the wording from
 * drifting: the unified-wording test (#42, asserts the rendered error
 * contains formatUnboundClause) and the registry-vs-formatter equality test
 * in diagnostics.test.ts.
 */
function emitDiagnostics(
  llmCall: AgencyNode,
  toolExpr: AgencyNode,
  classifications: ParamClassification[],
  ctx: TypeCheckerContext,
): void {
  const toolName = toolBaseName(toolExpr) ?? "<tool>";
  const optionalDropped: string[] = [];
  for (const cls of classifications) {
    if (cls.kind === "required-unbound") {
      const typeStr = cls.param.typeHint
        ? formatTypeHint(cls.param.typeHint)
        : undefined;
      // Two entries (typed/untyped) — conditional phrasing per the registry
      // rule. A cross-check test locks the template text to the runtime's
      // shared formatUnboundClause so the canonical clause cannot drift.
      if (typeStr === undefined) {
        ctx.errors.push(
          diagnostic(
            "toolRequiredParamUnbound",
            { tool: toolName, param: cls.param.name },
            llmCall.loc ?? null,
          ),
        );
      } else {
        ctx.errors.push(
          diagnostic(
            "toolRequiredParamUnboundTyped",
            { tool: toolName, param: cls.param.name, type: typeStr },
            llmCall.loc ?? null,
          ),
        );
      }
    } else if (cls.kind === "optional-unbound") {
      optionalDropped.push(cls.param.name);
    }
  }
  if (optionalDropped.length > 0) {
    ctx.errors.push(
      diagnostic(
        "toolOptionalParamsDropped",
        {
          tool: toolName,
          params: optionalDropped.map((n) => `'${n}'`).join(", "),
        },
        llmCall.loc ?? null,
      ),
    );
  }
}
