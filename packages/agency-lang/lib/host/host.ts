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

/** A directory an approval named, realpathed once by the host that made
 *  it. Every file operation takes one; nothing takes a bare string root.
 *  Only files under lib/host read its inside (`rootPath` in roots.ts). */
export type { Root } from "./roots.js";
import type { Root } from "./roots.js";

/** A whole path the approval named, as its real parent plus a final name
 *  that is never followed. */
export type Located = { root: Root; target: string };

export type Entry = { name: string; type: "file" | "dir" | "other"; size: number };

/** What `stat` says about a path. `null` from `stat` means nothing is
 *  there. */
export type FileStat = {
  kind: "file" | "dir" | "other";
  size: number;
  /** Milliseconds since the Unix epoch. */
  modifiedMs: number;
};

export const WRITE_MODES = ["overwrite", "append", "create-only"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];
export type WriteOptions = { mode?: WriteMode; fileMode?: number };

/** An open file for writes at positions, from `openForWrite`. */
export type WritableFile = {
  /** Write all of `data` at `position`, looping over a short write. */
  writeAt(data: Uint8Array, position: number): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
};

/** The files. Every function takes a `Root` an approval named, and a host
 *  built with a narrower root reaches less. The rule every host keeps: under
 *  an approval that names directory D, no byte is read from or written to
 *  a path outside D, and a symlink below D is refused. Reading and
 *  resolving need `fileRead`; writing, moving, and deleting need
 *  `fileWrite`. See docs/dev/stdlib/contained-files.md. */
export type HostFiles = {
  /** The root for a directory a caller spelled, realpathed once. */
  root(dir: string): Promise<Root>;
  /** The root an approval already named, spelled the way the approver saw
   *  it: every existing component must be a real directory, so a link
   *  planted at the approved path while the prompt was pending is
   *  refused. */
  fixedRoot(dir: string): Promise<Root>;
  /** The real spelling of a directory, for an interrupt payload or a
   *  comparison of paths. */
  realDir(dir: string): Promise<string>;
  /** Split a whole path into its real parent and final name. */
  wholePath(path: string): Promise<Located>;
  /** The whole-path twin of `fixedRoot`: the real parent the approver saw,
   *  checked to still be spelled without links, plus the final name. */
  fixedPath(path: string): Promise<Located>;
  /** The real spelling of a whole path, for an interrupt payload. */
  realPath(path: string): Promise<string>;
  /** `target` under `root`, validated: a path this host's subprocess part
   *  understands, for a program such as ffmpeg or a module loader. */
  resolvePath(root: Root, target: string): Promise<string>;
  /** The `dir` and `filename` an interrupt payload shows for a single-file
   *  operation. Runs its steps in one piece, with no await between them,
   *  because it runs between a wrapper's call and its interrupt. */
  locate(
    dir: string,
    filename: string,
    operation: "read" | "write",
  ): Promise<{ dir: string; filename: string }>;
  /** Hold a lock on one path for the length of `work`. The lock belongs
   *  to the host, so it covers every run that shares it. */
  withLock<T>(root: Root, target: string, work: () => Promise<T>): Promise<T>;

  readText(root: Root, target: string): Promise<string>;
  readBytes(root: Root, target: string): Promise<Uint8Array>;
  /** The file in pieces, for one too large to buffer. */
  readChunks(root: Root, target: string): AsyncIterable<Uint8Array>;
  /** One level of a directory. Symlinked entries are left out. */
  list(root: Root, target: string): Promise<Entry[]>;
  stat(root: Root, target: string): Promise<FileStat | null>;

  writeText(root: Root, target: string, content: string, options?: WriteOptions): Promise<void>;
  writeBytes(root: Root, target: string, bytes: Uint8Array, options?: WriteOptions): Promise<void>;
  /** Read a file, call `change` with its text (`null` when it does not
   *  exist), and write the result. No other call on the same file runs
   *  between the read and the write. */
  updateText(root: Root, target: string, change: (current: string | null) => string): Promise<void>;
  openForWrite(root: Root, target: string, options?: WriteOptions): Promise<WritableFile>;
  mkdir(root: Root, target: string): Promise<void>;
  remove(root: Root, target: string): Promise<void>;
  copy(from: Located, to: Located): Promise<void>;
  move(from: Located, to: Located): Promise<void>;
};

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

/** The parts a host is built from. `files`, `env`, and `terminal` are
 *  capabilities, so a host may leave them out; `makeHost` then supplies
 *  parts that refuse. The other parts are required. */
export type HostParts = {
  files?: HostFiles;
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
  files: HostFiles;
  env: HostEnv;
  terminal: HostTerminal;
  system: HostSystem;
  settings: HostSettings;
  clock: Clock;
  random: HostRandom;
};

/** The capability each capability part needs. A part not listed here
 *  (`system`, `settings`, `clock`, `random`) is on every host. `files`
 *  needs two: `fileRead` for the part, and `fileWrite` for the functions
 *  in FILE_WRITE_FUNCTIONS. */
export const PART_CAPABILITY = {
  files: "fileRead",
  env: "env",
  terminal: "terminal",
} as const satisfies Record<string, Capability>;

export type CapabilityPart = keyof typeof PART_CAPABILITY;

/** The functions of the files part that write, move, or delete. They need
 *  `fileWrite`; the rest of the part needs `fileRead`. */
export const FILE_WRITE_FUNCTIONS: (keyof HostFiles)[] = [
  "writeText",
  "writeBytes",
  "updateText",
  "openForWrite",
  "mkdir",
  "remove",
  "copy",
  "move",
];

/** The capability one function of a capability part needs. */
export function functionCapability(part: CapabilityPart, fn: string): Capability {
  if (part === "files" && FILE_WRITE_FUNCTIONS.includes(fn as keyof HostFiles)) {
    return "fileWrite";
  }
  return PART_CAPABILITY[part];
}

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
    built[part] = wrapPart(part, implementation, capabilities, name, onUse);
  }
  return {
    name,
    capabilities: [...capabilities],
    files: built.files as HostFiles,
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

/** The part with each function wrapped: a function whose own capability
 *  (`fileWrite`, for a write on the files part) is not granted refuses,
 *  and the rest call `onUse` first when there is one. */
function wrapPart(
  part: CapabilityPart,
  implementation: Record<string, unknown>,
  capabilities: Capability[],
  hostName: string,
  onUse: MakeHostArgs["onUse"],
): object {
  const wrapped: Record<string, unknown> = {};
  for (const [fn, value] of Object.entries(implementation)) {
    if (typeof value !== "function") {
      wrapped[fn] = value;
      continue;
    }
    const capability = functionCapability(part, fn);
    const functionName = `${part}.${fn}`;
    if (!capabilities.includes(capability)) {
      wrapped[fn] = () => {
        throw new UnsupportedOnHostError({ capability, hostName, functionName });
      };
      continue;
    }
    if (!onUse) {
      wrapped[fn] = value;
      continue;
    }
    wrapped[fn] = (...callArgs: unknown[]) => {
      onUse(functionName, capability);
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
