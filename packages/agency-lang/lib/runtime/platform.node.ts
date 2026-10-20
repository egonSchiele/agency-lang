// The runtime hooks that differ by platform and are not the host's
// business: loading provider modules from disk, the coverage collector, the
// statelog client's log file, and resolving a local model. The runtime
// imports this file as "#platform", an entry in the "imports" field of
// package.json that resolves here by default and to platform.browser.ts
// under the "browser" condition. Each export here has the same name and
// type there.

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import {
  ensureSessionsDir,
  removeRecord,
  sessionsDir,
  writeRecord,
  type AttachRecord,
} from "../debugger/attach/registry.js";
import { startAttachServer, type AttachServer } from "../debugger/attach/server.js";
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

/** The signal that asks a running program to open its debug socket.
 *  Node reserves SIGUSR1 for its own inspector, whose port any local
 *  user can reach, so Agency does not touch it. */
export const ATTACH_SIGNAL = "SIGUSR2";

/** The record and the signal listener are per process, written once by
 *  the first node run; the context a debugger attaches to is the one that
 *  most recently started a node. A TypeScript program that imports two
 *  Agency modules, or a test worker that runs many fixtures, has several
 *  contexts in one process, and the one running now is the one a person
 *  attaching now means. */
let attachTarget: { functions: AttachFunctions; pid: number } | null = null;

/** A sessions directory this process was refused, so a program that runs
 *  a node in a loop does not repeat the check and the log line each
 *  time. */
let refusedDir: string | null = null;

/** Where the process keeps its one attach listener. A process can hold
 *  more than one copy of the runtime (a test worker re-evaluates modules
 *  per file; a program can have the package twice in node_modules), and
 *  each copy has its own `attachTarget`. The signal must reach one
 *  listener, the copy that most recently registered, or two servers would
 *  race for one socket and the loser would answer with a context whose
 *  modules it cannot see. Every registration claims the slot, so copies
 *  registering A, B, A leave A's listener in place. */
const ATTACH_LISTENER_SLOT = Symbol.for("agency.debug.attachListener");
let attachListener: (() => void) | null = null;

function claimAttachListener(listener: () => void): void {
  const slot = process as unknown as Record<symbol, (() => void) | undefined>;
  const previous = slot[ATTACH_LISTENER_SLOT];
  if (previous === listener) {
    return;
  }
  if (previous !== undefined) {
    process.removeListener(ATTACH_SIGNAL, previous);
  }
  slot[ATTACH_LISTENER_SLOT] = listener;
  process.on(ATTACH_SIGNAL, listener);
}

/** Make the program attachable: write its record in the sessions
 *  directory, listen for `ATTACH_SIGNAL`, and open the debug socket when
 *  it arrives (docs/dev/cli/debugger-attach.md). Called by `runNode` for
 *  every node run, and returns at once when: this process already
 *  registered; the host is not the Node host, so a memory host in a test
 *  writes nothing; a debugger is already installed, so `agency debug`
 *  does not register its own process and a second debugger cannot attach
 *  over the first; or the process is an IPC child of a parent Agency
 *  program (`AGENCY_IPC`, which the parent sets; any child process with
 *  an IPC channel, such as a test worker, is not one), which the listing
 *  leaves out. A sessions directory that
 *  cannot be used is logged under DEBUG and the run goes on without
 *  attach: a program must never fail because it cannot be debugged. */
export function registerAttach({ ctx, nodeName, host, functions }: RegisterAttachArgs): void {
  if (host.name !== "node" || ctx.hasDebugger() || isIpcMode(host)) {
    return;
  }
  if (attachTarget !== null) {
    attachTarget.functions = functions;
    if (attachListener !== null) {
      claimAttachListener(attachListener);
    }
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
  const record: AttachRecord = {
    pid: process.pid,
    program: process.argv[1] ?? "",
    node: nodeName,
    startedAt: Date.now() - process.uptime() * 1000,
  };
  try {
    writeRecord(dir, record);
  } catch (error) {
    debugLine(`not attachable: could not write the record: ${(error as Error).message}`);
    return;
  }
  const target = { functions, pid: record.pid };
  attachTarget = target;
  let server: AttachServer | null = null;
  const listener = (): void => {
    if (server !== null) {
      return;
    }
    // The server reads the target when a debugger connects, so the
    // context running then is the one it attaches to.
    void startAttachServer({ dir, record, functions: () => target.functions }).then((started) => {
      if ("unavailable" in started) {
        console.error(`[agency debug] ${started.unavailable}`);
        return;
      }
      server = started;
    });
  };
  attachListener = listener;
  claimAttachListener(listener);
  host.system.onExit(() => removeRecord(dir, record.pid));
}

function debugLine(message: string): void {
  if (process.env.DEBUG !== undefined && process.env.DEBUG !== "") {
    console.error(`[agency debug] ${message}`);
  }
}
