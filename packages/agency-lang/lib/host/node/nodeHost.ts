// The host for a Node process. It implements what Node can do and hands the
// parts to `makeHost`, which supplies the refusals for any capability left
// out. This file is Node-only: it may import Node modules freely.

import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { consoleLogSink } from "../../logger.js";
import { nodeFilesPart, type NodeFilesOptions } from "./nodeFilesPart.js";
import { nodeSubprocess } from "./nodeSubprocess.js";
import { realClock, type Clock } from "../../runtime/clock.js";
import {
  makeHost,
  PLATFORM_CAPABILITIES,
  type Capability,
  type Host,
  type HostEnv,
  type HostNetwork,
  type HostRandom,
  type HostSettings,
  type HostSystem,
  type HostTerminal,
  type MakeHostArgs,
  type OperatingSystem,
} from "../host.js";

export type NodeHostOptions = {
  /** Defaults to every capability Node has, `PLATFORM_CAPABILITIES.node`. */
  capabilities?: Capability[];
  /** Options for the file part; the symlink tests pass `seams`. */
  files?: NodeFilesOptions;
  /** Defaults to the global `fetch`. The test runner passes one that
   *  answers from its fetch mocks. */
  network?: HostNetwork;
  /** Defaults to the real clock. A test passes a `FakeClock`. */
  clock?: Clock;
  onUse?: MakeHostArgs["onUse"];
};

export function nodeHost(options: NodeHostOptions = {}): Host {
  return makeHost({
    name: "node",
    capabilities: options.capabilities ?? PLATFORM_CAPABILITIES.node,
    onUse: options.onUse,
    parts: {
      files: nodeFilesPart(options.files),
      network: options.network ?? nodeNetwork,
      subprocess: nodeSubprocess,
      env: nodeEnv,
      terminal: nodeTerminal,
      system: nodeSystem,
      settings: nodeSettings,
      clock: options.clock ?? realClock,
      random: nodeRandom,
    },
  });
}

// Read at the time of the call, not when this file loads, so a test that
// replaces the global `fetch` is honoured.
const nodeNetwork: HostNetwork = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

const nodeEnv: HostEnv = {
  get: (name) => process.env[name] ?? null,
  set: (name, value) => {
    process.env[name] = value;
  },
  // process.env can hold undefined for a variable deleted with `delete`;
  // a child's environment cannot.
  all: () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  },
};

const nodeSettings: HostSettings = {
  read: (name) => process.env[name] ?? null,
  // Through the console, not `process.stderr.write`: while a `std::ui` REPL
  // owns the screen it captures the console (`_installConsoleCapture` in
  // lib/stdlib/ui.ts) so messages land in its transcript. A raw write
  // would bypass that and tear the rendered frame. Outside a REPL the
  // console writes to standard error and standard output as before.
  log: consoleLogSink,
};

/** A blank line answered within this window of the prompt attaching cannot
 *  be a human reacting to the prompt (buffered lines arrive in ~1ms; human
 *  reaction to a newly-visible prompt is 150ms+). */
const BUFFERED_BLANK_LINE_MS = 25;

const nodeTerminal: HostTerminal = {
  // Through the console, for the same reason as `settings.log` above: the
  // REPL's console capture must see what `print` prints.
  print: (values) => console.log(...values),
  writeOut: (text) => {
    process.stdout.write(text);
  },
  writeErr: (text) => {
    process.stderr.write(text);
  },
  isInteractive: () => process.stdin.isTTY === true,
  size: () => {
    const { columns, rows } = process.stdout;
    if (columns === undefined || rows === undefined) {
      return null;
    }
    return { columns, rows };
  },
  // Read at the time of the call, so a test can set the variables.
  supportsColor: () => {
    const noColor = process.env.NO_COLOR;
    if (noColor !== undefined && noColor !== "") {
      return false;
    }
    const force = process.env.FORCE_COLOR;
    if (force !== undefined && force !== "" && force !== "0" && force !== "false") {
      return true;
    }
    return process.stdout.isTTY === true;
  },
  readLine: (prompt, signal) => {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve, reject) => {
      // Readline holds stdin exclusively, so a blocked read after Ctrl-C or
      // a race-loser abort would otherwise sit there forever.
      const onAbort = () => {
        try {
          rl.close();
        } catch {}
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const ask = () => {
        const askedAt = Date.now();
        rl.question(prompt, (answer: string) => {
          // A blank line that lands faster than a human could react to the
          // prompt was buffered while the program was busy — an Enter
          // pressed to check on a slow run, not an answer — and would
          // otherwise become an accidental (empty) submission. Discard it
          // and re-ask; the next buffered line (real type-ahead) is
          // delivered normally. Deliberate blank answers arrive after
          // human-scale delay and are kept. Only interactive stdin is
          // filtered: piped input legitimately arrives instantly. Real wall
          // clock on purpose — this measures I/O latency, and fake-clock
          // tests use inputOverride, never this path.
          if (
            answer === "" &&
            process.stdin.isTTY &&
            Date.now() - askedAt < BUFFERED_BLANK_LINE_MS
          ) {
            ask();
            return;
          }
          signal?.removeEventListener("abort", onAbort);
          rl.close();
          resolve(answer);
        });
      };
      ask();
    });
  },
};

let cachedOperatingSystem: OperatingSystem | null = null;

/**
 * The operating system, cached because it cannot change while the process
 * runs. Follows the popular Node packages (sindresorhus/open, is-wsl,
 * node-notifier): `process.platform` first, and on Linux a look in
 * /proc/version for "microsoft", because WSL reports itself as Linux.
 * Anything not darwin, win32, or linux is "unknown".
 */
function operatingSystem(): OperatingSystem {
  if (cachedOperatingSystem !== null) {
    return cachedOperatingSystem;
  }
  const p = process.platform;
  if (p === "darwin") {
    cachedOperatingSystem = "macos";
  } else if (p === "win32") {
    cachedOperatingSystem = "windows";
  } else if (p === "linux") {
    let version = "";
    try {
      version = readFileSync("/proc/version", "utf8");
    } catch {
      version = "";
    }
    cachedOperatingSystem = /microsoft/i.test(version) ? "wsl" : "linux";
  } else {
    cachedOperatingSystem = "unknown";
  }
  return cachedOperatingSystem;
}

const nodeSystem: HostSystem = {
  operatingSystem,
  cwd: () => process.cwd(),
  homeDir: () => os.homedir(),
  tempDir: () => os.tmpdir(),
  args: () => process.argv,
  processId: () => process.pid,
  moduleDir: (moduleUrl) => path.dirname(fileURLToPath(moduleUrl)),
  isMainModule: (moduleUrl) => process.argv[1] === fileURLToPath(moduleUrl),
  exit: (code) => process.exit(code),
  // Read at the time of the call: a test stands in for process.send.
  parentChannel: () => {
    const send = process.send;
    if (typeof send !== "function") {
      return null;
    }
    return {
      send: (message) => {
        send.call(process, message);
      },
    };
  },
  onExit: (fn) => {
    process.on("exit", fn);
  },
};

const nodeRandom: HostRandom = {
  id: () => nanoid(),
  bytes: (length) => new Uint8Array(randomBytes(length)),
};
