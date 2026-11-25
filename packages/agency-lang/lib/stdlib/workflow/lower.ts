/**
 * Stage 3 of the workflow generator: a `ResolvedWorkflow` becomes one flat
 * list of fragments, each knowing the step and field it belongs to and how
 * many blocks it is inside. A fragment is a statement from a shape in
 * `shapes.ts`, or one of a block's own lines (`ifLine`, `forLine`, and the
 * fixed lines beside them). The only text composed here is a reference (a
 * generated name, `.value`, and a path the format's grammar accepted) and
 * an import line (checked names and a checked module path).
 */
import { _parseExpr, type Code } from "../template.js";
import {
  CLOSE_LINE,
  ELSE_LINE,
  expression,
  forLine,
  guardArgs,
  ifLine,
  list,
  literal,
  record,
  statement,
  THREAD_LINE,
} from "./shapes.js";
import { MODULE_PATH } from "./tools.js";
import {
  allResolved,
  isIdentifier,
  type Binding,
  type ContextBinding,
  type Fragment,
  type ImportGroup,
  type Limits,
  type LineFragment,
  type Lowered,
  type Owner,
  type ResolvedEachStep,
  type ResolvedLlmStep,
  type ResolvedMatchStep,
  type ResolvedRef,
  type ResolvedStep,
  type ResolvedToolStep,
  type ResolvedValue,
  type ResolvedValueStep,
  type ResolvedWorkflow,
  type TypeDecl,
} from "./types.js";

/** What follows a root name in a reference: `.field` and `[n]` segments.
 *  Parse already matched it; this is checked again where it is written. */
