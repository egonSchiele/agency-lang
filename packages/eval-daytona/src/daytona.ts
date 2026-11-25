import { Daytona } from "@daytona/sdk";

import { quote } from "./shell.js";
import { DEFAULT_TIMEOUT_SEC, SandboxTimeoutError, type ExecResult, type Sandbox } from "./types.js";

export type DaytonaOptions = {
  /** For example "node:22-bookworm". */
  image: string;
  labels?: Record<string, string>;
  /** Default 4. */
  cpu?: number;
  /** Default 8. */
  memoryGb?: number;
  /** Default 10. */
  diskGb?: number;
  /** An idle sandbox stops after this long. Default 120. */
  autoStopMinutes?: number;
  /** A stopped sandbox is deleted after this long, so a runner that was
   *  killed before it could delete its sandbox leaks nothing for long.
   *  Default 240. */
  autoDeleteMinutes?: number;
};

export type SandboxSummary = {
  id: string;
  state: string;
  createdAt: string;
  labels: Record<string, string>;
};

const CREATE_TIMEOUT_SEC = 600;
const RETRY_DELAY_MS = 10_000;

/** The members of the Daytona SDK this file uses. */
type RemoteSandbox = {
  id: string;
  state?: string;
  createdAt?: string;
  labels: Record<string, string>;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      request: { command: string; runAsync?: boolean },
    ): Promise<unknown>;
  };
  fs: {
    uploadFile(file: Buffer, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
  };
};

type Client = {
  create(params: Record<string, unknown>, options: { timeout: number }): Promise<RemoteSandbox>;
  get(id: string): Promise<RemoteSandbox>;
  list(query?: { labels?: Record<string, string> }): AsyncIterable<RemoteSandbox>;
  delete(sandbox: RemoteSandbox): Promise<void>;
};

type Deps = {
  client?: Client;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function realClient(): Client {
  return new Daytona() as unknown as Client;
}

/** An error a second try cannot fix: a missing or wrong key, a bad image
 *  name. Matched by the SDK's class names. */
function willNotChange(error: unknown): boolean {
  const name = errorName(error);
  return /Authentication|Authorization|Forbidden|BadRequest|Validation|InvalidArgument|NotFound/.test(name);
}

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.constructor.name}` : "";
}

/** Creates a sandbox from an image. Creation is the most likely thing to
 *  fail for a passing reason (a quota, a slow pull), so it is tried twice. */
export async function createDaytonaSandbox(options: DaytonaOptions, deps: Deps = {}): Promise<Sandbox> {
  const client = deps.client ?? realClient();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const params: Record<string, unknown> = {
    image: options.image,
    labels: options.labels ?? {},
    resources: { cpu: options.cpu ?? 4, memory: options.memoryGb ?? 8, disk: options.diskGb ?? 10 },
    autoStopInterval: options.autoStopMinutes ?? 120,
    autoDeleteInterval: options.autoDeleteMinutes ?? 240,
  };
  let remote: RemoteSandbox;
  try {
    remote = await client.create(params, { timeout: CREATE_TIMEOUT_SEC });
  } catch (error) {
    // A creation that timed out may still have made its sandbox. The SDK
    // then names it on the error and does not delete it; nothing else
    // would either.
    const orphan = (error as { sandboxId?: unknown }).sandboxId;
    if (typeof orphan === "string" && orphan !== "") {
      await client
        .get(orphan)
        .then((left) => client.delete(left))
        .catch(() => {});
    }
    if (willNotChange(error)) {
      throw error;
    }
    await sleep(RETRY_DELAY_MS);
    remote = await client.create(params, { timeout: CREATE_TIMEOUT_SEC });
  }
  return adapt(client, remote, deps.now ?? Date.now);
}

/** Whether an SDK error means the command itself ran out of time. The
 *  SDK's connection and queue timeouts are the provider's trouble, not the
 *  command's, and so is any timeout that came back before the limit. */
function isCommandTimeout(error: unknown, elapsedMs: number, timeoutSec: number): boolean {
  const name = errorName(error);
  if (!/Timeout/.test(name) || /Connection|Queue/.test(name)) {
    return false;
  }
  // A little under the limit, for clocks that disagree.
  return elapsedMs >= timeoutSec * 950;
}

let sessionCounter = 0;

function adapt(client: Client, remote: RemoteSandbox, now: () => number): Sandbox {
  return {
    id: remote.id,
    async exec(command, options = {}): Promise<ExecResult> {
      const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      const started = now();
      try {
        const response = await remote.process.executeCommand(
          `bash -c ${quote(command)}`,
          undefined,
          undefined,
          timeoutSec,
        );
        return { exitCode: response.exitCode, output: response.result ?? "" };
      } catch (error) {
        // Anything but the command running out its own limit is the
        // provider failing, and is passed on as it is: a grader must not
        // score a dropped connection as the patch's failure.
        if (isCommandTimeout(error, now() - started, timeoutSec)) {
          throw new SandboxTimeoutError(command, timeoutSec);
        }
        throw error;
      }
    },
    async startBackground(command): Promise<void> {
      sessionCounter += 1;
      const session = `background-${Date.now()}-${sessionCounter}`;
      await remote.process.createSession(session);
      await remote.process.executeSessionCommand(session, { command, runAsync: true });
    },
    async upload(content, remotePath): Promise<void> {
      await remote.fs.uploadFile(content, remotePath);
    },
    async download(remotePath): Promise<Buffer> {
      return remote.fs.downloadFile(remotePath);
    },
    async delete(): Promise<void> {
      await client.delete(remote);
    },
  };
}

/** The sandboxes that carry every one of `labels`. */
export async function listDaytonaSandboxes(
  labels: Record<string, string>,
  deps: Deps = {},
): Promise<SandboxSummary[]> {
  const client = deps.client ?? realClient();
  const found: SandboxSummary[] = [];
  // The server filters; the check below is a safety net.
  for await (const remote of client.list({ labels })) {
    const carried = remote.labels ?? {};
    if (Object.entries(labels).every(([name, value]) => carried[name] === value)) {
      found.push({
        id: remote.id,
        state: remote.state ?? "",
        createdAt: remote.createdAt ?? "",
        labels: carried,
      });
    }
  }
  return found;
}

export async function deleteDaytonaSandbox(id: string, deps: Deps = {}): Promise<void> {
  const client = deps.client ?? realClient();
  await client.delete(await client.get(id));
}
