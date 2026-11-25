/**
 * Stage 2 of the workflow generator, in the preprocessor's role: a parsed
 * `Workflow`, the host's tools, and their signatures become a
 * `ResolvedWorkflow` in which every step carries what lowering needs. Every
 * semantic problem is found here: a tool the host did not pass, a reference
 * that points forward or at nothing, and two generated names that coincide.
 */
import { expandEffectNames } from "../../runtime/effectSets.js";
import { stepEffects } from "./effects.js";
import { inputNames } from "./typeText.js";
import {
  allSteps,
  isBlockStep,
  isRef,
  refsIn,
  signatureKey,
  stepChildren,
  type BlockStep,
  type Binding,
  type EachStep,
  type ImportGroup,
  type Limits,
  type LlmStep,
  type MatchStep,
  type Problem,
  type ResolvedRef,
  type ResolvedStep,
  type ResolvedValue,
  type ResolvedWorkflow,
  type Signature,
  type Step,
  type ToolRef,
  type ToolStep,
  type ValueStep,
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
  // No generated node is named `inputsSchema` since `workflowSchemas`
  // replaced it. It stays so that no tool list refused before passes now.
  "inputsSchema",
  "workflowSchemas",
  "success",
  "failure",
  "llm",
  "schema",
  "JSON",
  "guard",
  "guardTrip",
  "reject",
  "pass",
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
    reply: `step_${id}_reply`,
    typeName: `Step_${id}_output`,
    on: `step_${id}_on`,
    caseTest: (index: number) => `step_${id}_case${index + 1}`,
    over: `step_${id}_over`,
    item: `step_${id}_item`,
  };
}

export { signatureKey };

/** Every tool step in the tree, in document order. */
function toolSteps(workflow: Workflow): ToolStep[] {
  return allSteps(workflow).filter((step): step is ToolStep => step.kind === "tool");
}

/** "a match step" or "an each step", for messages. */
function blockName(step: BlockStep): string {
  return step.kind === "match" ? "a match step" : "an each step";
}

function sortedArgs(step: ToolStep): string[] {
  return Object.keys(step.args).sort();
}

const REF_PARTS = /^(inputs|steps|each)\.([A-Za-z_][A-Za-z0-9_]*)(.*)$/;

