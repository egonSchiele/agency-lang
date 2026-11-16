// What the tests that start a real `agency` process share. Nothing a test
// starts here can outlive it for long or be mistaken for another process:
// every process gets its own deadline, and a test stops one only through
// the handle it was given, never through a pid read from output.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Channel } from "@/debugger/attach/channel.js";
import { lineChannel } from "@/debugger/attach/lineChannel.js";
import type { AttachMessage, ClientKind } from "@/debugger/attach/protocol.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

/** The built command line. A test file skips itself when it is missing. */
export const CLI = path.resolve("dist/scripts/agency.js");

const POLL_MS = 10;
const DEFAULT_WAIT_MS = 2_000;
/** How long a process a test started may live. Longer than any one test. */
const PROCESS_DEADLINE_MS = 120_000;
/** The exit code of a process that reached its deadline. */
export const DEADLINE_EXIT_CODE = 86;
const DEADLINE_SCRIPT = "deadline.cjs";

/** A program that prints a line, writes `started.txt`, asks `test::ask`,
 *  and then writes `finished.txt`, or the reason it was refused to
 *  `rejected.txt`. Its own writes are approved in the program, so the only
 *  question nobody settles is `test::ask`. */
export const ASKS = `effect test::ask { label: string }

def ask(): string {
  return interrupt test::ask("May I open the door?", { label: "door" })
  return "opened"
}

node main() {
  print("about to ask")
  write(filename: "started.txt", content: "1", dir: ".") with approve
  const answer = ask()
  if (isFailure(answer)) {
    write(filename: "rejected.txt", content: answer.error, dir: ".") with approve
  } else {
    write(filename: "finished.txt", content: "1", dir: ".") with approve
  }
}
`;

/** A program that writes the messages of its first thread to
 *  `thread.json`. It makes no model call. */
export const WRITES_THREAD = `import { currentThreadId, getThread } from "std::thread"

node main() {
  const thread = getThread(currentThreadId())
  if (thread is success(messages)) {
    write(filename: "thread.json", content: JSON.stringify(messages), dir: ".") with approve
  } else {
    write(filename: "thread.json", content: "no thread", dir: ".") with approve
  }
}
`;

/** A seed conversation for `--messages`. */
export const SEED = [
  { role: "user", content: "the seed question" },
  { role: "assistant", content: "the seed answer" },
];

/** Resolve once `condition` holds, checking every few milliseconds, or
 *  throw naming `what` when `deadlineMs` passes first. */
export async function waitFor(
  condition: () => boolean,
  deadlineMs: number = DEFAULT_WAIT_MS,
  what: string = "the condition",
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function waitForFile(file: string, deadlineMs: number): Promise<void> {
  return waitFor(() => fs.existsSync(file), deadlineMs, file);
}

export type Throwaway = { dir: string; remove(): void };

/** A folder for `AGENCY_HOME`, so no test touches the real `~/.agency`.
 *  Under the OS temp folder, whose short path keeps the debug socket's
 *  path under the platform's limit. */
export function throwawayHome(): Throwaway {
  const root = os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, "agency-home-"));
  return { dir, remove: () => void safeDeleteDirectoryWithin(root, dir) };
}

/** A folder of fixture files under the working directory, where a
 *  compiled program can find `node_modules`. It also gets the script that
 *  gives every process started with `startCli` its deadline. */
export function fixtureFolder(prefix: string, files: Record<string, string>): Throwaway {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(root, prefix));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  fs.writeFileSync(
    path.join(dir, DEADLINE_SCRIPT),
    `setTimeout(() => process.exit(${DEADLINE_EXIT_CODE}), ${PROCESS_DEADLINE_MS}).unref();\n`,
  );
  return { dir, remove: () => void safeDeleteDirectoryWithin(root, dir) };
}

export type StartedCli = {
  child: ChildProcess;
  /** Everything the command and its program wrote, both streams. */
  output(): string;
  /** Resolves with the command's exit code. */
  exited: Promise<number | null>;
  /** Stop the command and the program it started. */
  stop(): void;
};

/** Start `agency <args>` in `dir`, in the background, with no terminal.
 *  The command and the program it starts share a process group of their
 *  own, so `stop` reaches both, and each exits by itself at its deadline
 *  if the test never stops it. */
export function startCli(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): StartedCli {
  // Quoted, for a working directory with a space in its path.
  const deadline = `--require "${path.join(dir, DEADLINE_SCRIPT)}"`;
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, deadline].filter(Boolean).join(" "),
    },
  });
  let text = "";
  child.stdout?.on("data", (chunk) => (text += String(chunk)));
  child.stderr?.on("data", (chunk) => (text += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    output: () => text,
    exited,
    stop: () => {
      // The group's id is the pid of the handle this function made.
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/** The debug sockets in `home` that are not in `known`. */
export function newSockets(home: string, known: string[] = []): string[] {
  const dir = path.join(home, "debug-sessions");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sock"))
    .map((name) => path.join(dir, name))
    .filter((sock) => !known.includes(sock));
}

/** The socket of the one program running under `home`, once it is open. */
export async function waitForSocket(
  home: string,
  deadlineMs: number,
  known: string[] = [],
): Promise<string> {
  await waitFor(() => newSockets(home, known).length > 0, deadlineMs, "the program's debug socket");
  return newSockets(home, known)[0]!;
}

export type TestClient = {
  channel: Channel;
  /** Every message the program has sent so far. */
  messages: AttachMessage[];
  /** Resolve with the first message, at or after index `from`, that
   *  `matches`. */
  next(
    matches: (message: AttachMessage) => boolean,
    from?: number,
    deadlineMs?: number,
  ): Promise<AttachMessage>;
  close(): void;
};

/** One connection attempt: the socket, or null when it was refused. */
function connectOnce(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const attempt = net.connect(socketPath);
    attempt.once("error", () => resolve(null));
    attempt.once("connect", () => {
      attempt.removeAllListeners("error");
      resolve(attempt);
    });
  });
}

/** Connect to a program's socket as a client of `kind`: `watch` for what
 *  `agency attach` is. */
export async function socketClient(
  socketPath: string,
  kind: ClientKind,
  deadlineMs: number,
): Promise<TestClient> {
  // The socket file appears a tick before the program takes connections,
  // so a refused attempt is tried again.
  const deadline = Date.now() + deadlineMs;
  let socket = await connectOnce(socketPath);
  while (socket === null) {
    if (Date.now() > deadline) {
      throw new Error(`timed out connecting to ${socketPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    socket = await connectOnce(socketPath);
  }
  const channel = lineChannel(socket);
  const messages: AttachMessage[] = [];
  channel.onMessage((message) => messages.push(message as AttachMessage));
  channel.send({ type: "client", kind });
  return {
    channel,
    messages,
    next: async (matches, from = 0, wait = deadlineMs) => {
      const found = (): AttachMessage | undefined => messages.slice(from).find(matches);
      await waitFor(() => found() !== undefined, wait, "a message from the program");
      return found()!;
    },
    close: () => channel.close(),
  };
}

export function watchClient(socketPath: string, deadlineMs: number): Promise<TestClient> {
  return socketClient(socketPath, "watch", deadlineMs);
}