const REF_TAIL = /^(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/;

/** What a reference can name: every value step and every loop, by id.
 *  Ids are unique across the tree, so one table serves every depth. */
type Names = {
  steps: Record<string, ResolvedValueStep>;
  loops: Record<string, ResolvedEachStep>;
};

/** A statement before it knows its depth. */
type Statement = { code: Code; owner: Owner | null };

function isValueStep(step: ResolvedStep): step is ResolvedValueStep {
  return step.kind === "tool" || step.kind === "llm";
}

export function importLine({ module, names }: ImportGroup): string {
  if (!MODULE_PATH.test(module) || !names.every(isIdentifier)) {
    throw new Error(`cannot write an import from "${module}"`);
  }
  return `import { ${names.join(", ")} } from "${module}"`;
}

function local(name: string): string {
  if (!isIdentifier(name)) {
    throw new Error(`cannot write the local "${name}"`);
  }
  return name;
}

/** `inputs.<name><path>`; a step's local, `.value` when it holds a
 *  `Result`, and the path; or a loop's item and the path. An item is never
 *  a `Result`, so it never gets `.value`. */
function reference(ref: ResolvedRef, names: Names): Code {
  if (!REF_TAIL.test(ref.path)) {
    throw new Error(`cannot write the reference path "${ref.path}"`);
  }
  if (ref.kind === "input") {
    return _parseExpr(`inputs.${ref.name}${ref.path}`);
  }
  if (ref.kind === "item") {
    return _parseExpr(`${local(names.loops[ref.loop].item)}${ref.path}`);
  }
  const target = names.steps[ref.step];
  const unwrap = target.holdsResult ? ".value" : "";
  return _parseExpr(`${local(target.value)}${unwrap}${ref.path}`);
}

function valueCode(value: ResolvedValue, names: Names): Code {
  switch (value.kind) {
    case "literal":
      return literal(value.value);
    case "list":
      return list(value.items.map((item) => valueCode(item, names)));
    case "record":
      return record(
        value.entries.map(({ key, value: entry }) => ({ key, value: valueCode(entry, names) })),
      );
    default:
      return reference(value, names);
  }
}

/** The label a context value carries in the prompt: where it was read from. */
function refLabel(value: ResolvedValue): string {
  switch (value.kind) {
    case "input":
      return ` (inputs.${value.name}${value.path})`;
    case "step":
      return ` (steps.${value.step}${value.path})`;
    case "item":
      return ` (each.${value.loop}${value.path})`;
    default:
      return "";
  }
}

function bindingStatement(stepId: string, binding: Binding, names: Names): Statement {
  return {
    code: statement(
      "binding",
      { local: binding.local },
      { value: valueCode(binding.value, names) },
    ),
    owner: { step: stepId, field: binding.field },
  };
}

/** The `, time: …, cost: …` text a step guard adds after its label. */
function limitsText(limits: Limits): string {
  return guardArgs(limits)
    .map((piece) => `, ${piece}`)
    .join("");
}

/** `const <value> = guard(label: "<id>", <limits>) { <body> }`. */
function guarded(step: ResolvedValueStep, limits: Limits, body: Code): Code {
  const stepNames = { value: step.value, limits: limitsText(limits) };
  return statement("guarded", stepNames, { label: literal(step.id), body });
}

/** The failure check after a step. `tool` names what the message blames. */
function checkStatement(step: ResolvedValueStep, tool: string, owner: Owner): Statement {
  const shape = step.holdsResult ? "check" : "checkPlain";
  const stepNames = { value: step.value, id: step.id, tool };
  return { code: statement(shape, stepNames, { id: literal(step.id) }), owner };
}

function toolStatements(step: ResolvedToolStep, names: Names): Statement[] {
  const owner = { step: step.id, field: "args" };
  const args = step.argOrder
    .map((arg, index) => `${arg}: ${step.bindings[index].local}`)
    .join(", ");
  const call =
    step.limits === null
      ? statement("call", { value: step.value, tool: step.tool, args }, {})
      : guarded(step, step.limits, statement("returnCall", { tool: step.tool, args }, {}));
  return [
    ...step.bindings.map((binding) => bindingStatement(step.id, binding, names)),
    { code: call, owner },
    checkStatement(step, step.tool, owner),
  ];
}

/** The `const` that holds a context value as the model reads it. */
function contextTextStatement(step: ResolvedLlmStep, binding: ContextBinding): Statement {
  return {
    code: statement("contextText", { local: binding.text, value: binding.local }, {}),
    owner: { step: step.id, field: binding.field },
  };
}

/** The prompt text, then for each context value a label and its text, joined with `+`. */
function promptCode(step: ResolvedLlmStep): Code {
  const contexts = step.bindings.flatMap((binding, index) => [
    literal(`\n\nContext ${index + 1}${refLabel(binding.value)}:\n`),
    expression("local", { name: binding.text }, {}),
  ]);
  return [literal(step.prompt), ...contexts].reduce((left, right) =>
    expression("concat", {}, { left, right }),
  );
}

function llmStatements(step: ResolvedLlmStep, names: Names): Statement[] {
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
  const owner = { step: step.id, field: "prompt" };
  const threadNames = { reply: step.reply, outputType: step.typeName, options: options.join("") };
  const contexts = step.bindings.flatMap((binding) => [
    bindingStatement(step.id, binding, names),
    contextTextStatement(step, binding),
  ]);
  if (step.limits === null) {
    const declare = statement("letNull", { value: step.value, outputType: step.typeName }, {});
    const after = { ...threadNames, after: `${step.value} = ${step.reply}` };
    const thread = statement("llmThread", after, values);
    return [...contexts, { code: declare, owner }, { code: thread, owner }];
  }
  const thread = statement("llmThread", { ...threadNames, after: `return ${step.reply}` }, values);
  return [
    ...contexts,
    { code: guarded(step, step.limits, thread), owner },
    checkStatement(step, "llm", owner),
  ];
}

function atDepth(statements: Statement[], depth: number): Fragment[] {
  return statements.map((item) => ({ ...item, depth }));
}

function line(text: string, owner: Owner | null, depth: number): LineFragment {
  return { line: text, owner, depth };
}

/** The `on` binding and one comparison per case, then the `if` chain. With
 *  no `otherwise`, the last `else` fails the workflow. */
function matchFragments(step: ResolvedMatchStep, names: Names, depth: number): Fragment[] {
  const owner = (field: string) => ({ step: step.id, field });
  const tests = step.cases.map((item, index) => ({
    code: statement("caseTest", { local: item.test, on: step.on.local }, { is: literal(item.is) }),
    owner: owner(`cases[${index}].is`),
  }));
  const branches = step.cases.flatMap((item, index) => [
    line(ifLine(item.test, index === 0), owner(`cases[${index}].is`), depth),
    ...listFragments(item.steps, names, depth + 1),
  ]);
  const noCase = statement("noCase", { id: step.id, on: step.on.local }, { id: literal(step.id) });
  const last =
    step.otherwise === null
      ? [
          line(ELSE_LINE, owner("cases"), depth),
          ...atDepth([{ code: noCase, owner: owner("cases") }], depth + 1),
        ]
      : [
          line(ELSE_LINE, owner("otherwise"), depth),
          ...listFragments(step.otherwise, names, depth + 1),
        ];
  return [
    ...atDepth([bindingStatement(step.id, step.on, names), ...tests], depth),
    ...branches,
    ...last,
    line(CLOSE_LINE, null, depth),
  ];
}

/** The `over` binding, then a `for` loop whose every round runs in a
 *  `thread` block of its own, so a round starts with an empty conversation. */
function eachFragments(step: ResolvedEachStep, names: Names, depth: number): Fragment[] {
  const owner = { step: step.id, field: "over" };
  return [
    ...atDepth([bindingStatement(step.id, step.over, names)], depth),
    line(forLine(step.item, step.over.local), owner, depth),
    line(THREAD_LINE, owner, depth + 1),
    ...listFragments(step.steps, names, depth + 2),
    line(CLOSE_LINE, null, depth + 1),
    line(CLOSE_LINE, null, depth),
  ];
}

function listFragments(steps: ResolvedStep[], names: Names, depth: number): Fragment[] {
  return steps.flatMap((step) => {
    switch (step.kind) {
      case "tool":
        return atDepth(toolStatements(step, names), depth);
      case "llm":
        return atDepth(llmStatements(step, names), depth);
      case "match":
        return matchFragments(step, names, depth);
      case "each":
        return eachFragments(step, names, depth);
    }
  });
}

function typeDecls(resolved: ResolvedWorkflow): TypeDecl[] {
  const outputs = allResolved(resolved.steps).flatMap((step) =>
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
  const every = allResolved(resolved.steps);
  const values = every.filter(isValueStep);
  const names: Names = {
    steps: Object.fromEntries(values.map((step) => [step.id, step])),
    loops: Object.fromEntries(
      every.flatMap((step) => (step.kind === "each" ? [[step.id, step]] : [])),
    ),
  };
  // With no `result`, the last top-level step's value. Resolve refused a block there.
  const last = resolved.steps[resolved.steps.length - 1];
  const result = resolved.result ?? { kind: "step", step: last.id, path: "" };
  return {
    imports: resolved.imports.map(importLine),
    types: typeDecls(resolved),
    body: listFragments(resolved.steps, names, 0),
    result: valueCode(result, names),
    guard: resolved.limits,
    guardLabel: resolved.name,
    guardLabels: [
      ...(resolved.limits === null ? [] : [resolved.name]),
      ...values.filter((step) => step.limits !== null).map((step) => step.id),
    ],
  };
}
