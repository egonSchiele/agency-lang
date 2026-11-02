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
import { parseTypeText, printType } from "../../stdlib/workflow/typeText.js";
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

/** One step that raises an effect: the step's id and the tool it calls. */
export type RaisingStep = { step: string; tool: string };

/** One effect and the steps that raise it. */
export type EffectSteps = { effect: string; steps: RaisingStep[] };

/** Each effect the steps raise, in the order it is first raised, with the
 *  steps that raise it. */
export function effectSteps(steps: StepEffects[]): EffectSteps[] {
  const byEffect: EffectSteps[] = [];
  for (const { step, tool, effects } of steps) {
    for (const effect of effects) {
      const entry = byEffect.find((existing) => existing.effect === effect);
      if (entry === undefined) {
        byEffect.push({ effect, steps: [{ step, tool }] });
      } else if (!entry.steps.some((raising) => raising.step === step)) {
        entry.steps.push({ step, tool });
      }
    }
  }
  return byEffect;
}

const EFFECT_COLUMNS = ["Effect", "Step", "Tool"];

/** A table with a heading row, then one row for each step that raises each
 *  effect:
 *
 *    Effect         Step      Tool
 *    std::weather   weather   weather
 *
 *  The widths are worked out on the plain text, before anything is colored. */
export function effectTable(list: EffectSteps[], paint: ColorFunction = ttyColor): string[] {
  const rows = list.flatMap(({ effect, steps }) =>
    steps.map(({ step, tool }) => [clean(effect), clean(step), clean(tool)]),
  );
  const widths = EFFECT_COLUMNS.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column].length)),
  );
  const last = EFFECT_COLUMNS.length - 1;
  const padded = (cells: string[]) =>
    cells.map((cell, column) => (column === last ? cell : cell.padEnd(widths[column])));
  return [
    paint.dim(`  ${padded(EFFECT_COLUMNS).join("   ")}`),
    ...rows.map((row) => {
      const [effect, ...rest] = padded(row);
      return `  ${paint.cyan(effect)}   ${rest.join("   ")}`;
    }),
  ];
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

/**
 * A workflow's inputs type written as a parameter list, so a saved workflow
 * reads like a function call: `{ zip: string; units: string }` becomes
 * `zip: string, units: string`. The printer puts each top-level property on
 * its own line ending in `;`, and a nested object type on one line, so the
 * line ends are where the commas go. Text that does not parse is returned
 * as it is.
 */
export function inputsAsParams(inputs: string): string {
  const parsed = parseTypeText("Inputs", inputs, "inputs");
  if ("message" in parsed) {
    return inputs;
  }
  const lines = printType(parsed.alias).split("\n");
  return lines
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => (line.endsWith(";") ? `${line.slice(0, -1)},` : line))
    .join(" ");
}

/** Each workflow as a call, `name(input: type, ...)`, then its description,
 *  with a blank line between workflows. */
export function formatList(
  dir: string,
  entries: ListedWorkflow[],
  paint: ColorFunction = ttyColor,
): string {
  if (entries.length === 0) {
    return `no saved workflows in ${clean(dir)}/workflows`;
  }
  return entries
    .map(({ name, workflow }) =>
      [
        `${paint.cyan.bold(clean(name))}(${clean(inputsAsParams(workflow.inputs))})`,
        ...(workflow.description === ""
          ? []
          : [`  ${clean(firstParagraph(workflow.description))}`]),
      ].join("\n"),
    )
    .join("\n\n");
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
