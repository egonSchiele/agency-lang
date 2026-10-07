// A host that lives in memory, for tests and for a playground. Files are
// entries in a plain object keyed by path, the terminal records what was
// written, settings come from an object the test supplied, and the clock
// is a FakeClock. It passes its parts to makeHost, so a capability left
// out of its list is refused by makeHost and not by code here.
//
// This file imports no Node module and uses no Node global.

import { FakeClock, type Clock } from "../runtime/clock.js";
import type { LogLevel } from "../logger.js";
import {
  makeHost,
  CAPABILITIES,
  type Capability,
  type Entry,
  type FileStat,
  type Host,
  type HostEnv,
  type HostFiles,
  type HostNetwork,
  type HostRandom,
  type HostSubprocess,
  type Command,
  type HostSettings,
  type HostSystem,
  type HostTerminal,
  type Located,
  type MakeHostArgs,
  type OperatingSystem,
  type WritableFile,
  type WriteOptions,
} from "./host.js";
import { rootPath, type Root } from "./roots.js";

/** What a memory host holds and records. A test reads these after a run. */
export type MemoryHostState = {
  /** Every file, keyed by its absolute path with `/` separators. */
  files: Record<string, Uint8Array>;
  /** Every directory that exists, keyed the same way. */
  dirs: Record<string, true>;
  /** What `terminal.print`, `writeOut`, and `writeErr` were given, in order. */
  output: string[];
  /** Lines `readLine` hands out, in order. Empty when the test gave none. */
  inputLines: string[];
  /** What `settings.log` was given. */
  logged: { level: LogLevel; text: string }[];
  /** The variables `settings.read` and `env.get` answer from. */
  variables: Record<string, string>;
  clock: FakeClock;
};

export type MemoryHostOptions = {
  /** Defaults to every capability. */
  capabilities?: Capability[];
  /** Files to start with, by absolute path. Text is stored as UTF-8. */
  files?: Record<string, string | Uint8Array>;
  /** The variables `settings.read` and `env.get` answer from. */
  variables?: Record<string, string>;
  /** Lines `readLine` hands out. */
  inputLines?: string[];
  /** What `network.fetch` answers with. Without one, every request is
   *  refused with an error that names the URL. */
  fetch?: HostNetwork["fetch"];
  /** What runs commands. Without one, every command is refused with an
   *  error that names the program. */
  subprocess?: HostSubprocess;
  cwd?: string;
  homeDir?: string;
  operatingSystem?: OperatingSystem;
  clock?: FakeClock;
  onUse?: MakeHostArgs["onUse"];
};

export type MemoryHost = Host & { state: MemoryHostState };

export function memoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const cwd = options.cwd ?? "/";
  const state: MemoryHostState = {
    files: {},
    dirs: { "/": true },
    output: [],
    inputLines: [...(options.inputLines ?? [])],
    logged: [],
    variables: { ...(options.variables ?? {}) },
    clock: options.clock ?? new FakeClock(),
  };
  for (const [name, content] of Object.entries(options.files ?? {})) {
    const full = absolute(cwd, name);
    state.files[full] = typeof content === "string" ? new TextEncoder().encode(content) : content;
    addParents(state, full);
  }
  addParents(state, joinPath(cwd, "x"));

  const host = makeHost({
    name: "memory",
    capabilities: options.capabilities ?? [...CAPABILITIES],
    onUse: options.onUse,
    parts: {
      files: memoryFiles(state, cwd),
      network: memoryNetwork(options),
      subprocess: memorySubprocess(options),
      env: memoryEnv(state),
      terminal: memoryTerminal(state),
      system: memorySystem(options, cwd),
      settings: memorySettings(state),
      clock: state.clock as Clock,
      random: memoryRandom(),
    },
  });
  return { ...host, state };
}

// ---------------------------------------------------------------------------
// Paths. POSIX rules, no symlinks: a memory host has none to refuse.
// ---------------------------------------------------------------------------