function resolveRef(path: string): ResolvedRef {
  const [, root, name, rest] = REF_PARTS.exec(path)!;
  if (root === "inputs") {
    return { kind: "input", name, path: rest };
  }
  return root === "each"
    ? { kind: "item", loop: name, path: rest }
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

/** What a reference may name at one place in the tree. `visible` holds the
 *  tool and LLM steps it may read, `loops` the enclosing `each` steps, and
 *  `later` the steps after it in its own list or an enclosing one. */
type Scope = { visible: string[]; loops: string[]; later: string[] };

/** The problem with one reference made by step `self` (null for `result`),
 *  or null when the scope allows it. */
function refMessage(
  path: string,
  self: string | null,
  scope: Scope,
  context: Context,
): string | null {
  const ref = resolveRef(path);
  if (ref.kind === "input") {
    return inputNames(context.workflow.inputs).includes(ref.name)
      ? null
      : `reference "${path}" names no declared input`;
  }
  const steps = allSteps(context.workflow);
  if (ref.kind === "item") {
    if (!steps.some((step) => step.id === ref.loop && step.kind === "each")) {
      return `reference "${path}" names no each step`;
    }
    return scope.loops.includes(ref.loop)
      ? null
      : `reference "${path}" names loop "${ref.loop}", which this step is not inside`;
  }
  const target = steps.find((step) => step.id === ref.step);
  if (target === undefined) {
    return `reference "${path}" names no step`;
  }
  if (target.id === self) {
    return `reference "${path}" names step "${ref.step}", which is this step`;
  }
  if (isBlockStep(target)) {
    return `reference "${path}" names step "${ref.step}", ${blockName(target)}, which has no value`;
  }
  if (scope.visible.includes(ref.step)) {
    return null;
  }
  return scope.later.includes(ref.step)
    ? `reference "${path}" names step "${ref.step}", which comes after this step`
    : `reference "${path}" names step "${ref.step}", which is inside a block this step is not in`;
}

function refProblems(
  context: Context,
  step: string | null,
  field: string,
  value: unknown,
  scope: Scope,
) {
  return refsIn(value).flatMap((ref): Problem[] => {
    const message = refMessage(ref.$ref, step, scope, context);
    return message === null ? [] : [{ step, field, message }];
  });
}

/** The fields of a step that may hold references. */
function stepFields(step: Step): [string, unknown][] {
  switch (step.kind) {
    case "tool":
      return sortedArgs(step).map((name) => [`args.${name}`, step.args[name]]);
    case "llm":
      return step.context.map((value, index) => [`context[${index}]`, value]);
    case "match":
      return [["on", step.on]];
    case "each":
      return [["over", step.over]];
  }
}

/** The reference problems in one step list. A step's own fields see the
 *  scope before it; a tool or LLM step becomes visible to the steps after
 *  it in the same list; a block's lists start from the scope at the block,
 *  and nothing they add leaves them. Returns the scope after the list too,
 *  which is what `result` sees. */
function listProblems(
  context: Context,
  list: Step[],
  scope: Scope,
): { problems: Problem[]; visible: string[] } {
  let visible = scope.visible;
  const problems = list.flatMap((step, index): Problem[] => {
    const later = [...list.slice(index + 1).map((other) => other.id), ...scope.later];
    const here = { visible, loops: scope.loops, later };
    const own = stepFields(step).flatMap(([field, value]) =>
      refProblems(context, step.id, field, value, here),
    );
    const loops = step.kind === "each" ? [...scope.loops, step.id] : scope.loops;
    const inner = stepChildren(step).flatMap(
      (child) => listProblems(context, child, { ...here, loops }).problems,
    );
    if (!isBlockStep(step)) {
      visible = [...visible, step.id];
    }
    return [...own, ...inner];
  });
  return { problems, visible };
}

const referenceRule: Rule = (context) => {
  const top = listProblems(context, context.workflow.steps, { visible: [], loops: [], later: [] });
  const afterAll = { visible: top.visible, loops: [], later: [] };
  const inResult = refProblems(context, null, "result", context.workflow.result, afterAll);
  return [...top.problems, ...inResult];
};

/** With no `result`, a workflow returns its last top-level step's value,
 *  and a block has none. */
const resultRule: Rule = ({ workflow }) => {
  const last = workflow.steps[workflow.steps.length - 1];
  if (workflow.result != null || !isBlockStep(last)) {
    return [];
  }
  const message = `the last step, "${last.id}", is ${blockName(last)} and has no value; set result`;
  return [{ step: null, field: "result", message }];
};

/** One name the generated program declares, and where it came from. */
type Declared = { name: string; step: string | null; field: string; what: string };

/** A block declares no value of its own: only the locals its lines read. */
function declaredByBlock(step: BlockStep): Declared[] {
  const stepNames = names(step.id);
  if (step.kind === "each") {
    return [
      { name: stepNames.over, step: step.id, field: "over", what: `the list of loop "${step.id}"` },
      { name: stepNames.item, step: step.id, field: "id", what: `the item of loop "${step.id}"` },
    ];
  }
  const tests = step.cases.map((_, index) => ({
    name: stepNames.caseTest(index),
    step: step.id,
    field: `cases[${index}].is`,
    what: `the test of case ${index + 1} of step "${step.id}"`,
  }));
  const on = {
    name: stepNames.on,
    step: step.id,
    field: "on",
    what: `the value step "${step.id}" tests`,
  };
  return [on, ...tests];
}

function declaredBy(step: Step): Declared[] {
  if (isBlockStep(step)) {
    return declaredByBlock(step);
  }
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
  const reply = {
    name: stepNames.reply,
    step: step.id,
    field: "prompt",
    what: `the reply of step "${step.id}"`,
  };
  const typeName = {
    name: stepNames.typeName,
    step: step.id,
    field: "output",
    what: `the output type of step "${step.id}"`,
  };
  return [value, ...contexts, reply, typeName];
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
  const declared = [...tools, ...allSteps(workflow).flatMap(declaredBy)];
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

/** A workflow's `raises` lists what it may raise; every effect a tool step
 *  raises must be on it. A set name stands for its members, as in an
 *  Agency `raises` clause. No `raises`, or one holding `*`, allows anything.
 *  The problem is on the step's `tool`, the field the author would change. */
const raisesRule: Rule = ({ workflow, signatures }) => {
  const raises = workflow.raises ?? null;
  if (raises === null || raises.includes("*")) {
    return [];
  }
  const allowed = expandEffectNames(raises);
  return stepEffects(workflow, signatures).flatMap(({ step, tool, effects }) =>
    effects
      .filter((effect) => !allowed.includes(effect))
      .map((effect) => ({
        step,
        field: "tool",
        message: `${tool} raises "${effect}", which the workflow's raises does not allow`,
      })),
  );
};

const RULES: Rule[] = [toolRule, referenceRule, resultRule, collisionRule, raisesRule];

/** The ids of the steps some step field, `on`, `over`, or the result references. */
function referencedSteps(workflow: Workflow): string[] {
  const values = [
    ...allSteps(workflow).flatMap((step) => stepFields(step).map(([, value]) => value)),
    workflow.result,
  ];
  return values.flatMap(refsIn).flatMap((ref) => {
    const resolved = resolveRef(ref.$ref);
    return resolved.kind === "step" ? [resolved.step] : [];
  });
}

/** A warning for each tool step whose return type says nothing about its
 *  value, when something references that value. A step nothing references
 *  has nothing to check, so it gets no warning. */
function untypedWarnings({ workflow, signatures }: Context): Problem[] {
  const referenced = referencedSteps(workflow);
  return toolSteps(workflow).flatMap((step) => {
    const returnType = signatures[signatureKey(step.module, step.tool)].returnType;
    if (!UNTYPED.includes(valueType(returnType)) || !referenced.includes(step.id)) {
      return [];
    }
    const message = `${step.tool} ${untypedReason(returnType)}, so a reference into its value is checked only when the workflow runs`;
    return [{ step: step.id, field: "tool", message }];
  });
}

const COST_MESSAGE =
  "this loop runs a model once per item, and the workflow sets no limits.maxCost, so its cost depends on the length of the list";

/** The outermost loops: `each` steps that no other `each` step holds. */
function outerLoops(steps: Step[]): EachStep[] {
  return steps.flatMap((step) =>
    step.kind === "each" ? [step] : stepChildren(step).flatMap(outerLoops),
  );
}

/** A warning on each outermost loop that runs a model, when the workflow
 *  has no `maxCost`: an LLM step, or a tool the catalog marks `handoff`.
 *  A loop inside it adds nothing new, so it gets no warning of its own. */
function costWarnings({ workflow, signatures }: Context): Problem[] {
  if (typeof workflow.limits?.maxCost === "number") {
    return [];
  }
  const runsModel = (step: Step) =>
    step.kind === "llm" ||
    (step.kind === "tool" && signatures[signatureKey(step.module, step.tool)]?.handoff === true);
  return outerLoops(workflow.steps)
    .filter((loop) => allSteps({ ...workflow, steps: loop.steps }).some(runsModel))
    .map((loop) => ({ step: loop.id, field: "over", message: COST_MESSAGE }));
}

function binding(local: string, field: string, value: unknown): Binding {
  return { local, field, value: resolveValue(value) };
}

/** A step's limits, or null when none is set. */
function stepLimits(step: ValueStep): Limits | null {
  const limits = step.limits ?? null;
  if (limits === null || (limits.maxCost === undefined && limits.maxTime === undefined)) {
    return null;
  }
  return limits;
}

function resolveToolStep(step: ToolStep, signatures: Record<string, Signature>): ResolvedStep {
  const stepNames = names(step.id);
  const argOrder = sortedArgs(step);
  const limits = stepLimits(step);
  return {
    id: step.id,
    kind: "tool",
    value: stepNames.value,
    module: step.module,
    tool: step.tool,
    holdsResult: signatures[signatureKey(step.module, step.tool)].returnsResult || limits !== null,
    limits,
    bindings: argOrder.map((arg) => binding(stepNames.arg(arg), `args.${arg}`, step.args[arg])),
    argOrder,
  };
}

function resolveLlmStep(step: LlmStep): ResolvedStep {
  const stepNames = names(step.id);
  const limits = stepLimits(step);
  return {
    id: step.id,
    kind: "llm",
    value: stepNames.value,
    reply: stepNames.reply,
    holdsResult: limits !== null,
    limits,
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

function resolveMatchStep(step: MatchStep, signatures: Record<string, Signature>): ResolvedStep {
  const stepNames = names(step.id);
  const resolveList = (list: Step[]) => list.map((item) => resolveStep(item, signatures));
  return {
    id: step.id,
    kind: "match",
    on: binding(stepNames.on, "on", step.on),
    cases: step.cases.map((item, index) => ({
      is: item.is,
      test: stepNames.caseTest(index),
      steps: resolveList(item.steps),
    })),
    otherwise: step.otherwise == null ? null : resolveList(step.otherwise),
  };
}

function resolveEachStep(step: EachStep, signatures: Record<string, Signature>): ResolvedStep {
  const stepNames = names(step.id);
  return {
    id: step.id,
    kind: "each",
    over: binding(stepNames.over, "over", step.over),
    item: stepNames.item,
    steps: step.steps.map((item) => resolveStep(item, signatures)),
  };
}

function resolveStep(step: Step, signatures: Record<string, Signature>): ResolvedStep {
  switch (step.kind) {
    case "tool":
      return resolveToolStep(step, signatures);
    case "llm":
      return resolveLlmStep(step);
    case "match":
      return resolveMatchStep(step, signatures);
    case "each":
      return resolveEachStep(step, signatures);
  }
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
  const resolved: ResolvedWorkflow = {
    name: workflow.name,
    inputsType: workflow.inputs,
    imports: importGroups(workflow),
    steps: workflow.steps.map((step) => resolveStep(step, signatures)),
    result: workflow.result == null ? null : resolveValue(workflow.result),
    limits: workflow.limits ?? null,
    warnings: [...untypedWarnings(context), ...costWarnings(context)],
  };
  return { resolved, problems: [] };
}
