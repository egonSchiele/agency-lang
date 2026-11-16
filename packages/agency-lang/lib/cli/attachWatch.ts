// `agency attach [pid]`: list the running programs, or watch one and
// answer the questions it holds. This is not the debugger: the program is
// never paused, and the client is a `watch`, which the run side serves in
// lib/debugger/attach/watch.ts. The design is docs/dev/runtime/spawn.md.
import { nodeHost } from "@/host/node/nodeHost.js";
import type { Channel } from "@/debugger/attach/channel.js";
import { parseAttachMessage } from "@/debugger/attach/protocol.js";
import {
  ensureSessionsDir,
  listRecords,
  recordPaths,
  removeStale,
  sessionsDir,
} from "@/debugger/attach/registry.js";
import type { HeldAnswer } from "@/runtime/heldQuestions.js";
import { buildDecider, type DecideFn } from "@/runtime/interruptResolution.js";
import type { SerializedInterrupt } from "@/runtime/ipcChild.js";
import {
  checkedRecord,
  connectWithRetry,
  CONNECT_RETRY_MS,
  formatListing,
  missingSocket,
} from "./attach.js";

export type WatchOptions = {
  channel: Channel;
  /** Where the lines for the person are written. */
  out: (text: string) => void;
  decide: DecideFn;
};

/** Watch the program on `channel`: answer each batch it holds, in order,
 *  and resolve when the connection closes. The answers to one batch go
 *  back in one message, because the program resumes a batch as a whole. */
export function watch(options: WatchOptions): Promise<void> {
  const { channel, out, decide } = options;
  channel.send({ type: "client", kind: "watch" });
  // One batch is answered at a time. A second `held` for the same batch
  // (the program repeats it after refusing a set of answers) waits for
  // the first to finish, so two prompts never share the terminal.
  let answering: Promise<void> = Promise.resolve();
  const answer = async (questions: SerializedInterrupt[]): Promise<void> => {
    const answers: HeldAnswer[] = [];
    for (const question of questions) {
      answers.push({ interruptId: question.interruptId, response: await decide(question) });
    }
    channel.send({ type: "answers", answers });
  };
  channel.onMessage((raw) => {
    const message = parseAttachMessage(raw);
    if (message?.type === "held" && message.questions.length > 0) {
      answering = answering.then(() => answer(message.questions));
    }
    if (message?.type === "answersRefused") {
      out(`The program refused the answers: ${message.reason}`);
    }
  });
  return new Promise((resolve) => {
    channel.onClose(() => {
      out("The program ended or closed the connection.");
      resolve();
    });
  });
}

export type AttachWatchOptions = {
  pid?: number;
  print?: (line: string) => void;
  printError?: (line: string) => void;
};

/** Run `agency attach`. Resolves with the exit code: 0 when the listing
 *  was printed or the program's connection closed, 1 on a refusal. */
export async function attachWatchCommand(options: AttachWatchOptions): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(line));
  const printError = options.printError ?? ((line: string) => console.error(line));
  const dir = sessionsDir(nodeHost());
  const refusal = ensureSessionsDir(dir);
  if (refusal !== null) {
    printError(`Error: ${refusal.refused}`);
    return 1;
  }
  const pid = options.pid;
  if (pid === undefined) {
    removeStale(dir, listRecords(dir));
    print(formatListing(listRecords(dir), Date.now(), process.cwd()));
    return 0;
  }
  // Checked before connecting: the prompt rejects a question when there
  // is no terminal, and a watch must never answer for the person.
  if (!process.stdin.isTTY) {
    printError("Error: attach asks for answers at the terminal, and stdin is not one.");
    return 1;
  }
  const record = checkedRecord(dir, pid);
  if ("refused" in record) {
    printError(`Error: ${record.refused}`);
    return 1;
  }
  const missing = missingSocket(dir, pid);
  if (missing !== null) {
    printError(`Error: ${missing}`);
    return 1;
  }
  let channel: Channel;
  try {
    channel = await connectWithRetry(pid, recordPaths(dir, pid).sock, CONNECT_RETRY_MS);
  } catch (error) {
    printError(`Error: ${(error as Error).message}`);
    return 1;
  }
  print(`Attached to pid ${pid} (${record.program}). Press Ctrl-C to detach.`);
  await watch({ channel, out: print, decide: buildDecider({ interactive: true }) });
  return 0;
}
