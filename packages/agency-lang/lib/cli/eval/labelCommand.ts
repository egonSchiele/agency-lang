import type { Command } from "@/vendor/commander/index.js";

import { label } from "./label.js";

export type LabelCommandDependencies = {
  label: typeof label;
  fail(message: string): void;
};

/** Every action reports the same way: a message, then exit 2. Matching the rest
 *  of the eval commands. */
function defaultFail(message: string): void {
  console.error(`Error: ${message}`);
  process.exit(2);
}

export function labelCommandDependencies(): LabelCommandDependencies {
  return { label, fail: defaultFail };
}

/**
 * Wire `label` onto a parent.
 *
 * Called twice — once on the program for `agency label`, once on `eval` for
 * `agency eval label` — following the same dual registration `optimize` uses.
 * The short form is what people type; the eval form keeps it discoverable
 * beside run and grade.
 */
export function addLabelCommand(parent: Command, dependencies: LabelCommandDependencies): Command {
  return parent
    .command("label")
    .description("Judge every run against a checklist")
    .argument("<paths...>", "Run directories, or directories of run directories")
    .option("--checklist <file>", "Checklist JSON: an existing one, or { name, questions }")
    .option("--annotator <id>", "Who is labelling (default: $USER)")
    .action(async (paths: string[], opts: { checklist?: string; annotator?: string }) => {
      try {
        await dependencies.label({ paths, ...opts });
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });
}
