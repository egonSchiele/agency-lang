// `agency logs session …`: probe the registry, drop the dead records, work
// out the target, run the command, print. The commands themselves are in
// commands.ts and the target rules in target.ts; this file only sequences.
import { nodeHost } from "@/host/node/nodeHost.js";
import { request } from "@/logsViewer/session/client.js";
import {
  probeAll,
  recordPaths,
  removeStale,
  sessionsDir,
  type ProbedRecord,
} from "@/logsViewer/session/registry.js";
import type { SessionRecord } from "@/logsViewer/session/record.js";
import type { CommentAuthor } from "@/runDirectory/comments.js";
import { openCommentsStore } from "@/runDirectory/commentsStore.js";

import {
  commentAdd,
  comments,
  defaultCommandDeps,
  get,
  list,
  navigate,
  pick,
  show,
  type CommandDeps,
  type CommandResult,
} from "./commands.js";
import { resolveTarget, type TargetArgs, type TargetDeps } from "./target.js";

export type SessionCommand =
  | { name: "list" }
  | { name: "get" }
  | { name: "show" }
  | { name: "comments"; all: boolean }
  | { name: "comment add"; text: string; replyTo?: string }
  | { name: "navigate" }
  | { name: "pick" };

export type SessionCliOptions = TargetArgs & { json: boolean; author?: string };

export type SessionCliDeps = {
  sessionsDir: string;
  probe(dir: string): Promise<ProbedRecord[]>;
  commandDeps: CommandDeps;
  targetDeps: Omit<TargetDeps, "author">;
  writeStdout(text: string): void;
};

const AGENT_AUTHOR: CommentAuthor = { kind: "agent", id: "claude" };

export function defaultSessionCliDeps(): SessionCliDeps {
  const dir = sessionsDir(nodeHost());
  return {
    sessionsDir: dir,
    probe: probeAll,
    commandDeps: defaultCommandDeps(request),
    targetDeps: {
      socketPathFor: (record: SessionRecord) => recordPaths(dir, record.pid).sock,
      openStore: openCommentsStore,
      cwd: process.cwd(),
    },
    writeStdout: (text) => process.stdout.write(text),
  };
}

export async function logsSession(
  command: SessionCommand,
  options: SessionCliOptions,
  deps: SessionCliDeps = defaultSessionCliDeps(),
): Promise<number> {
  const probed = await deps.probe(deps.sessionsDir);
  removeStale(deps.sessionsDir, probed);
  const alive = probed.filter((entry) => entry.result.state !== "stale");
  const result = await run(command, options, alive, deps);
  deps.writeStdout(options.json ? JSON.stringify(result.json, null, 2) + "\n" : result.text + "\n");
  return result.exitCode;
}

async function run(
  command: SessionCommand,
  options: SessionCliOptions,
  probed: ProbedRecord[],
  deps: SessionCliDeps,
): Promise<CommandResult> {
  if (command.name === "list") {
    return list(probed);
  }
  const author: CommentAuthor =
    options.author === undefined ? AGENT_AUTHOR : { kind: "agent", id: options.author };
  const target = resolveTarget(options, probed, { ...deps.targetDeps, author });
  switch (command.name) {
    case "get":
      return get(target, deps.commandDeps);
    case "show":
      return show(target, deps.commandDeps);
    case "comments":
      return comments(target, command.all, deps.commandDeps);
    case "comment add":
      return commentAdd(target, command.text, { replyTo: command.replyTo }, deps.commandDeps);
    case "navigate":
      return navigate(target, deps.commandDeps);
    case "pick":
      return pick(target, deps.commandDeps);
  }
}
