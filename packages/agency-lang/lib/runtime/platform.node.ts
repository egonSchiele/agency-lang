// The runtime hooks that differ by platform and are not the host's
// business: loading provider modules from disk, the coverage collector, the
// statelog client's log file, and resolving a local model. The runtime
// imports this file as "#platform", an entry in the "imports" field of
// package.json that resolves here by default and to platform.browser.ts
// under the "browser" condition. Each export here has the same name and
// type there.

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { isMainThread } from "worker_threads";
import {
  ensureSessionsDir,
  listRecords,
  removeRecord,
  removeStale,
  sessionsDir,
  writeRecord,
  type AttachRecord,
} from "../debugger/attach/registry.js";
import { startAttachServer } from "../debugger/attach/server.js";
import { CoverageCollector } from "./coverageCollector.js";
import type { AttachFunctions } from "./attachedDebugger.js";
import { ensureConfiguredLocalProvider } from "./localProvider.js";
import { loadProviderModules } from "./providerModules.js";
import { _resolveLocalEmbeddingModel } from "../stdlib/localModels.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import type { ProviderLoadingContext, RegisterAttachArgs } from "./platform.js";

/** Registers the configured LLM providers before a run starts: the
 *  modules named in `agency.json` and AGENCY_PROVIDER_MODULES, and the
 *  llama-cpp provider when the config routes calls to it. */
export async function loadConfiguredProviders(execCtx: ProviderLoadingContext): Promise<void> {
  await loadProviderModules(execCtx);
  await ensureConfiguredLocalProvider(execCtx);
}

/** A collector for step coverage, which `write` saves as a file. */
export function newCoverageCollector(): CoverageCollector {
  return new CoverageCollector();
}

/** A function that appends one line to the file at `filePath`,
 *  synchronously, making the parent directory first. For the statelog
 *  client's log file, which a test reads right after an awaited event. */
export function openLineSink(filePath: string): (line: string) => void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return (line) => {
    appendFileSync(filePath, line + "\n");
  };
}

/** The model a local provider serves for an embedding target: a .gguf
 *  path for llama-cpp, the served name for mlx. */
export function resolveLocalEmbeddingModel(provider: string, model: string): Promise<string> {
  return _resolveLocalEmbeddingModel(provider, model);
}

/** The environment variable that keeps a program from registering for
 *  attach at all. Set to "1", like AGENCY_IPC, for a host that does not
 *  want a debug socket opened in its process. */
export const NO_ATTACH_VAR = "AGENCY_NO_ATTACH";

/** The attach target this process serves, shared by every copy of the
 *  runtime in it. A process can hold more than one copy (a test worker
 *  re-evaluates modules per file; a package can be under node_modules
 *  twice), and `startAttachServer` removes a socket at its own pid's
 *  path before listening, so two copies each opening a server would
 *  fight over one path. The first registration opens the server; every
 *  registration sets the functions, so the context that most recently
 *  started a node is the one a debugger gets. A TypeScript program that
 *  imports two Agency modules, or a test worker that runs many fixtures,
 *  has several contexts in one process, and the one running now is the
 *  one a person attaching now means. */
const ATTACH_TARGET_SLOT = Symbol.for("agency.debug.attachTarget");
type SharedAttachTarget = { functions: AttachFunctions };

function sharedAttachTarget(): SharedAttachTarget | null {
  const slot = process as unknown as Record<symbol, SharedAttachTarget | undefined>;
  return slot[ATTACH_TARGET_SLOT] ?? null;
}

function setSharedAttachTarget(target: SharedAttachTarget): void {
  const slot = process as unknown as Record<symbol, SharedAttachTarget | undefined>;
  slot[ATTACH_TARGET_SLOT] = target;
}

/** A sessions directory this process was refused, so a program that runs
 *  a node in a loop does not repeat the check and the log line each
 *  time. */
let refusedDir: string | null = null;

/** Make the program attachable: sweep the records of programs that have
 *  exited, write this one's record in the sessions directory, and listen
 *  on its debug socket (docs/dev/cli/debugger-attach.md). Called by
 *  `runNode` for every node run, and returns at once when: this process
 *  already registered; the host is not the Node host, so a memory host in
 *  a test writes nothing; a debugger is already installed, so `agency
 *  debug` does not register its own process and a second debugger cannot
 *  attach over the first; the process is an IPC child of a parent Agency
 *  program (`AGENCY_IPC`, which the parent sets; any child process with
 *  an IPC channel, such as a test worker, is not one), which the listing
 *  leaves out; or `AGENCY_NO_ATTACH` is "1". A sessions directory that
 *  cannot be used, or a socket that cannot be opened, is logged under
 *  DEBUG and the run goes on without attach: a program must never fail,
 *  or print, because it cannot be debugged. When the socket fails the
 *  record is removed with it, so the listing shows only programs a
 *  debugger can reach. Until this change the socket was opened on
 *  SIGUSR2, and nodemon, which restarts a child with that signal, left
 *  the program running with its debugger open instead. */
export function registerAttach({ ctx, nodeName, host, functions }: RegisterAttachArgs): void {
  // A worker thread's `process.on` never saw the signal, and a socket
  // opened there would name the main thread's pid. Such a program is
  // not listed.
  if (
    host.name !== "node" ||
    ctx.hasDebugger() ||
    isIpcMode(host) ||
    !isMainThread ||
    host.settings.read(NO_ATTACH_VAR) === "1"
  ) {
    return;
  }
  const shared = sharedAttachTarget();
  if (shared !== null) {
    shared.functions = functions;
    return;
  }
  const dir = sessionsDir(host);
  if (refusedDir === dir) {
    return;
  }
  const refusal = ensureSessionsDir(dir);
  if (refusal !== null) {
    refusedDir = dir;
    debugLine(`not attachable: ${refusal.refused}`);
    return;
  }
  // A program ended by a signal, as a supervisor's restart does, never
  // runs its exit hook and leaves its record and socket behind; only the
  // CLI's listing removed them before.
  removeStale(dir, listRecords(dir));
  const record: AttachRecord = {
    pid: process.pid,
    program: process.argv[1] ?? "",
    node: nodeName,
    // The wall-clock time the process started. Not `Date.now() -
    // process.uptime()`: uptime runs on a monotonic clock that stops
    // while the machine sleeps, so a program whose first node ran after
    // a suspend would look as if it started later than it did.
    startedAt: Math.round(performance.timeOrigin),
  };
  try {
    writeRecord(dir, record);
  } catch (error) {
    debugLine(`not attachable: could not write the record: ${(error as Error).message}`);
    return;
  }
  const target: SharedAttachTarget = { functions };
  setSharedAttachTarget(target);
  const failed = (reason: string): void => {
    debugLine(`not attachable: ${reason}`);
    removeRecord(dir, record.pid);
  };
  // The server reads the target when a debugger connects, so the context
  // running then is the one it attaches to. `startAttachServer` is
  // async, so a throw before its first await is a rejection too, and
  // both arms here keep a failure out of the program: an unhandled
  // rejection would end it.
  void startAttachServer({ dir, record, functions: () => target.functions }).then(
    (started) => {
      if ("unavailable" in started) {
        failed(started.unavailable);
      }
    },
    (error: unknown) => {
      failed(
        `could not open the debug socket: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  host.system.onExit(() => removeRecord(dir, record.pid));
}

function debugLine(message: string): void {
  if (process.env.DEBUG !== undefined && process.env.DEBUG !== "") {
    console.error(`[agency debug] ${message}`);
  }
}
