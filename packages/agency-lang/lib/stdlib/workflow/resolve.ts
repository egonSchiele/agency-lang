/**
 * Stage 2 of the workflow generator, in the preprocessor's role: a parsed
 * `Workflow`, the host's tools, and their signatures become a
 * `ResolvedWorkflow` in which every step carries what lowering needs. Every
 * semantic problem is found here: a tool the host did not pass, a reference
 * that points forward or at nothing, and two generated names that coincide.
 */
import { inputNames } from "./typeText.js";
import {
  isRef,
  refsIn,
  type Binding,
  type ImportGroup,
  type LlmStep,
  type Problem,
  type ResolvedRef,
  type ResolvedStep,
  type ResolvedValue,
  type ResolvedWorkflow,
  type Signature,
  type Step,
  type ToolRef,
  type ToolStep,
  type Workflow,
} from "./types.js";

export type ResolveResult =
  { resolved: ResolvedWorkflow; problems: [] } | { resolved: null; problems: Problem[] };

type Context = { workflow: Workflow; refs: ToolRef[]; signatures: Record<string, Signature> };
type Rule = (context: Context) => Problem[];

/** Names the scaffold and the statement shapes use. A tool with one of these
 *  names would shadow it, so it is refused. */
const PROGRAM_NAMES = [
  "inputs",
  "Inputs",
  "Json",
  "main",
  "inputsSchema",
  "success",
  "failure",
  "llm",
  "schema",
  "JSON",
];

/** Types that tell the typechecker nothing about a value. */
const UNTYPED = [null, "any", "Json"];

/** `Result<Json>` and `Result<Json, string>` give `Json` as the value's type. */
const RESULT_OF = /^Result<\s*([^,<>]+?)\s*(?:,[^>]*)?>$/;

/** The type a reference into the step reads: the declared type, or the
 *  value type inside a `Result`, since the reference goes through `.value`.
 *  A bare `Result` says nothing about its value. */
function valueType(returnType: string | null): string | null {
  if (returnType === "Result") {
    return "any";
  }
  const inner = returnType === null ? null : RESULT_OF.exec(returnType);
  return inner === null ? returnType : inner[1];
}

function untypedReason(returnType: string | null): string {
  return returnType === null ? "declares no return type" : `returns ${returnType}`;
}

/** Every name a step declares. The prefix is what makes any identifier safe
 *  as a step id: a step named `failure` declares `step_failure`. */
export function names(id: string) {
  return {
    value: `step_${id}`,
    arg: (name: string) => `step_${id}_${name}`,
    context: (index: number) => `step_${id}_context${index + 1}`,
    contextText: (index: number) => `step_${id}_context${index + 1}_text`,
    typeName: `Step_${id}_output`,
  };
}

export function signatureKey(module: string, name: string): string {
  return `${module}.${name}`;
}

function toolSteps(workflow: Workflow): ToolStep[] {
  return workflow.steps.filter((step): step is ToolStep => step.kind === "tool");
}

function sortedArgs(step: ToolStep): string[] {
  return Object.keys(step.args).sort();
}

const REF_PARTS = /^(inputs|steps)\.([A-Za-z_][A-Za-z0-9_]*)(.*)$/;

function resolveRef(path: string): ResolvedRef {
  const [, root, name, rest] = REF_PARTS.exec(path)!;
  return root === "inputs"
    ? { kind: "input", name, path: rest }
    : { kind: "step", step: name, path: rest };
}

/** A reference becomes a `ResolvedRef`; a value with no reference inside is
 *  a literal, so a literal object is never read as a reference. */
