// The host: everything the runtime and the stdlib need from the platform
// they run on. A Node process, a browser, and a test each build one. See
// docs/dev/runtime/host.md and docs/superpowers/specs/2026-10-05-host-and-platforms.md.
//
// This file imports no Node module and uses no Node global, because every
// platform's entry point reaches it.

import type { Clock } from "../runtime/clock.js";
import type { LogLevel } from "../logger.js";

/** The seven things a host may lack or refuse. An effect declaration names
 *  the ones its function needs with the `@capabilities(...)` tag, and the
 *  compiler checks them against the platform being compiled for. */
export const CAPABILITIES = [
  "fileRead",
  "fileWrite",
  "network",
  "subprocess",
  "env",
  "terminal",
  "llm",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The platforms a program can be compiled for. */
export type Platform = "node" | "browser";

/** Which capabilities each platform has. The compiler reads this to refuse
 *  a program that needs more than its platform can give, and the default
 *  host of each platform reads it to grant the same list. One table, so the
 *  two cannot disagree. */
export const PLATFORM_CAPABILITIES: Record<Platform, Capability[]> = {
  node: ["fileRead", "fileWrite", "network", "subprocess", "env", "terminal", "llm"],
  browser: ["network", "env", "terminal", "llm"],
};

/** The operating system a host runs on. `browserHost` reports `"unknown"`. */
export type OperatingSystem = "macos" | "linux" | "windows" | "wsl" | "unknown";

/** What the Agency functions `env` and `setEnv` read and write. This is a
 *  capability because it hands any variable to the program, and so to an
 *  agent. The runtime's own reads go through `settings` instead. */
export type HostEnv = {
  get(name: string): string | null;
  set(name: string, value: string): void;
};

/** The terminal, for `print`, `input`, and the stdlib functions that write
 *  to standard output or standard error. */
export type HostTerminal = {
  /** Print values on one line, the way `print` in Agency does. The values
   *  are not strings: a host formats them. `nodeHost` hands them to
   *  `console.log`, so an object prints the way Node prints it. */
  print(values: unknown[]): void;
  /** Write text to standard output, with no newline added. */
  writeOut(text: string): void;
  /** Write text to standard error, with no newline added. */
  writeErr(text: string): void;
  /** Show `prompt` and read one line. Rejects with the signal's reason when
   *  `signal` aborts while waiting. */
  readLine(prompt: string, signal?: AbortSignal): Promise<string>;
  /** Whether a person is at the terminal. False under a pipe or in CI. */
  isInteractive(): boolean;
};

/** Facts about the process and the machine. Every host has these, so they
 *  are not a capability. `browserHost` answers each with a value the app
 *  gave it or a fixed default, and refuses only `exit`. */
export type HostSystem = {
  operatingSystem(): OperatingSystem;
  cwd(): string;
  homeDir(): string;
  tempDir(): string;
  /** The command line, as Node gives it: the runtime, the script, then the
   *  program's own arguments. */
  args(): string[];
  processId(): number;
  /** The directory of the module whose `import.meta.url` is given. */
  moduleDir(moduleUrl: string): string;
  /** Whether the module whose `import.meta.url` is given is the one the
   *  process was started with. A compiled program runs its `main` node only
   *  when this is true. */
  isMainModule(moduleUrl: string): boolean;
  exit(code: number): never;
};

/** How the runtime reads what it needs for itself and reports what it must.
 *  `read` answers the test switches, the log level, and the API key a
 *  connector sends; on Node it reads the same variables as `env.get`. The
 *  difference is who asks: a program calling `env("KEY")` goes through the
 *  `env` capability, which a host can refuse, and the runtime reading
 *  `AGENCY_MAX_COST` goes through here, which no host refuses. */
export type HostSettings = {
  read(name: string): string | null;
  /** Where a line from the runtime's logger goes. The level is the
   *  logger's; the line is already formatted. Never throws. */
  log(level: LogLevel, text: string): void;
};

/** Random values. `nodeHost` and `browserHost` use the platform's secure
 *  source; `memoryHost` returns a sequence a test can predict. */
export type HostRandom = {
  /** A short unique id, the way `nanoid()` makes one. */
  id(): string;
  bytes(length: number): Uint8Array;
};

/** The parts a host is built from. `env` and `terminal` are capabilities,
 *  so a host may leave them out; `makeHost` then supplies parts that
 *  refuse. The other parts are required. */
export type HostParts = {
  env?: HostEnv;
  terminal?: HostTerminal;
  system: HostSystem;
  settings: HostSettings;
  clock: Clock;
  random: HostRandom;
};

export type Host = {
  /** Names the host in error messages: "node", "browser", "memory". */
  name: string;
  /** What this host has. Only `requireCapabilities` reads it. */
  capabilities: Capability[];
  env: HostEnv;
  terminal: HostTerminal;
  system: HostSystem;
  settings: HostSettings;
  clock: Clock;
  random: HostRandom;
};

/** The capability each capability part needs. A part not listed here
 *  (`system`, `settings`, `clock`, `random`) is on every host. */
export const PART_CAPABILITY = {
  env: "env",
  terminal: "terminal",
} as const satisfies Record<string, Capability>;

export type CapabilityPart = keyof typeof PART_CAPABILITY;

/** Thrown when code asks a host for something it cannot do. Agency turns an
 *  error thrown inside a function into a failure result, so a program sees
 *  a failed call with this message. A refusing host never reports success
 *  for work it did not do. */
export class UnsupportedOnHostError extends Error {
  readonly capability: Capability;
  readonly hostName: string;
  /** The host function that was called, as "part.function", when one was. */
  readonly functionName: string | null;

  constructor(args: { capability: Capability; hostName: string; functionName?: string }) {
    const subject = args.functionName ? `${args.functionName} needs` : "This needs";
    super(
      `${subject} the ${args.capability} capability, which the ${args.hostName} host does not have.`,
    );
    this.name = "UnsupportedOnHostError";
    this.capability = args.capability;
    this.hostName = args.hostName;
    this.functionName = args.functionName ?? null;
  }
}

export type MakeHostArgs = {
  name: string;
  capabilities: Capability[];
  parts: HostParts;
  /** Called with the function's name, as "part.function", and its
   *  capability before any capability function runs. The test runner uses
   *  it to record which capabilities a test used. */
  onUse?: (functionName: string, capability: Capability) => void;
};

/**
 * Build a host from its parts. For each capability part:
 *
 * - when its capability is granted, the part comes from `parts`, and a
 *   missing part is an error here, not later;
 * - when it is not, the host gets a part whose every function throws
 *   `UnsupportedOnHostError`.
 *
 * So no host writes a refusal, and a host with fewer capabilities is the
 * same code with a shorter list.
 */
export function makeHost(args: MakeHostArgs): Host {
  const { name, capabilities, parts, onUse } = args;
  for (const capability of capabilities) {
    if (!CAPABILITIES.includes(capability)) {
      throw new Error(`Unknown capability "${capability}" for the ${name} host.`);
    }
  }
  const given = parts as unknown as Record<string, Record<string, unknown> | undefined>;
  const built: Record<string, object> = {};
  for (const part of Object.keys(PART_CAPABILITY) as CapabilityPart[]) {
    const capability = PART_CAPABILITY[part];
    if (!capabilities.includes(capability)) {
      built[part] = refusedPart(part, capability, name);
      continue;
    }
    const implementation = given[part];
    if (implementation === undefined) {
      throw new Error(`The ${name} host grants ${capability} but its parts have no ${part}.`);
    }
    built[part] = onUse ? observedPart(part, capability, implementation, onUse) : implementation;
  }
  return {
    name,
    capabilities: [...capabilities],
    env: built.env as HostEnv,
    terminal: built.terminal as HostTerminal,
    system: parts.system,
    settings: parts.settings,
    clock: parts.clock,
    random: parts.random,
  };
}

/** A part whose every function throws, for a capability the host lacks.
 *  A Proxy, so the host need not know the part's function names: any
 *  name a caller asks for refuses with that name in the message. */
function refusedPart(part: string, capability: Capability, hostName: string): object {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string") {
          return undefined;
        }
        return () => {
          throw new UnsupportedOnHostError({
            capability,
            hostName,
            functionName: `${part}.${property}`,
          });
        };
      },
    },
  );
}

