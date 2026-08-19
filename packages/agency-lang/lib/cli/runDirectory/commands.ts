import type { Command } from "@/vendor/commander/index.js";

import { runsAdd } from "./add.js";
import { logsExtract } from "./extract.js";
import { runsList } from "./list.js";
import { note } from "./note.js";

export type RunDirectoryCommandDependencies = {
  runsAdd: typeof runsAdd;
  runsList: typeof runsList;
  note: typeof note;
  logsExtract: typeof logsExtract;
  fail(message: string): void;
};

function defaultFail(message: string): void {
  console.error(`Error: ${message}`);
  process.exit(2);
}

export function runDirectoryCommandDependencies(): RunDirectoryCommandDependencies {
  return { runsAdd, runsList, note, logsExtract, fail: defaultFail };
}

/** commander calls this once per repeat of a flag, accumulating the values. */
function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `agency runs add|list` and `agency note`. */
export function addRunDirectoryCommands(
  program: Command,
  dependencies: RunDirectoryCommandDependencies,
): void {
  const runs = program
    .command("runs")
    .description("Assemble and browse run directories (a statelog plus its attachments)");

  runs
    .command("add")
    .description(
      "Wrap each trace of a statelog as a run directory <dir>/<traceId>/, with its code, workdir, and annotations",
    )
    .argument("<dir>", "The directory to write the run directories into (created if missing)")
    .option(
      "--statelog <file>",
      "A statelog whose traces to wrap (repeatable)",
      collectRepeated,
      [],
    )
    .option(
      "--code <entry>",
      "An agent entry file whose closure a trace recorded (repeatable)",
      collectRepeated,
      [],
    )
    .option("--workdir <path>", "A directory to snapshot as the run's workdir (one trace only)")
    .option("--trace <id>", "Wrap only this trace (full id or unique prefix)")
    .option(
      "--annotations <file>",
      "An annotations.jsonl to import (repeatable)",
      collectRepeated,
      [],
    )
    .action(
      (
        dir: string,
        opts: {
          statelog: string[];
          code: string[];
          workdir?: string;
          trace?: string;
          annotations: string[];
        },
      ) => {
        try {
          dependencies.runsAdd({ dir, ...opts });
        } catch (error) {
          dependencies.fail((error as Error).message);
        }
      },
    );

  runs
    .command("list")
    .description("One line per trace: when, how it ended, cost, score, notes")
    .argument("<dir>", "The run directory")
    .action((dir: string) => {
      try {
        dependencies.runsList(dir);
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });

  program
    .command("note")
    .description("Append a free-text note about one trace in a run directory")
    .argument("<dir>", "The run directory")
    .argument("<text>", "What you observed and what you wanted instead")
    .option("--trace <id>", "Which trace (default: the only one)")
    .option("--annotator <id>", "Who is writing (default: $USER)")
    .action((dir: string, text: string, opts: { trace?: string; annotator?: string }) => {
      try {
        dependencies.note({ dir, text, ...opts });
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });
}

/** `agency logs extract <log> [--trace <id>] [-o <file>]`, on the logs command. */
export function addLogsExtractCommand(
  logs: Command,
  dependencies: RunDirectoryCommandDependencies,
): void {
  logs
    .command("extract")
    .description(
      "Copy one trace out of a statelog, to a file or stdout. Lines are copied as they " +
        "appear; a torn final line and byte-identical repeated lines are dropped.",
    )
    .argument("<log>", "A statelog .jsonl file")
    .option("--trace <id>", "Trace id or unique prefix (default: the only trace)")
    .option("-o, --out <file>", "Write here instead of stdout (refused if it exists)")
    .option("--overwrite", "Replace an existing --out file (never the source log)")
    .action((log: string, opts: { trace?: string; out?: string; overwrite?: boolean }) => {
      try {
        const result = dependencies.logsExtract({ log, ...opts });
        if (opts.out !== undefined) {
          console.error(`Wrote trace ${result.traceId} (${result.lines} events) to ${opts.out}`);
        }
      } catch (error) {
        dependencies.fail((error as Error).message);
      }
    });
}
