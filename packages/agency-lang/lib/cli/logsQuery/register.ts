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

/** What commander hands an action: every flag by its camelCase name. */
type ParsedOptions = Record<string, string | boolean | undefined>;

/** The options every query command shares, parsed. */
type CommonOptions = TraceSelectionFlags & { log?: string; json: boolean };

type OptionSpec = { flags: string; description: string };

/** One query command: its name, help, positional argument, own flags, and
 *  how it runs on the shared options and its own. Adding a command is
 *  adding a row. */
type QueryCommand = {
  name: string;
  description: string;
  argument?: OptionSpec;
  options: OptionSpec[];
  run(
    common: CommonOptions,
    own: ParsedOptions,
    argument: string | undefined,
    deps: QueryDeps,
  ): Promise<QueryResult>;
};

const COMMON_OPTIONS: OptionSpec[] = [
  {
    flags: "--log <file>",
    description:
      "The statelog or run directory to read (default: the open viewer's, else log.logFile)",
  },
  { flags: "--json", description: "Print JSON for a program to read instead of text" },
  { flags: "--trace <id>", description: "The trace to read, a full id or unique prefix" },
  { flags: "--last <n>", description: "The n traces that started most recently" },
  {
    flags: "--since <when>",
    description: "Traces that started since a time: 30m, 2h, 3d, or an ISO date",
  },
  { flags: "--all", description: "Every trace in the log" },
];

const QUERY_COMMANDS: QueryCommand[] = [
  {
    name: "traces",
    description: "List the traces in a log, newest first",
    options: [{ flags: "--errors", description: "Only traces that logged an error" }],
    run: (common, own, _argument, deps) =>
      logsTraces({ ...common, errors: own.errors === true }, deps),
  },
  {
    name: "outline",
    description: "Print every row of a trace with its address (default: the most recent trace)",
    options: [
      {
        flags: "--approvals",
        description: "Show approved interrupts, which are hidden by default",
      },
      {
        flags: "--admin",
        description:
          "Show the handler decisions under each interrupt, and with them the approved interrupts they decided",
      },
    ],
    run: (common, own, _argument, deps) =>
      logsOutline(
        { ...common, approvals: own.approvals === true, admin: own.admin === true },
        deps,
      ),
  },
  {
    name: "search",
    description:
      "Find the rows whose own text matches, with their addresses (default: the most recent trace). " +
      "Use `--` before a pattern that starts with a dash.",
    argument: {
      flags: "<pattern>",
      description: "The text to find; a regular expression with --regex",
    },
    options: [
      {
        flags: "--kind <kinds>",
        description: "Only these kinds, comma separated: user,call,tool,hosted,error",
      },
      { flags: "--regex", description: "Treat the pattern as a JavaScript regular expression" },
      { flags: "--case-sensitive", description: "Match case (the default ignores it)" },
      {
        flags: "--limit <n>",
        description: `Print at most n rows (default ${DEFAULT_SEARCH_LIMIT})`,
      },
      {
        flags: "--context <n>",
        description: `Characters of snippet on each side of the match (default ${DEFAULT_SNIPPET_CONTEXT})`,
      },
    ],
    run: (common, own, pattern, deps) =>
      logsSearch(
        {
          ...common,
          pattern: pattern ?? "",
          kind: textOf(own.kind),
          regex: own.regex === true,
          caseSensitive: own.caseSensitive === true,
          limit: textOf(own.limit),
          context: textOf(own.context),
        },
        deps,
      ),
  },
];

function textOf(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The shared options as the commands take them, or why not. */
function commonFrom(options: ParsedOptions): CommonOptions | { error: string } {
  const last = parseCount("--last", textOf(options.last));
  if ("error" in last) {
    return last;
  }
  return {
    log: textOf(options.log),
    json: options.json === true,
    trace: textOf(options.trace),
    last: last.value,
    since: textOf(options.since),
    all: options.all === true ? true : undefined,
  };
}

export function addLogsQueryCommands(logs: Command, deps: () => LogsQueryDeps): void {
  for (const query of QUERY_COMMANDS) {
    const command = logs.command(query.name).description(query.description);
    if (query.argument !== undefined) {
      command.argument(query.argument.flags, query.argument.description);
    }
    for (const option of [...COMMON_OPTIONS, ...query.options]) {
      command.option(option.flags, option.description);
    }
    // Commander passes the positional argument (when there is one), then
    // the parsed options, then the command.
    command.action(async (...args: unknown[]) => {
      const options = args[args.length - 2] as ParsedOptions;
      const argument = query.argument === undefined ? undefined : (args[0] as string);
      const queryDeps = deps();
      const common = commonFrom(options);
      const result =
        "error" in common
          ? refusal(common.error)
          : await query.run(common, options, argument, queryDeps);
      queryDeps.writeStdout(
        (options.json === true ? JSON.stringify(result.json, null, 2) : result.text) + "\n",
      );
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    });
  }
}
