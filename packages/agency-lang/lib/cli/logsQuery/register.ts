// `agency logs traces`, `outline`, and `search` on the command tree. The
// flags are declared on each leaf: the vendored commander gives a parent
// priority and refuses a flag that an ancestor already declares, and
// `logs` declares `--follow`, `--csv`, and `--trace-id`. The help text is
// this file's own; the session commands' `--trace` means something else.
import { pathKind } from "@/cli/logsSession/index.js";
import { liveSessions } from "@/cli/logsSession/target.js";
import { nodeHost } from "@/host/node/nodeHost.js";
import { probeAll, recordPaths, sessionsDir } from "@/logsViewer/session/registry.js";
import { childRunDirectories } from "@/runDirectory/findRuns.js";
import { parseCount, type TraceSelectionFlags } from "@/runDirectory/traceSelection.js";
import { readTraces } from "@/runDirectory/traces.js";
import type { Command } from "@/vendor/commander/index.js";

import { logsOutline } from "./outline.js";
import { DEFAULT_SEARCH_LIMIT, DEFAULT_SNIPPET_CONTEXT, logsSearch } from "./search.js";
import { refusal, type QueryDeps, type QueryResult } from "./shared.js";
import { logsTraces } from "./traces.js";

export type LogsQueryDeps = QueryDeps & { writeStdout(text: string): void };

/** The real deps: the viewer registry under the agent home, the files on
 *  disk, and `configuredLog`, which reads `log.logFile` when called. */
export function defaultLogsQueryDeps(configuredLog: () => string | undefined): LogsQueryDeps {
  const dir = sessionsDir(nodeHost());
  return {
    cwd: process.cwd(),
    pathKind,
    childRunDirectories,
    configuredLog,
    probe: async () =>
      liveSessions(await probeAll(dir), (record) => recordPaths(dir, record.pid).sock),
    readLog: (logPath) => readTraces(logPath).traces,
    now: () => Date.now(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
  };
}

type CommonOptions = {
  log?: string;
  json?: boolean;
  trace?: string;
  last?: string;
  since?: string;
  all?: boolean;
};

function withCommonOptions(command: Command): Command {
  return command
    .option(
      "--log <file>",
      "The statelog or run directory to read (default: the open viewer's, else log.logFile)",
    )
    .option("--json", "Print JSON for a program to read instead of text")
    .option("--trace <id>", "The trace to read, a full id or unique prefix")
    .option("--last <n>", "The n traces that started most recently")
    .option("--since <when>", "Traces that started since a time: 30m, 2h, 3d, or an ISO date")
    .option("--all", "Every trace in the log");
}

/** The trace-picking flags as `selectTraces` takes them, or why not. */
function selectionFrom(options: CommonOptions): TraceSelectionFlags | { error: string } {
  const last = parseCount("--last", options.last);
  if ("error" in last) {
    return last;
  }
  return { trace: options.trace, last: last.value, since: options.since, all: options.all };
}

export function addLogsQueryCommands(logs: Command, deps: () => LogsQueryDeps): void {
  const run = async (
    options: CommonOptions,
    query: (selection: TraceSelectionFlags, queryDeps: QueryDeps) => Promise<QueryResult>,
  ): Promise<void> => {
    const queryDeps = deps();
    const selection = selectionFrom(options);
    const result =
      "error" in selection ? refusal(selection.error) : await query(selection, queryDeps);
    queryDeps.writeStdout(
      (options.json === true ? JSON.stringify(result.json, null, 2) : result.text) + "\n",
    );
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  };

  withCommonOptions(logs.command("traces").description("List the traces in a log, newest first"))
    .option("--errors", "Only traces that logged an error")
    .action((options: CommonOptions & { errors?: boolean }) =>
      run(options, (selection, queryDeps) =>
        logsTraces(
          {
            ...selection,
            log: options.log,
            json: options.json === true,
            errors: options.errors === true,
          },
          queryDeps,
        ),
      ),
    );

  withCommonOptions(
    logs
      .command("outline")
      .description("Print every row of a trace with its address (default: the most recent trace)"),
  )
    .option("--approvals", "Show approved interrupts, which are hidden by default")
    .option("--admin", "Show the handler decisions under each interrupt")
    .action((options: CommonOptions & { approvals?: boolean; admin?: boolean }) =>
      run(options, (selection, queryDeps) =>
        logsOutline(
          {
            ...selection,
            log: options.log,
            json: options.json === true,
            approvals: options.approvals === true,
            admin: options.admin === true,
          },
          queryDeps,
        ),
      ),
    );

  withCommonOptions(
    logs
      .command("search")
      .description(
        "Find the rows whose own text matches, with their addresses (default: the most recent trace). " +
          "Use `--` before a pattern that starts with a dash.",
      )
      .argument("<pattern>", "The text to find; a regular expression with --regex"),
  )
    .option("--kind <kinds>", "Only these kinds, comma separated: user,call,tool,hosted,error")
    .option("--regex", "Treat the pattern as a JavaScript regular expression")
    .option("--case-sensitive", "Match case (the default ignores it)")
    .option("--limit <n>", `Print at most n rows (default ${DEFAULT_SEARCH_LIMIT})`)
    .option(
      "--context <n>",
      `Characters of snippet on each side of the match (default ${DEFAULT_SNIPPET_CONTEXT})`,
    )
    .action(
      (
        pattern: string,
        options: CommonOptions & {
          kind?: string;
          regex?: boolean;
          caseSensitive?: boolean;
          limit?: string;
          context?: string;
        },
      ) =>
        run(options, (selection, queryDeps) =>
          logsSearch(
            {
              ...selection,
              pattern,
              log: options.log,
              json: options.json === true,
              kind: options.kind,
              regex: options.regex === true,
              caseSensitive: options.caseSensitive === true,
              limit: options.limit,
              context: options.context,
            },
            queryDeps,
          ),
        ),
    );
}
