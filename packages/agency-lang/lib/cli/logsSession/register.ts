// `agency logs session …` on the command tree. The shared flags are declared
// on each leaf: the vendored commander gives a parent priority and refuses
// a flag that an ancestor already declares, which is why the trace flag here
// is `--trace` (as `logs extract` has it) and not the `--trace-id` of `logs`.
import type { Command } from "@/vendor/commander/index.js";

import { logsSession, type SessionCliOptions, type SessionCommand } from "./index.js";

type LeafOptions = { json?: boolean; log?: string; trace?: string; author?: string };

function withSharedOptions(command: Command): Command {
  return command
    .option("--json", "Print JSON for a program to read instead of text")
    .option("--log <file>", "The statelog to act on; also picks the viewer that has it open")
    .option("--trace <id>", "The trace a bare row id belongs to (a full id or unique prefix)");
}

function optionsFrom(options: LeafOptions, row?: string): SessionCliOptions {
  return {
    json: options.json === true,
    log: options.log,
    traceId: options.trace,
    author: options.author,
    row,
  };
}

async function exitWith(command: SessionCommand, options: SessionCliOptions): Promise<void> {
  const code = await logsSession(command, options);
  if (code !== 0) {
    process.exitCode = code;
  }
}

export function addLogsSessionCommands(logs: Command): void {
  const session = logs
    .command("session")
    .description("Talk to an open logs viewer, or to a log's comments on disk");

  withSharedOptions(
    session.command("list").description("The open viewers, with what each is looking at"),
  ).action(async (options: LeafOptions) => exitWith({ name: "list" }, optionsFrom(options)));

  withSharedOptions(
    session.command("get").description("The row under the viewer's cursor, expanded"),
  ).action(async (options: LeafOptions) => exitWith({ name: "get" }, optionsFrom(options)));

  withSharedOptions(
    session
      .command("show")
      .description("One row, expanded, with its comments")
      .argument("<row>", "An address <trace id>/<row id>, or a row id with --trace"),
  ).action(async (row: string, options: LeafOptions) =>
    exitWith({ name: "show" }, optionsFrom(options, row)),
  );

  withSharedOptions(
    session
      .command("comments")
      .description("Every comment on the current trace, each with its row expanded")
      .option("--all", "Every trace in the log, grouped"),
  ).action(async (options: LeafOptions & { all?: boolean }) =>
    exitWith({ name: "comments", all: options.all === true }, optionsFrom(options)),
  );

  withSharedOptions(
    session
      .command("navigate")
      .description("Move the open viewer's cursor to a row, or open a trace on its first row")
      .argument("<row>", "An address <trace id>/<row id>, a row id with --trace, or a trace id"),
  ).action(async (row: string, options: LeafOptions) =>
    exitWith({ name: "navigate" }, optionsFrom(options, row)),
  );

  withSharedOptions(
    session.command("pick").description("Put the open viewer on its list of traces"),
  ).action(async (options: LeafOptions) => exitWith({ name: "pick" }, optionsFrom(options)));

  const comment = session.command("comment").description("Leave a comment on a row");
  withSharedOptions(
    comment
      .command("add")
      .description("Write a comment on a row, and tell an open viewer to show it")
      .argument("<row>", "An address <trace id>/<row id>, or a row id with --trace")
      .argument("<text>", "The comment")
      .option("--reply-to <id>", "The comment this one answers")
      .option("--author <name>", "Who is writing (default: claude)"),
  ).action(async (row: string, text: string, options: LeafOptions & { replyTo?: string }) =>
    exitWith({ name: "comment add", text, replyTo: options.replyTo }, optionsFrom(options, row)),
  );
}
