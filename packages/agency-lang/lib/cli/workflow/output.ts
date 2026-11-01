/**
 * What the `agency workflow` commands print. Every piece of text that came
 * from a file goes through `stripControlCharacters`, so a docstring or a
 * workflow description cannot move the cursor or recolor the terminal.
 */
import type { CatalogEntry } from "../../stdlib/workflow/catalog.js";
import type { StepEffects } from "../../stdlib/workflow/effects.js";
import { describeProblem } from "../../stdlib/workflow/index.js";
import type { Problem } from "../../stdlib/workflow/types.js";
import { stripControlCharacters } from "../../utils/controlCharacters.js";

const clean = stripControlCharacters;

/** The first paragraph of a description, on one line. */
function firstParagraph(text: string): string {
  const [first] = text.trim().split(/\n\s*\n/);
  return (first ?? "")
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
}

/** `name(param: type = default, ...): returns`, as the signature writes it. */
function signatureLine(entry: CatalogEntry): string {
  const params = entry.params.map((param) => {
    const typed = param.type === null ? param.name : `${param.name}: ${param.type}`;
    return param.default === null ? typed : `${typed} = ${param.default}`;
  });
  const returns = entry.returns === null ? "" : `: ${entry.returns}`;
  return `${entry.name}(${params.join(", ")})${returns}`;
}

/** A heading per module, then each tool's signature, its description's
 *  first paragraph, and what it raises. */
export function formatCatalog(entries: CatalogEntry[]): string {
  const modules = entries
    .map((entry) => entry.module)
    .filter((module, index, all) => all.indexOf(module) === index);
  const lines = modules.flatMap((module) => [
    clean(module),
    ...entries
      .filter((entry) => entry.module === module)
      .flatMap((entry) => [
        `  ${clean(signatureLine(entry))}`,
        ...(entry.description === "" ? [] : [`    ${clean(firstParagraph(entry.description))}`]),
        ...(entry.effects.length === 0 ? [] : [`    raises ${clean(entry.effects.join(", "))}`]),
      ]),
  ]);
  return lines.join("\n");
}

/** `<label> has <n> problem(s):`, then one line each. */
export function formatProblems(label: string, problems: Problem[]): string {
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  return [
    `${clean(label)} has ${count}:`,
    ...problems.map((problem) => `  ${clean(describeProblem(problem))}`),
  ].join("\n");
}

/** One effect and the steps that raise it, written `<id> (<tool>)`. */
export type EffectSteps = { effect: string; steps: string[] };

/** Each effect the steps raise, in the order it is first raised, with the
 *  steps that raise it. */
export function effectSteps(steps: StepEffects[]): EffectSteps[] {
  const byEffect: EffectSteps[] = [];
  for (const { step, tool, effects } of steps) {
    for (const effect of effects) {
      const named = `${step} (${tool})`;
      const entry = byEffect.find((existing) => existing.effect === effect);
      if (entry === undefined) {
        byEffect.push({ effect, steps: [named] });
      } else if (!entry.steps.includes(named)) {
        entry.steps.push(named);
      }
    }
  }
  return byEffect;
}

/** Each effect, padded to one column, then its steps. */
export function effectTable(list: EffectSteps[]): string[] {
  const width = Math.max(...list.map((entry) => entry.effect.length));
  return list.map(
    ({ effect, steps }) =>
      `  ${clean(effect).padEnd(width)}   ${steps.map((step) => `step ${clean(step)}`).join(", ")}`,
  );
}

/** `<label>: no problems`, the warnings, then what the workflow can raise. */
export function formatChecked(label: string, warnings: Problem[], steps: StepEffects[]): string {
  const raised = effectSteps(steps);
  return [
    `${clean(label)}: no problems`,
    ...warnings.map((warning) => `warning: ${clean(describeProblem(warning))}`),
    ...(raised.length === 0 ? ["can raise: nothing"] : ["can raise:", ...effectTable(raised)]),
  ].join("\n");
}

/** The part of a saved workflow `list` prints. */
export type ListedWorkflow = { name: string; workflow: { inputs: string; description: string } };

/** Each workflow's name and inputs, then its description. */
export function formatList(dir: string, entries: ListedWorkflow[]): string {
  if (entries.length === 0) {
    return `no saved workflows in ${clean(dir)}/workflows`;
  }
  return entries
    .flatMap(({ name, workflow }) => [
      `${clean(name)} ${clean(workflow.inputs)}`,
      ...(workflow.description === "" ? [] : [`  ${clean(firstParagraph(workflow.description))}`]),
    ])
    .join("\n");
}
