import type { Command } from "commander";

import type { AgencyConfig } from "@/config.js";

import {
  evalIngest,
  INGEST_PATH_DESCRIPTION,
  SOURCE_FLAG_DESCRIPTION,
} from "./ingest.js";
import { evalLabel } from "./label.js";
import { evalLabelMigrate } from "./migrate.js";

export type LabelCommandDependencies = {
  getConfig(): AgencyConfig;
  evalLabel: typeof evalLabel;
  evalIngest: typeof evalIngest;
  evalLabelMigrate: typeof evalLabelMigrate;
  fail(message: string): void;
};

/** Every action reports the same way: a message, then exit 2. Matching the rest
 *  of the eval commands. */
function defaultFail(message: string): void {
  console.error(`Error: ${message}`);
  process.exit(2);
}

export function labelCommandDependencies(
  getConfig: () => AgencyConfig,
): LabelCommandDependencies {
  return { getConfig, evalLabel, evalIngest, evalLabelMigrate, fail: defaultFail };
}

/**
 * Wire `label` and its subcommands onto a parent.
 *
 * Called twice — once on the program for `agency label`, once on `eval` for
 * `agency eval label` — following the same dual registration `optimize` uses.
 * The short form is what people type; the eval form keeps it discoverable
 * beside run, grade and optimize.
 *
 * **No option name may appear on both `label` and one of its subcommands.**
 * Commander gives the parent priority, wherever the flag sits on the line, so a
 * duplicate is not a conflict error — the subcommand simply receives
 * `undefined` and behaves as though the flag were never passed.
 * `enablePositionalOptions()` would fix it, but only when set on the root
 * program, where it changes option parsing for every command in the CLI.
 *
 * So `--store` is declared once, on `label`, and the subcommands read it from
 * their parent. It works in either position: `label --store x ingest …` and
 * `label ingest … --store x` both reach the parent.
 *
 * `label` also takes no positional, which is why ingesting and labelling are
 * always two commands. That is the shape the store wants anyway: you ingest
 * several sources, then label once.
 */
export function addLabelCommand(
  parent: Command,
  dependencies: LabelCommandDependencies,
): Command {
  const label = parent
    .command("label")
    .description("Label the records in a label store. Add records with `label ingest` first")
    .option("--store <dir>", "Label store directory (default: eval.labelStore, else labels/)")
    .option("--checklist <file>", "Checklist JSON: an existing one, or { name, questions }")
    .option("--annotator <id>", "Who is labelling (default: $USER)")
    .action(async (opts: { checklist?: string; store?: string; annotator?: string }) => {
      try {
        await dependencies.evalLabel({ ...opts, config: dependencies.getConfig() });
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });

  label
    .command("ingest")
    .description("Add outputs to the label store, from a run, a directory of files, or a JSON array")
    .argument("<source>", INGEST_PATH_DESCRIPTION)
    .argument("[extra...]", "Rejected: several arguments means the shell expanded an unquoted glob")
    .option("--source <name>", SOURCE_FLAG_DESCRIPTION)
    .option("--format <fmt>", "auto (default), run, files, or json")
    .option("--task <text>", "Shorthand for --field task=<text>")
    .option("--field <name=value>", "A constant field added to every record", collectRepeated, [])
    .option("--no-task-field", "Run sources only: drop the run's own task field")
    .option("--recursive", "Descend into subdirectories")
    .option("--max-bytes <n>", "Per-value size cap in bytes (default 1048576)", parseByteCap)
    .action(async (source: string, extra: string[], opts: {
      source?: string;
      format?: string;
      task?: string;
      field?: string[];
      taskField?: boolean;
      recursive?: boolean;
      maxBytes?: number;
    }, command: Command) => {
      try {
        await dependencies.evalIngest({
          ...opts,
          store: storeOptionOf(command),
          path: source,
          extraArgs: extra,
          config: dependencies.getConfig(),
        });
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });

  label
    .command("migrate")
    .description("Rewrite a label store in the current format, writing a new store")
    .argument("<source>", "Existing label store directory")
    .argument("<dest>", "Where to write the migrated store; must not exist")
    .action(async (source: string, dest: string) => {
      try {
        await dependencies.evalLabelMigrate({ sourceDir: source, destDir: dest });
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });

  return label;
}

/** `--store` lives on `label`, so a subcommand asks its parent for it. */
function storeOptionOf(command: Command): string | undefined {
  return (command.parent?.opts() as { store?: string } | undefined)?.store;
}

/** commander calls this once per repeat of a flag, accumulating the values. */
export function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseByteCap(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--max-bytes must be a positive whole number of bytes; got "${value}"`);
  }
  return parsed;
}
