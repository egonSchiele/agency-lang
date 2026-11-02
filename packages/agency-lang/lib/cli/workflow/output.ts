/**
 * What the `agency workflow` commands print. Every piece of text that came
 * from a file goes through `stripControlCharacters`, so a docstring or a
 * workflow description cannot move the cursor or recolor the terminal.
 *
 * Each formatter takes the color function as its last argument. The default,
 * `ttyColor`, colors on a terminal and prints plain text when the output is
 * piped. Text that goes into `--json` output passes `plainColor`. Text is
 * cleaned before it is colored, since cleaning would strip the color codes.
 */
import type { CatalogEntry } from "../../stdlib/workflow/catalog.js";
import type { StepEffects } from "../../stdlib/workflow/effects.js";
import { describeProblem } from "../../stdlib/workflow/index.js";
import type { Problem } from "../../stdlib/workflow/types.js";
import { stripControlCharacters } from "../../utils/controlCharacters.js";
import { type ColorFunction, ttyColor } from "../../utils/termcolors.js";

const clean = stripControlCharacters;

/** The first paragraph of a description, on one line. */
function firstParagraph(text: string): string {
  const [first] = text.trim().split(/\n\s*\n/);
  return (first ?? "")
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
}

/** `name(param: type = default, ...): returns`, as the signature writes it,
 *  with the name colored. */
function signatureLine(entry: CatalogEntry, paint: ColorFunction): string {
  const params = entry.params.map((param) => {
    const typed = param.type === null ? param.name : `${param.name}: ${param.type}`;
    return param.default === null ? typed : `${typed} = ${param.default}`;
  });
  const returns = entry.returns === null ? "" : `: ${entry.returns}`;
  return `${paint.cyan(clean(entry.name))}${clean(`(${params.join(", ")})${returns}`)}`;
}

/** A heading per module, then each tool's signature, its description's
 *  first paragraph, and what it raises. */
export function formatCatalog(entries: CatalogEntry[], paint: ColorFunction = ttyColor): string {
  const modules = entries
    .map((entry) => entry.module)
    .filter((module, index, all) => all.indexOf(module) === index);
  const lines = modules.flatMap((module) => [
    paint.bold(clean(module)),
    ...entries
      .filter((entry) => entry.module === module)
      .flatMap((entry) => [
        `  ${signatureLine(entry, paint)}`,
        ...(entry.description === "" ? [] : [`    ${clean(firstParagraph(entry.description))}`]),
        ...(entry.effects.length === 0
          ? []
          : [`    raises ${paint.yellow(clean(entry.effects.join(", ")))}`]),
      ]),
  ]);
  return lines.join("\n");
}

/** `<label> has <n> problem(s):`, then one line each. */
export function formatProblems(
  label: string,
  problems: Problem[],
  paint: ColorFunction = ttyColor,
): string {
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  return [
    `${clean(label)} has ${paint.red.bold(count)}:`,
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

/** Each effect, padded to one column, then its steps. The padding is
 *  worked out on the plain text, before the effect is colored. */
export function effectTable(list: EffectSteps[], paint: ColorFunction = ttyColor): string[] {
  const width = Math.max(...list.map((entry) => clean(entry.effect).length));
  return list.map(
    ({ effect, steps }) =>
      `  ${paint.cyan(clean(effect).padEnd(width))}   ${steps.map((step) => `step ${clean(step)}`).join(", ")}`,
  );
}

/** `<label>: no problems`, then the warnings and what the workflow can
 *  raise, each under its own heading with a blank line before it. A
 *  warning's message is a whole sentence that names its step, so it is
 *  printed as it is. */
export function formatChecked(
  label: string,
  warnings: Problem[],
  steps: StepEffects[],
  paint: ColorFunction = ttyColor,
): string {
  const raised = effectSteps(steps);
  const warningLines =
    warnings.length === 0
      ? []
      : [
          "",
          paint.yellow.bold("Warnings:"),
          ...warnings.map((warning) => `  ${clean(warning.message)}`),
        ];
  const effectLines =
    raised.length === 0
      ? ["", `${paint.bold("Effects this workflow can raise:")} none`]
      : ["", paint.bold("Effects this workflow can raise:"), ...effectTable(raised, paint)];
  return [`${clean(label)}: ${paint.green("no problems")}`, ...warningLines, ...effectLines].join(
    "\n",
  );
}

/** The part of a saved workflow `list` prints. */
export type ListedWorkflow = { name: string; workflow: { inputs: string; description: string } };

/** Each workflow's name and inputs, then its description. */
export function formatList(
  dir: string,
  entries: ListedWorkflow[],
  paint: ColorFunction = ttyColor,
): string {
  if (entries.length === 0) {
    return `no saved workflows in ${clean(dir)}/workflows`;
  }
  return entries
    .flatMap(({ name, workflow }) => [
      `${paint.cyan.bold(clean(name))} ${clean(workflow.inputs)}`,
      ...(workflow.description === "" ? [] : [`  ${clean(firstParagraph(workflow.description))}`]),
    ])
    .join("\n");
}

/** A run's value: a string as itself, anything else as indented JSON. */
export function formatRunValue(value: unknown): string {
  return clean(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** The effects a person's policy does not cover, before the run asks. */
export function formatUncovered(list: EffectSteps[], paint: ColorFunction = ttyColor): string {
  return [
    paint.bold("Your policy does not cover these interrupts:"),
    ...effectTable(list, paint),
  ].join("\n");
}

/** What `run` says when it has no terminal to ask in. */
export const NO_TERMINAL =
  "Run this in a terminal to approve them, or cover them with --policy, --approve, or --reject.";
