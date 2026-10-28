/**
 * Stage 3 of the workflow generator: a `ResolvedWorkflow` becomes template
 * fragments, each knowing the step and field it belongs to. Every statement
 * comes from a shape in `shapes.ts`. The only text composed here is a
 * reference (a generated name, `.value`, and a path the format's grammar
 * accepted) and an import line (checked names and a checked module path).
 */
import { _parseExpr, type Code } from "../template.js";
import { expression, list, literal, record, statement } from "./shapes.js";
import { MODULE_PATH } from "./tools.js";
import {
  isIdentifier,
  type Binding,
  type Fragment,
  type ImportGroup,
  type Lowered,
  type ResolvedLlmStep,
  type ResolvedRef,
  type ResolvedStep,
  type ResolvedToolStep,
  type ResolvedValue,
  type ResolvedWorkflow,
  type TypeDecl,
} from "./types.js";

/** What follows a root name in a reference: `.field` and `[n]` segments.
 *  Parse already matched it; this is checked again where it is written. */
const REF_TAIL = /^(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/;

type StepsById = Record<string, ResolvedStep>;

function importLine({ module, names }: ImportGroup): string {
  if (!MODULE_PATH.test(module) || !names.every(isIdentifier)) {
    throw new Error(`cannot write an import from "${module}"`);
  }
  return `import { ${names.join(", ")} } from "${module}"`;
}

/** `inputs.<name><path>`, or a step's local, `.value` when it holds a
 *  `Result`, and the path. */
function reference(ref: ResolvedRef, steps: StepsById): Code {
  if (!REF_TAIL.test(ref.path)) {
    throw new Error(`cannot write the reference path "${ref.path}"`);
  }
  if (ref.kind === "input") {
    return _parseExpr(`inputs.${ref.name}${ref.path}`);
  }
  const target = steps[ref.step];
  if (!isIdentifier(target.value)) {
    throw new Error(`cannot write the step local "${target.value}"`);
  }
  const unwrap = target.kind === "tool" && target.returnsResult ? ".value" : "";
  return _parseExpr(`${target.value}${unwrap}${ref.path}`);
}

function valueCode(value: ResolvedValue, steps: StepsById): Code {
  switch (value.kind) {
    case "literal":
      return literal(value.value);
    case "list":
      return list(value.items.map((item) => valueCode(item, steps)));
    case "record":
      return record(
        value.entries.map(({ key, value: entry }) => ({ key, value: valueCode(entry, steps) })),
      );
    default:
      return reference(value, steps);
  }
}

function refLabel(value: ResolvedValue): string {
  if (value.kind === "input") {
    return ` (inputs.${value.name}${value.path})`;
  }
  return value.kind === "step" ? ` (steps.${value.step}${value.path})` : "";
}

function bindingFragment(step: ResolvedStep, binding: Binding, steps: StepsById): Fragment {
  return {
    code: statement(
      "binding",
      { local: binding.local },
      { value: valueCode(binding.value, steps) },
    ),
    owner: { step: step.id, field: binding.field },
  };
}

function toolFragments(step: ResolvedToolStep, steps: StepsById): Fragment[] {
  const owner = { step: step.id, field: "args" };
  const args = step.argOrder
    .map((arg, index) => `${arg}: ${step.bindings[index].local}`)
    .join(", ");
  const call = statement("call", { value: step.value, tool: step.tool, args }, {});
  const checkShape = step.returnsResult ? "check" : "checkPlain";
  const checkNames = { value: step.value, id: step.id, tool: step.tool };
  const check = statement(checkShape, checkNames, { id: literal(step.id) });
  return [
    ...step.bindings.map((binding) => bindingFragment(step, binding, steps)),
    { code: call, owner },
    { code: check, owner },
  ];
}

/** The prompt text, then for each context value a label and its JSON, joined with `+`. */
function promptCode(step: ResolvedLlmStep): Code {
  const contexts = step.bindings.flatMap((binding, index) => [
    literal(`\n\nContext ${index + 1}${refLabel(binding.value)}:\n`),
    expression("stringify", {}, { v: expression("local", { name: binding.local }, {}) }),
  ]);
  return [literal(step.prompt), ...contexts].reduce((left, right) =>
    expression("concat", {}, { left, right }),
  );
}

function llmFragments(step: ResolvedLlmStep, steps: StepsById): Fragment[] {
  const options = [
    step.model === null ? "" : ", model: #model",
    step.provider === null ? "" : ", provider: #provider",
  ];
  const values: Record<string, Code> = { prompt: promptCode(step) };
  if (step.model !== null) {
    values.model = literal(step.model);
  }
  if (step.provider !== null) {
    values.provider = literal(step.provider);
  }
  const names = { value: step.value, outputType: step.typeName, options: options.join("") };
  return [
    ...step.bindings.map((binding) => bindingFragment(step, binding, steps)),
    { code: statement("llm", names, values), owner: { step: step.id, field: "prompt" } },
  ];
}

function typeDecls(resolved: ResolvedWorkflow): TypeDecl[] {
  const outputs = resolved.steps.flatMap((step) =>
    step.kind === "llm"
      ? [{ name: step.typeName, text: step.outputType, owner: { step: step.id, field: "output" } }]
      : [],
  );
  return [
    { name: "Inputs", text: resolved.inputsType, owner: { step: null, field: "inputs" } },
    ...outputs,
  ];
}

export function lowerWorkflow(resolved: ResolvedWorkflow): Lowered {
  const steps: StepsById = Object.fromEntries(resolved.steps.map((step) => [step.id, step]));
  const body = resolved.steps.flatMap((step) =>
    step.kind === "tool" ? toolFragments(step, steps) : llmFragments(step, steps),
  );
  const last = resolved.steps[resolved.steps.length - 1];
  const result = resolved.result ?? { kind: "step", step: last.id, path: "" };
  return {
    imports: resolved.imports.map(importLine),
    types: typeDecls(resolved),
    body,
    result: valueCode(result, steps),
    guard: resolved.limits,
  };
}
