// `agency debug session …` on the command tree. The shared flags are
// declared on each leaf: the vendored commander gives a parent priority
// and refuses a flag that an ancestor already declares.
import type { Command } from "@/vendor/commander/index.js";

import { debugSession, type SessionCliCommand, type SessionCliOptions } from "./index.js";

type LeafOptions = { json?: boolean; pid?: string };

function withSharedOptions(command: Command): Command {
  return command
    .option("--json", "Print JSON for a program to read instead of text")
    .option("--pid <pid>", "The program to act on; with one held session, that one is meant");
}

function optionsFrom(options: LeafOptions): SessionCliOptions | { refused: string } {
  if (options.pid !== undefined && !/^\d+$/.test(options.pid)) {
    return { refused: `--pid takes a process id, not "${options.pid}"` };
  }
  return {
    json: options.json === true,
    pid: options.pid === undefined ? undefined : Number(options.pid),
  };
}

async function exitWith(command: SessionCliCommand, options: LeafOptions): Promise<void> {
  const parsed = optionsFrom(options);
  if ("refused" in parsed) {
    console.error(`Error: ${parsed.refused}`);
    process.exitCode = 1;
    return;
  }
  const code = await debugSession(command, parsed);
  if (code !== 0) {
    process.exitCode = code;
  }
}

/** `30s`, `2m`, `1h`, or milliseconds. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return amount;
  }
}

export function addDebugSessionCommands(debug: Command): void {
  const session = debug
    .command("session")
    .description(
      "Drive the debugger on a running program one command at a time, for a script or an agent",
    );

  withSharedOptions(
    session
      .command("list")
      .description("The programs that can take a debugger, and who is on each"),
  ).action(async (options: LeafOptions) => exitWith({ name: "list" }, options));

  withSharedOptions(
    session
      .command("attach")
      .description("Open a session on a running program; it stops at its next statement")
      .argument("<pid>", "The program's process id"),
  ).action(async (pid: string, options: LeafOptions) => {
    if (!/^\d+$/.test(pid)) {
      console.error(`Error: attach takes a process id, not "${pid}"`);
      process.exitCode = 1;
      return;
    }
    await exitWith({ name: "attach", pid: Number(pid) }, options);
  });

  addReaders(session);
  addMoves(session);
}

/** The verbs that print a part of the stop and move nothing. */
function addReaders(session: Command): void {
  withSharedOptions(
    session
      .command("where")
      .description("Where the program is: the stop, the stack, the threads, the guards"),
  ).action(async (options: LeafOptions) => exitWith({ name: "where" }, options));

  withSharedOptions(
    session
      .command("frame")
      .description("The stopped frame, or frame n of the stack: its arguments and locals")
      .argument("[n]", "The frame's number from `stack`")
      .option("--globals", "Add the module's globals"),
  ).action(async (index: string | undefined, options: LeafOptions & { globals?: boolean }) =>
    exitWith(
      {
        name: "frame",
        index: index === undefined ? undefined : Number(index),
        globals: options.globals === true,
      },
      options,
    ),
  );

  withSharedOptions(session.command("stack").description("Every frame, numbered")).action(
    async (options: LeafOptions) => exitWith({ name: "stack" }, options),
  );

  withSharedOptions(
    session.command("threads").description("Every thread, the active one marked"),
  ).action(async (options: LeafOptions) => exitWith({ name: "threads" }, options));

  withSharedOptions(
    session
      .command("thread")
      .description("A thread's messages, the active thread by default")
      .argument("[label]", "The thread's label or id")
      .option("--last <n>", "How many of the latest messages to print", "10"),
  ).action(async (label: string | undefined, options: LeafOptions & { last: string }) =>
    exitWith({ name: "thread", label, last: Number(options.last) }, options),
  );

  withSharedOptions(
    session
      .command("branches")
      .description("The tool calls, forks, and parallel items under the stop"),
  ).action(async (options: LeafOptions) => exitWith({ name: "branches" }, options));

  withSharedOptions(
    session
      .command("branch")
      .description("One branch's stack")
      .argument("<key>", "The branch's key from `branches`"),
  ).action(async (key: string, options: LeafOptions) => exitWith({ name: "branch", key }, options));

  withSharedOptions(
    session
      .command("guards")
      .description("Every guard, spent against limit, and the tool loop's state"),
  ).action(async (options: LeafOptions) => exitWith({ name: "guards" }, options));

  withSharedOptions(
    session
      .command("source")
      .description("The statement and the lines around it")
      .option("--context <n>", "Lines either side", "3"),
  ).action(async (options: LeafOptions & { context: string }) =>
    exitWith({ name: "source", context: Number(options.context) }, options),
  );

  withSharedOptions(
    session.command("checkpoints").description("The rolling window and the pinned checkpoints"),
  ).action(async (options: LeafOptions) => exitWith({ name: "checkpoints" }, options));
}