function resolveValue(value: unknown): ResolvedValue {
  if (isRef(value)) {
    return resolveRef(value.$ref);
  }
  if (refsIn(value).length === 0) {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return { kind: "list", items: value.map(resolveValue) };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return {
    kind: "record",
    entries: entries.map(([key, item]) => ({ key, value: resolveValue(item) })),
  };
}

const toolRule: Rule = ({ workflow, refs, signatures }) =>
  toolSteps(workflow).flatMap((step) => {
    if (!refs.some((ref) => ref.module === step.module && ref.name === step.tool)) {
      const message = `tool "${step.tool}" from "${step.module}" is not among the tools passed to this workflow`;
      return [{ step: step.id, field: "tool", message }];
    }
    if (PROGRAM_NAMES.includes(step.tool)) {
      return [
        {
          step: step.id,
          field: "tool",
          message: `tool name "${step.tool}" is a name the generated program uses`,
        },
      ];
    }
    if (signatures[signatureKey(step.module, step.tool)] === undefined) {
      return [
        {
          step: step.id,
          field: "tool",
          message: `no signature for "${step.module}"."${step.tool}"`,
        },
      ];
    }
    return [];
  });

/** The problem with one reference made at step `position` (the number of
 *  steps for `result`), or null when it names something earlier. */
function refMessage(path: string, position: number, context: Context): string | null {
  const ref = resolveRef(path);
  if (ref.kind === "input") {
    return inputNames(context.workflow.inputs).includes(ref.name)
      ? null
      : `reference "${path}" names no declared input`;
  }
  const target = context.workflow.steps.findIndex((step) => step.id === ref.step);
  if (target === -1) {
    return `reference "${path}" names no step`;
  }
  if (target === position) {
    return `reference "${path}" names step "${ref.step}", which is this step`;
  }
  return target > position
    ? `reference "${path}" names step "${ref.step}", which comes after this step`
    : null;
}

function refProblems(
  context: Context,
  step: string | null,
  field: string,
  value: unknown,
  position: number,
) {
  return refsIn(value).flatMap((ref): Problem[] => {
    const message = refMessage(ref.$ref, position, context);
    return message === null ? [] : [{ step, field, message }];
  });
}

function stepFields(step: Step): [string, unknown][] {
  if (step.kind === "tool") {
    return sortedArgs(step).map((name) => [`args.${name}`, step.args[name]]);
  }
  return step.context.map((value, index) => [`context[${index}]`, value]);
}

const referenceRule: Rule = (context) => {
  const steps = context.workflow.steps;
  const inSteps = steps.flatMap((step, position) =>
    stepFields(step).flatMap(([field, value]) =>
      refProblems(context, step.id, field, value, position),
    ),
  );
  const inResult = refProblems(context, null, "result", context.workflow.result, steps.length);
  return [...inSteps, ...inResult];
};

/** One name the generated program declares, and where it came from. */
type Declared = { name: string; step: string | null; field: string; what: string };

function declaredBy(step: Step): Declared[] {
  const stepNames = names(step.id);
  const value = { name: stepNames.value, step: step.id, field: "id", what: `step id "${step.id}"` };
  if (step.kind === "tool") {
    const args = sortedArgs(step).map((arg) => ({
      name: stepNames.arg(arg),
      step: step.id,
      field: `args.${arg}`,
      what: `argument "${arg}" of step "${step.id}"`,
    }));
    return [value, ...args];
  }
  const contexts = step.context.flatMap((_, index) => [
    {
      name: stepNames.context(index),
      step: step.id,
      field: `context[${index}]`,
      what: `context value ${index + 1} of step "${step.id}"`,
    },
    {
      name: stepNames.contextText(index),
      step: step.id,
      field: `context[${index}]`,
      what: `the text of context value ${index + 1} of step "${step.id}"`,
    },
  ]);
  const typeName = {
    name: stepNames.typeName,
    step: step.id,
    field: "output",
    what: `the output type of step "${step.id}"`,
  };
  return [value, ...contexts, typeName];
}

/** Every generated name differs from every other and from every imported
 *  tool. That is also what keeps template hygiene from renaming anything. */
const collisionRule: Rule = ({ workflow }) => {
  const tools = toolSteps(workflow).map((step) => ({
    name: step.tool,
    step: null,
    field: "tool",
    what: `tool "${step.tool}"`,
  }));
  const declared = [...tools, ...workflow.steps.flatMap(declaredBy)];
  return declared.flatMap((entry, index): Problem[] => {
    const earlier = declared
      .slice(0, index)
      .find((other) => other.name === entry.name && other.what !== entry.what);
    if (earlier === undefined || entry.step === null) {
      return [];
    }
    return [
      {
        step: entry.step,
        field: entry.field,
        message: `${entry.what} produces the same local as ${earlier.what}`,
      },
    ];
  });
};

const RULES: Rule[] = [toolRule, referenceRule, collisionRule];

function untypedWarnings({ workflow, signatures }: Context): Problem[] {
  return toolSteps(workflow).flatMap((step) => {
    const returnType = signatures[signatureKey(step.module, step.tool)].returnType;
    if (!UNTYPED.includes(valueType(returnType))) {
      return [];
    }
    const message = `step "${step.id}": "${step.tool}" ${untypedReason(returnType)}, so references into its value are checked at run time`;
    return [{ step: step.id, field: "tool", message }];
  });
}

function binding(local: string, field: string, value: unknown): Binding {
  return { local, field, value: resolveValue(value) };
}

function resolveToolStep(step: ToolStep, signatures: Record<string, Signature>): ResolvedStep {
  const stepNames = names(step.id);
  const argOrder = sortedArgs(step);
  return {
    id: step.id,
    kind: "tool",
    value: stepNames.value,
    module: step.module,
    tool: step.tool,
    returnsResult: signatures[signatureKey(step.module, step.tool)].returnsResult,
    bindings: argOrder.map((arg) => binding(stepNames.arg(arg), `args.${arg}`, step.args[arg])),
    argOrder,
  };
}

function resolveLlmStep(step: LlmStep): ResolvedStep {
  const stepNames = names(step.id);
  return {
    id: step.id,
    kind: "llm",
    value: stepNames.value,
    prompt: step.prompt,
    outputType: step.output,
    typeName: stepNames.typeName,
    bindings: step.context.map((value, index) => ({
      ...binding(stepNames.context(index), `context[${index}]`, value),
      text: stepNames.contextText(index),
    })),
    model: step.model ?? null,
    provider: step.provider ?? null,
  };
}

function importGroups(workflow: Workflow): ImportGroup[] {
  const steps = toolSteps(workflow);
  const modules = steps
    .map((step) => step.module)
    .filter((module, index, all) => all.indexOf(module) === index);
  return modules.sort().map((module) => {
    const used = steps.filter((step) => step.module === module).map((step) => step.tool);
    return { module, names: used.filter((name, index) => used.indexOf(name) === index).sort() };
  });
}

export function resolveWorkflow(
  workflow: Workflow,
  refs: ToolRef[],
  signatures: Record<string, Signature>,
): ResolveResult {
  const context = { workflow, refs, signatures };
  const problems = RULES.flatMap((rule) => rule(context));
  if (problems.length > 0) {
    return { resolved: null, problems };
  }
  const steps = workflow.steps.map((step) =>
    step.kind === "tool" ? resolveToolStep(step, signatures) : resolveLlmStep(step),
  );
  const resolved: ResolvedWorkflow = {
    name: workflow.name,
    inputsType: workflow.inputs,
    imports: importGroups(workflow),
    steps,
    result: workflow.result == null ? null : resolveValue(workflow.result),
    limits: workflow.limits ?? null,
    warnings: untypedWarnings(context),
  };
  return { resolved, problems: [] };
}
