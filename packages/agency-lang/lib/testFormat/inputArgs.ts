/**
 * Converts a `.test.json` case's `input` string — an Agency argument-
 * expression list like `10, 5` or `"alice", "coffee"` — into the named-args
 * record `run()` takes. Parsing uses the language parser (never eval or
 * string splitting); binding decisions belong to the runtime's shared
 * `planArgumentBindings`, so this adapter cannot drift from real calls.
 */
import { parseAgency } from "@/parser.js";
import { walkNodesArray } from "@/utils/node.js";
import type { FunctionCall } from "@/types/function.js";
import {
  ArgumentBindingPlan,
  BindingParameter,
  planArgumentBindings,
} from "@/runtime/agencyFunction.js";

export type { BindingParameter } from "@/runtime/agencyFunction.js";

const PROBE_NAME = "__inputArgsProbe";

/** Parse the raw input string into positional JS values. Only literals that
 *  are JSON-representable are allowed: strings without interpolation,
 *  numbers, booleans, null, and arrays/objects of those. Anything else is
 *  refused naming the argument index and the AST node kind. */
export function parseInputValues(input: string): unknown[] {
  if (input.trim() === "") return [];
  const source = `def __inputArgsWrapper() {\n  ${PROBE_NAME}(${input})\n}\n`;
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) {
    throw new Error(
      `input ${JSON.stringify(input)} does not parse as an Agency argument list: ${parsed.message ?? "parse error"}`,
    );
  }
  const call = [...walkNodesArray(parsed.result.nodes)]
    .map((visit) => visit.node)
    .find(
      (node): node is FunctionCall =>
        (node as { type?: string }).type === "functionCall" &&
        (node as FunctionCall).functionName === PROBE_NAME,
    );
  if (call === undefined) {
    throw new Error(`input ${JSON.stringify(input)} does not parse as an Agency argument list`);
  }
  return call.arguments.map((arg, i) => literalToValue(arg, i));
}

export function renderNamedArguments(plan: ArgumentBindingPlan): Record<string, unknown> {
  if (plan.missingRequiredParameterIndexes.length > 0 || plan.extraValueIndexes.length > 0) {
    const required = plan.parameters.filter((p) => !p.hasDefault && !p.variadic).length;
    const fixed = plan.parameters.filter((p) => !p.variadic).length;
    const variadic = plan.parameters.some((p) => p.variadic);
    const accepted = variadic
      ? `${required}+`
      : required === fixed
        ? `${required}`
        : `${required}-${fixed}`;
    throw new Error(
      `expected ${accepted} argument(s) (${plan.parameters.map((p) => p.name).join(", ") || "none"}), got ${plan.values.length}`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const slot of plan.slots) {
    const param = plan.parameters[slot.parameterIndex];
    if (slot.kind === "supplied") {
      out[param.name] = plan.values[slot.valueIndex];
    } else if (slot.kind === "variadic") {
      out[param.name] = slot.valueIndexes.map((i) => plan.values[i]);
    }
    // default slots stay ABSENT so the runtime default applies.
  }
  return out;
}

export function bindInputArgs(
  input: string,
  parameters: BindingParameter[],
): Record<string, unknown> {
  const values = parseInputValues(input);
  return renderNamedArguments(planArgumentBindings(parameters, values));
}

// ---------------------------------------------------------------------------

type AstNode = { type?: string };

function literalToValue(node: unknown, argIndex: number): unknown {
  const typed = node as AstNode;
  switch (typed.type) {
    case "number":
      return Number((node as { value: string }).value);
    case "boolean":
      return (node as { value: boolean }).value;
    case "null":
      return null;
    case "string":
    case "multiLineString": {
      const segments = (node as { segments: { type: string; value?: string }[] }).segments;
      const interpolated = segments.find((s) => s.type !== "text");
      if (interpolated !== undefined) {
        throw refusal(argIndex, "interpolation");
      }
      return segments.map((s) => s.value ?? "").join("");
    }
    case "agencyArray": {
      const items = (node as { items: unknown[] }).items;
      return items.map((item, i) => {
        if ((item as AstNode).type === "splat") throw refusal(argIndex, "splat");
        return literalToValue(item, argIndex);
      });
    }
    case "agencyObject": {
      const entries = (node as { entries: unknown[] }).entries;
      const out: Record<string, unknown> = {};
      for (const entry of entries) {
        const kv = entry as { key?: string; computedKey?: unknown; value?: unknown; type?: string };
        if (kv.type === "splat" || kv.computedKey !== undefined || kv.key === undefined) {
          throw refusal(argIndex, kv.type ?? "computed key");
        }
        out[kv.key] = literalToValue(kv.value, argIndex);
      }
      return out;
    }
    case "variableName": {
      // The expression grammar parses a bare `null` as a variable name
      // rather than a NullLiteral; it is still the JSON null literal here.
      if ((node as { value: string }).value === "null") return null;
      throw refusal(argIndex, "variableName");
    }
    default:
      throw refusal(argIndex, typed.type ?? "unknown expression");
  }
}

function refusal(argIndex: number, kind: string): Error {
  return new Error(
    `input argument ${argIndex + 1} is not a plain literal (${kind}); ` +
      "only strings, numbers, booleans, null, arrays, and objects of those are allowed",
  );
}