/** The part with every function wrapped to call `onUse` first. */
function observedPart(
  part: string,
  capability: Capability,
  implementation: Record<string, unknown>,
  onUse: NonNullable<MakeHostArgs["onUse"]>,
): object {
  const wrapped: Record<string, unknown> = {};
  for (const [fn, value] of Object.entries(implementation)) {
    if (typeof value !== "function") {
      wrapped[fn] = value;
      continue;
    }
    wrapped[fn] = (...callArgs: unknown[]) => {
      onUse(`${part}.${fn}`, capability);
      return value(...callArgs);
    };
  }
  return wrapped;
}

/** Throw `UnsupportedOnHostError` for the first capability in `needed` that
 *  `host` lacks. The one function that reads `host.capabilities`. `what`
 *  names the caller in the message. */
export function requireCapabilities(host: Host, needed: Capability[], what?: string): void {
  for (const capability of needed) {
    if (!host.capabilities.includes(capability)) {
      throw new UnsupportedOnHostError({ capability, hostName: host.name, functionName: what });
    }
  }
}

/** A copy of `host` with `clock` replaced. For the callers that pass a
 *  `FakeClock` to a `RuntimeContext` and want the rest of the host as is. */
export function withClock(host: Host, clock: Clock): Host {
  return { ...host, clock };
}