function normalize(p: string): string {
  const parts: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

function joinPath(base: string, target: string): string {
  return normalize(`${base}/${target}`);
}

function absolute(cwd: string, p: string): string {
  return p.startsWith("/") ? normalize(p) : joinPath(cwd, p);
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function baseOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function addParents(state: MemoryHostState, p: string): void {
  let current = parentOf(p);
  while (!state.dirs[current]) {
    state.dirs[current] = true;
    current = parentOf(current);
  }
}

function isUnder(target: string, root: string): boolean {
  return target === root || root === "/" || target.startsWith(root + "/");
}

function makeRoot(real: string): Root {
  return { real };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** The operations on the object of files, shared by the functions of the
 *  part below. */
function memoryStore(state: MemoryHostState) {
  const resolve = (root: Root, target: string): string => {
    const base = rootPath(root);
    if (target.startsWith("/") || target.startsWith("~")) {
      throw new Error(
        `refused: "${target}" is outside dir "${base}". To reach it, pass that directory in dir.`,
      );
    }
    const full = joinPath(base, target);
    if (!isUnder(full, base)) {
      throw new Error(
        `refused: "${target}" is outside dir "${base}" (it resolves to "${full}"). To reach it, pass that directory in dir.`,
      );
    }
    return full;
  };
  const kindOf = (full: string): FileStat["kind"] | null =>
    state.files[full] ? "file" : state.dirs[full] ? "dir" : null;
  const readOrThrow = (full: string): Uint8Array => {
    const bytes = state.files[full];
    if (!bytes) {
      throw new Error(`ENOENT: no such file or directory, open '${full}'`);
    }
    return bytes;
  };
  const write = (full: string, bytes: Uint8Array, options: WriteOptions = {}): void => {
    const mode = options.mode ?? "overwrite";
    if (state.dirs[full])
      throw new Error(`EISDIR: illegal operation on a directory, open '${full}'`);
    if (!state.dirs[parentOf(full)]) {
      throw new Error(`ENOENT: no such file or directory, open '${full}'`);
    }
    if (mode === "create-only" && state.files[full]) {
      throw new Error(`EEXIST: file already exists, open '${full}'`);
    }
    if (mode === "append" && state.files[full]) {
      const joined = new Uint8Array(state.files[full].length + bytes.length);
      joined.set(state.files[full]);
      joined.set(bytes, state.files[full].length);
      state.files[full] = joined;
      return;
    }
    state.files[full] = bytes;
  };
  const removeTree = (full: string): void => {
    for (const name of Object.keys(state.files)) {
      if (isUnder(name, full)) {
        delete state.files[name];
      }
    }
    for (const name of Object.keys(state.dirs)) {
      if (name !== "/" && isUnder(name, full)) {
        delete state.dirs[name];
      }
    }
  };
  const copyTree = (source: string, destination: string): void => {
    if (state.files[source]) {
      addParents(state, destination);
      state.files[destination] = state.files[source];
      return;
    }
    state.dirs[destination] = true;
    for (const name of Object.keys(state.files)) {
      if (isUnder(name, source) && name !== source) {
        state.files[destination + name.slice(source.length)] = state.files[name];
      }
    }
    for (const name of Object.keys(state.dirs)) {
      if (isUnder(name, source) && name !== source) {
        state.dirs[destination + name.slice(source.length)] = true;
      }
    }
  };
  const listDir = (full: string): Entry[] => {
    if (!state.dirs[full]) {
      throw new Error(`ENOENT: no such file or directory, scandir '${full}'`);
    }
    const entries: Entry[] = [];
    const prefix = full === "/" ? "/" : full + "/";
    for (const [name, bytes] of Object.entries(state.files)) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes("/")) {
        entries.push({ name: name.slice(prefix.length), type: "file", size: bytes.length });
      }
    }
    for (const name of Object.keys(state.dirs)) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes("/")) {
        entries.push({ name: name.slice(prefix.length), type: "dir", size: 0 });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  };
  const openForWrite = (full: string): WritableFile => ({
    writeAt: async (data, position) => {
      const existing = state.files[full] ?? new Uint8Array(0);
      const size = Math.max(existing.length, position + data.length);
      const next = new Uint8Array(size);
      next.set(existing);
      next.set(data, position);
      state.files[full] = next;
    },
    truncate: async (size) => {
      const existing = state.files[full] ?? new Uint8Array(0);
      const next = new Uint8Array(size);
      next.set(existing.subarray(0, Math.min(size, existing.length)));
      state.files[full] = next;
    },
    close: async () => {},
  });
  return { resolve, kindOf, readOrThrow, write, removeTree, copyTree, listDir, openForWrite };
}

/** `locate` with the same teaching message as nodeFiles.locateSync. */
function locateIn(
  state: MemoryHostState,
  store: ReturnType<typeof memoryStore>,
  cwd: string,
  dir: string,
  filename: string,
  operation: "read" | "write",
): { dir: string; filename: string } {
  if (dir.trim() === "") {
    throw new Error(`${operation} refused: dir must not be empty.`);
  }
  const base = absolute(cwd, dir);
  if (!state.dirs[base]) {
    throw new Error(`${operation} refused: dir "${dir}" does not exist.`);
  }
  let full: string;
  try {
    full = store.resolve(makeRoot(base), filename);
  } catch (error) {
    const preposition = operation === "write" ? "somewhere else" : "from somewhere else";
    throw new Error(
      `${operation} ${(error as Error).message.replace(
        "To reach it, pass that directory in dir.",
        `To ${operation} ${preposition}, pass that directory in dir.`,
      )}`,
    );
  }
  return { dir: base, filename: full.slice(base.length + (base === "/" ? 0 : 1)) };
}

function memoryFiles(state: MemoryHostState, cwd: string): HostFiles {
  const store = memoryStore(state);
  const { resolve } = store;
  const locks: Record<string, Promise<void>> = {};

  return {
    root: async (dir) => {
      if (dir.trim() === "") {
        throw new Error('dir must not be empty. Use "." for the current directory.');
      }
      return makeRoot(absolute(cwd, dir));
    },
    fixedRoot: async (dir) => {
      if (dir.trim() === "") {
        throw new Error('dir must not be empty. Use "." for the current directory.');
      }
      return makeRoot(absolute(cwd, dir));
    },
    realDir: async (dir) => absolute(cwd, dir),
    wholePath: async (p) => {
      const full = absolute(cwd, p);
      return { root: makeRoot(parentOf(full)), target: baseOf(full) };
    },
    fixedPath: async (p) => {
      const full = absolute(cwd, p);
      return { root: makeRoot(parentOf(full)), target: baseOf(full) };
    },
    realPath: async (p) => absolute(cwd, p),
    resolvePath: async (root, target) => resolve(root, target),
    locate: async (dir, filename, operation) =>
      locateIn(state, store, cwd, dir, filename, operation),
    withLock: async (root, target, work) => {
      const key = resolve(root, target);
      const previous = locks[key] ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      // The chain the next caller waits on. Kept so the last one out can
      // tell it is last and drop the entry, or the object grows by one
      // path forever on a long-lived host.
      const queued = previous.then(() => held);
      locks[key] = queued;
      await previous;
      try {
        return await work();
      } finally {
        release();
        if (locks[key] === queued) {
          delete locks[key];
        }
      }
    },
    readText: async (root, target) =>
      new TextDecoder().decode(store.readOrThrow(resolve(root, target))),
    readBytes: async (root, target) => store.readOrThrow(resolve(root, target)),
    readChunks: (root, target) => {
      const full = resolve(root, target);
      return (async function* () {
        yield store.readOrThrow(full);
      })();
    },
    list: async (root, target) => store.listDir(resolve(root, target)),
    stat: async (root, target) => {
      const full = resolve(root, target);
      const kind = store.kindOf(full);
      if (kind === null) {
        return null;
      }
      return { kind, size: state.files[full]?.length ?? 0, modifiedMs: state.clock.wallTime() };
    },
    writeText: async (root, target, content, options) =>
      store.write(resolve(root, target), new TextEncoder().encode(content), options),
    writeBytes: async (root, target, bytes, options) =>
      store.write(resolve(root, target), bytes, options),
    // The read and the write are one synchronous step, so nothing can run
    // between them.
    updateText: async (root, target, change) => {
      const full = resolve(root, target);
      const current = state.files[full] ? new TextDecoder().decode(state.files[full]) : null;
      store.write(full, new TextEncoder().encode(change(current)));
    },
    openForWrite: async (root, target, options) => {
      const full = resolve(root, target);
      if (!state.files[full]) {
        store.write(full, new Uint8Array(0), options);
      }
      return store.openForWrite(full);
    },
    openForAppend: async (root, target, options) => {
      const full = resolve(root, target);
      if (!state.files[full]) {
        store.write(full, new Uint8Array(0), options);
      }
      return {
        append: async (data) => store.write(full, data, { mode: "append" }),
        close: async () => {},
      };
    },
    mkdir: async (root, target) => {
      const full = resolve(root, target);
      state.dirs[full] = true;
      addParents(state, full);
    },
    remove: async (root, target) => store.removeTree(resolve(root, target)),
    copy: async (from: Located, to: Located) => {
      const source = resolve(from.root, from.target);
      const destination = resolve(to.root, to.target);
      if (isUnder(destination, source)) {
        throw new Error(`copy: destination '${destination}' is inside source '${source}'`);
      }
      if (store.kindOf(source) === null) {
        throw new Error(`copy: no such file or directory: '${source}'`);
      }
      store.copyTree(source, destination);
    },
    move: async (from: Located, to: Located) => {
      const source = resolve(from.root, from.target);
      const destination = resolve(to.root, to.target);
      if (store.kindOf(source) === null) {
        throw new Error(`move: no such file or directory: '${source}'`);
      }
      store.copyTree(source, destination);
      store.removeTree(source);
    },
  };
}

// ---------------------------------------------------------------------------
// The other parts
// ---------------------------------------------------------------------------

function memoryNetwork(options: MemoryHostOptions): HostNetwork {
  return {
    fetch: async (input, init) => {
      if (options.fetch === undefined) {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        throw new Error(`The memory host has no network to reach ${url}.`);
      }
      return options.fetch(input, init);
    },
  };
}

function describeCommand(command: Command): string {
  return command.kind === "shell"
    ? `the shell script ${JSON.stringify(command.script)}`
    : command.program;
}

function memorySubprocess(options: MemoryHostOptions): HostSubprocess {
  const refuse = (command: Command) =>
    new Error(`The memory host has no subprocesses to run ${describeCommand(command)}.`);
  return {
    run: async (command, runOptions) => {
      if (options.subprocess === undefined) {
        throw refuse(command);
      }
      return options.subprocess.run(command, runOptions);
    },
    start: async (command, runOptions) => {
      if (options.subprocess === undefined) {
        throw refuse(command);
      }
      return options.subprocess.start(command, runOptions);
    },
  };
}

function memoryEnv(state: MemoryHostState): HostEnv {
  return {
    get: (name) => state.variables[name] ?? null,
    set: (name, value) => {
      state.variables[name] = value;
    },
    all: () => ({ ...state.variables }),
  };
}

function memorySettings(state: MemoryHostState): HostSettings {
  return {
    read: (name) => state.variables[name] ?? null,
    log: (level, text) => {
      state.logged.push({ level, text });
    },
  };
}

function memoryTerminal(state: MemoryHostState): HostTerminal {
  return {
    print: (values) => {
      state.output.push(
        values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ") + "\n",
      );
    },
    writeOut: (text) => {
      state.output.push(text);
    },
    writeErr: (text) => {
      state.output.push(text);
    },
    readLine: async () => {
      const line = state.inputLines.shift();
      if (line === undefined) {
        throw new Error("readLine: the memory host has no more input lines.");
      }
      return line;
    },
    isInteractive: () => false,
  };
}

function memorySystem(options: MemoryHostOptions, cwd: string): HostSystem {
  return {
    operatingSystem: () => options.operatingSystem ?? "unknown",
    cwd: () => cwd,
    homeDir: () => options.homeDir ?? "/home/agency",
    tempDir: () => "/tmp",
    args: () => [],
    processId: () => 1,
    moduleDir: (moduleUrl) => parentOf(moduleUrl.replace(/^file:\/\//, "")),
    isMainModule: () => false,
    exit: (code) => {
      throw new Error(`exit(${code}): the memory host cannot end the process.`);
    },
  };
}

function memoryRandom(): HostRandom {
  let counter = 0;
  return {
    id: () => `id-${++counter}`,
    bytes: (length) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        out[i] = (++counter * 31) % 256;
      }
      return out;
    },
  };
}