/** The verbs that answer the stop, wait on the program, or end the
 *  session. */
function addMoves(session: Command): void {
  for (const name of ["step", "next", "in", "out", "continue", "back"] as const) {
    const descriptions = {
      step: "One statement, stepping into calls",
      next: "One statement, over calls",
      in: "Step into the call",
      out: "Step out of the function",
      continue: "Run until the next debugger() statement or the end",
      back: "Step back one checkpoint",
    };
    withSharedOptions(session.command(name).description(descriptions[name])).action(
      async (options: LeafOptions) => exitWith({ name }, options),
    );
  }

  withSharedOptions(
    session
      .command("wait")
      .description("Block until the program stops or ends, then print where it is")
      .option("--for <duration>", "How long to wait (30s, 5m, 1h)", "5m"),
  ).action(async (options: LeafOptions & { for: string }) => {
    const forMs = parseDuration(options.for);
    if (forMs === null) {
      console.error(`Error: --for takes a duration such as 30s or 5m, not "${options.for}"`);
      process.exitCode = 1;
      return;
    }
    await exitWith({ name: "wait", forMs }, options);
  });

  withSharedOptions(
    session.command("pause").description("Ask a running program to stop at its next statement"),
  ).action(async (options: LeafOptions) => exitWith({ name: "pause" }, options));

  withSharedOptions(
    session
      .command("rewind")
      .description("Rewind to a checkpoint from `checkpoints`")
      .argument("<id>", "The checkpoint's id"),
  ).action(async (id: string, options: LeafOptions) =>
    exitWith({ name: "rewind", id: Number(id) }, options),
  );

  withSharedOptions(
    session
      .command("set")
      .description("Queue a local's new value for the next resume")
      .argument("<name>", "The local")
      .argument("<json>", "Its new value, as JSON"),
  ).action(async (varName: string, json: string, options: LeafOptions) => {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      console.error(`Error: the value must be JSON, not ${json}`);
      process.exitCode = 1;
      return;
    }
    await exitWith({ name: "set", varName, value }, options);
  });

  withSharedOptions(
    session
      .command("checkpoint")
      .description("Pin the current checkpoint")
      .argument("[label]", "A label for it"),
  ).action(async (label: string | undefined, options: LeafOptions) =>
    exitWith({ name: "checkpoint", label }, options),
  );

  withSharedOptions(
    session
      .command("save")
      .description("Save the checkpoint to a file, in the program's directory")
      .argument("<path>"),
  ).action(async (filePath: string, options: LeafOptions) =>
    exitWith({ name: "save", path: filePath }, options),
  );

  withSharedOptions(
    session
      .command("load")
      .description("Load a checkpoint from a file and rewind to it")
      .argument("<path>"),
  ).action(async (filePath: string, options: LeafOptions) =>
    exitWith({ name: "load", path: filePath }, options),
  );

  withSharedOptions(
    session
      .command("answer")
      .description(
        "Answer the question the program is waiting on: a guard trip, a node's arguments, or input()",
      )
      .argument("<json>", "The answer, as JSON"),
  ).action(async (json: string, options: LeafOptions) => {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      console.error(`Error: answer takes JSON, not "${json}"`);
      process.exitCode = 1;
      return;
    }
    await exitWith({ name: "answer", value }, options);
  });

  withSharedOptions(
    session
      .command("detach")
      .description(
        "Release the CLI's hold on the session; with no terminal debugger attached, the program runs on",
      ),
  ).action(async (options: LeafOptions) => exitWith({ name: "detach" }, options));
}
