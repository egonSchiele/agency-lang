// The host for a browser. It has a network, environment values, a
// terminal, and a model client, and refuses files, subprocesses, and the
// process exit: a browser page has none of those. Everything it answers
// comes from what the app passed in, or a fixed default.

import { nanoid } from "nanoid";
import { realClock } from "../runtime/clock.js";
import { consoleLogSink } from "../logger.js";
import {
  makeHost,
  PLATFORM_CAPABILITIES,
  UnsupportedOnHostError,
  type Capability,
  type Host,
  type HostEnv,
  type HostNetwork,
  type HostRandom,
  type HostSettings,
  type HostSystem,
  type HostTerminal,
  type MakeHostArgs,
} from "./host.js";

export type BrowserHostOptions = {
  /** Defaults to the browser's row in `PLATFORM_CAPABILITIES`. */
  capabilities?: Capability[];
  /** The variables `env.get` and `settings.read` answer from: the API
   *  keys and switches the app wants the program to see. */
  variables?: Record<string, string>;
  /** Where printed text goes. Without one, `print` and `writeOut` go to
   *  `console.log` and `writeErr` to `console.error`. */
  terminal?: Partial<HostTerminal>;
  /** What `network.fetch` answers with; the page's own `fetch` without. */
  fetch?: HostNetwork["fetch"];
  /** The working directory to report. "/" without. */
  cwd?: string;
  onUse?: MakeHostArgs["onUse"];
};

export function browserHost(options: BrowserHostOptions = {}): Host {
  const variables = { ...(options.variables ?? {}) };
  return makeHost({
    name: "browser",
    capabilities: options.capabilities ?? [...PLATFORM_CAPABILITIES.browser],
    onUse: options.onUse,
    parts: {
      network: { fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)) },
      env: browserEnv(variables),
      terminal: { ...consoleTerminal(), ...options.terminal },
      system: browserSystem(options.cwd ?? "/"),
      settings: {
        read: (name) => variables[name] ?? null,
        log: consoleLogSink,
      },
      clock: realClock,
      random: browserRandom(),
    },
  });
}

function browserEnv(variables: Record<string, string>): HostEnv {
  return {
    get: (name) => variables[name] ?? null,
    set: (name, value) => {
      variables[name] = value;
    },
    all: () => ({ ...variables }),
  };
}

function consoleTerminal(): HostTerminal {
  return {
    print: (values) => console.log(...values),
    writeOut: (text) => console.log(text),
    writeErr: (text) => console.error(text),
    readLine: async () => {
      throw new UnsupportedOnHostError({
        capability: "terminal",
        hostName: "browser",
        functionName: "terminal.readLine",
      });
    },
    readAll: async () => "",
    isInteractive: () => false,
    size: () => null,
    supportsColor: () => false,
  };
}

function browserSystem(cwd: string): HostSystem {
  return {
    operatingSystem: () => "unknown",
    cwd: () => cwd,
    homeDir: () => cwd,
    tempDir: () => "/tmp",
    args: () => [],
    processId: () => 1,
    // A module URL in a browser is http(s), or blob: for an inlined
    // bundle; the directory part of it serves the one caller, the
    // generated header's `__dirname`.
    moduleDir: (moduleUrl) => moduleUrl.replace(/[^/]*$/, ""),
    isMainModule: () => false,
    exit: (code) => {
      throw new Error(`exit(${code}): a browser page cannot end its process.`);
    },
    setTitle: () => {},
    parentChannel: () => null,
    onExit: () => {},
  };
}

function browserRandom(): HostRandom {
  return {
    id: () => nanoid(),
    bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  };
}
