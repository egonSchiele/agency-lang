# The host and capabilities: one interface for everything Agency asks of the platform

Builds on `docs/dev/runtime/running-without-node.md`. That doc sets the
goals and the rule about branching.

That doc lists three places where the platforms may differ. This spec
keeps one and replaces two:

| `running-without-node.md` | This spec |
| --- | --- |
| A pair of files, `host.node.ts` and `host.browser.ts`, with the same exports | A `Host` type, three implementations, and a host on each run's context |
| One entry point for the browser beside `lib/runtime/index.ts` | Kept |
| One mark at the top of each Node-only stdlib module | A `@capabilities` tag on effect declarations |

Phase 2 updates that doc.

`2026-10-05-host-and-platforms-review.md` reviews an earlier draft. This
version answers its findings.

## The problem

Agency should run in a browser and in a web view on an iPad. It cannot
today, because every compiled program imports Node, whatever the program
does. A program that only calls `print("hi")` reaches `fs` in three ways.

1. **The header of every generated file imports Node.**
   `lib/templates/backends/typescriptGenerator/imports.mustache` imports
   `fs`, `path`, `os`, `url`, and `process`. It uses them to find the
   working directory, to read two environment variables for test mocks,
   and to compute `__dirname`.
2. **The prelude imports Node.** Every file imports `std::index`. Its
   backing files import `readline` and `child_process`. One of them,
   `lib/stdlib/agency.ts`, imports the parser and the type checker.
3. **The main entry point exports the compiler.** Generated code imports
   `goToNode`, `color`, `nanoid`, and `smoltalk` from `"agency-lang"`.
   That entry also exports the parser, the backends, and config loading.

Past those three, Node is spread through the runtime and the stdlib. These
are the counts of files that import each Node module, across `lib/runtime`
and `lib/stdlib`, leaving out tests:

| Module | Files |
| --- | --- |
| `path` | 45 |
| `fs` | 20 |
| `child_process` | 14 |
| `crypto` | 13 |
| `os` | 10 |
| `readline` | 4 |

More Node use goes through globals that no file imports. These are the
counts in the same two directories:

| Use | Count |
| --- | --- |
| `process.stdout` | 70 |
| `process.env` | 62 |
| `process.stdin` | 36 |
| `process.cwd` | 34 |
| `process.platform` | 27 |
| `process.send` | 16 |
| `process.stderr` | 10 |
| `process.exit` | 8 |

`Buffer` appears in 6 runtime files and 22 stdlib files.

The compiler also does not know which platform a program is for. A program
that reads a file compiles for the browser without complaint.

## What this adds

1. **A `Host` type.** It lists every function Agency needs from the
   platform.
2. **Three hosts.** `nodeHost` does what Agency does today. `browserHost`
   refuses files and subprocesses. `memoryHost` keeps files in memory and
   has a clock a test controls.
3. **Seven capabilities.** A capability is a part of the host that a host
   may lack. An effect declaration says which capabilities it needs.
4. **A `--platform` flag.** Compiling for a platform fails if the program
   can raise an effect whose capabilities the platform lacks.
5. **One place where the default host is chosen.** The generated code and
   the runtime are the same on every platform.
6. **A browser entry point, a lint rule, and a CI check** that keep Node
   out of the browser bundle.

## 1. The `Host` type

```ts
export type Host = {
  capabilities: Capability[];
  files: HostFiles;
  network: HostNetwork;
  subprocess: HostSubprocess;
  env: HostEnv;
  terminal: HostTerminal;
  system: HostSystem;
  settings: HostSettings;
  clock: Clock;
  random: HostRandom;
};
```

Four rules shape the type. Each one answers a problem another project
ran into. See [Lessons from other projects](#lessons-from-other-projects).

1. **Every function that can wait returns a promise.**
2. **The functions are Agency's own.** They are not copies of Node's `fs`
   functions. A host for another platform does not have to imitate Node.
3. **No function is optional.** A host that cannot do something throws
   `UnsupportedOnHostError`. Callers never check whether a function
   exists.
4. **There is one `Host` type.** Code that needs only files takes a
   `HostFiles`, which is a part of the same type.

The type has no field that names the platform. Such a field would invite
`if (host.platform === "browser")` in the runtime, which is the branching
`running-without-node.md` exists to prevent. `UnsupportedOnHostError`
takes the host's name from the host that throws it.

### Parts and capabilities

The host has two kinds of part.

**A capability is a part that a host may lack or refuse.** It has a name,
effects are tagged with it, and the compiler checks it. There are seven.

| Capability | Covers | Scope the host carries |
| --- | --- | --- |
| `fileRead` | reading and listing files | the root directory |
| `fileWrite` | writing, moving, and deleting files | the root directory |
| `network` | HTTP requests from the stdlib | which sites are allowed |
| `subprocess` | bash, programs, and child Agency programs | none yet |
| `env` | reading and setting environment variables | none yet |
| `terminal` | reading input and writing output | none |
| `llm` | model calls | none |

**Every host provides the other parts.** `system`, `settings`, `clock`,
and `random` have no capability name. No platform lacks a clock, nobody would refuse
one to an agent, and nearly every function reads the time, so a tag for
it would be on every effect. A test host provides a clock and random
values the test controls.

`llm` is separate from `network`. A model call is a network request, and
if the two shared a capability, a host with no network would also have no
model.

The lists in other systems have the same core. Deno has `read`, `write`,
`net`, `env`, and `run`. Node's permission model has `fs-read`,
`fs-write`, `net`, and `child-process`. Both split reading from writing.
Clipboard, notifications, Apple Notes, and iMessage run `osascript`
today, so they need `subprocess`. A device capability such as `clipboard`
can be added when a host implements one natively.

`host.capabilities` lists what this host has. One runtime function reads
it, `requireCapabilities`, which section 6 describes. No other code may
read it.

`llm` has no functions on the host, because model calls go through the
`LLMClient` on the context. The code that makes a model call checks the
capability with `requireCapabilities`.

### One table says what each function needs

```ts
export const NEEDS = {
  "files.readText": "fileRead",
  "files.list": "fileRead",
  "files.writeText": "fileWrite",
  "files.remove": "fileWrite",
  "network.fetch": "network",
  "subprocess.run": "subprocess",
  "env.get": "env",
  "terminal.writeOut": "terminal",
  ...
};
```

`NEEDS` has one entry for every function in a capability part. It is the
only place that says which capability a host function needs.

A second table says which capabilities each platform has:

```ts
export const PLATFORM_CAPABILITIES = {
  node: ["fileRead", "fileWrite", "network", "subprocess", "env", "terminal", "llm"],
  browser: ["network", "env", "terminal", "llm"],
};
```

Every host is built by one function:

```ts
const host = makeHost({
  name: "browser",
  capabilities: PLATFORM_CAPABILITIES.browser,
  parts: { network, env, terminal, system, clock, random },
});
```

`makeHost` reads `NEEDS`. For each function whose capability is in the
list, it takes the function from `parts`, and it fails at once if the
function is missing. For each function whose capability is not in the
list, it supplies one that throws `UnsupportedOnHostError`.

This has three results:

- **No host writes a refusal.** A host implements what it can do.
  `browserHost` contains no file code.
- **A host with fewer capabilities needs no new code.** A test passes a
  shorter list.
- **The compiler and the hosts cannot disagree.** The platform check in
  section 6 and the default hosts both read `PLATFORM_CAPABILITIES`.

### Files

```ts
export type HostFiles = {
  root(dir: string): Promise<Root>;
  wholePath(path: string): Promise<Located>;
  fixedPath(path: string): Promise<Located>;
  realPath(path: string): Promise<string>;
  resolvePath(root: Root, target: string): Promise<string>;
  locate(dir: string, filename: string): Promise<{ dir: string; filename: string }>;
  withLock<T>(root: Root, target: string, work: () => Promise<T>): Promise<T>;

  readText(root: Root, target: string): Promise<string>;
  readBytes(root: Root, target: string): Promise<Uint8Array>;
  readChunks(root: Root, target: string): AsyncIterable<Uint8Array>;
  list(root: Root, target: string): Promise<Entry[]>;
  stat(root: Root, target: string): Promise<Stats | null>;

  writeText(root: Root, target: string, content: string, options?: WriteOptions): Promise<void>;
  writeBytes(root: Root, target: string, bytes: Uint8Array, options?: WriteOptions): Promise<void>;
  updateText(root: Root, target: string, change: (current: string | null) => string): Promise<void>;
  openForWrite(root: Root, target: string, options?: WriteOptions): Promise<WritableFile>;
  mkdir(root: Root, target: string): Promise<void>;
  remove(root: Root, target: string): Promise<void>;
  copy(from: Located, to: Located): Promise<void>;
  move(from: Located, to: Located): Promise<void>;
};
```

These are the functions `lib/stdlib/contained.ts` exports today, which 33
files import. `Root`, `Located`, `Entry`, `WriteOptions`, and `WriteMode`
keep their current meaning.

In `NEEDS`, the first two groups need `fileRead`, because resolving a
path reads the disk. The third group needs `fileWrite`.

Every function that reads or writes takes a `Root`, which is a directory
the caller was given. A host built with a narrower root can reach less.
This is the same idea as fixing a directory argument with `.partial` in
Agency code.

`Root` is opaque to callers. Today it is `{ real: string }`, and about
twenty places in eleven files outside `contained.ts` read `.real` to
build a path. `shell.ts`, `fs.ts`, and `prepareContainedPath.ts` have
the most. They move to `resolvePath`.

`lib/host/roots.ts` owns the inside of a `Root`. It exports `fixedRoot`,
which makes one, and a reader that only files under `lib/host/` may
import. Every host accepts a `Root` from `fixedRoot`. For `memoryHost`
the path inside it names a directory in its object.

These things change from `contained.ts`:

- **Every function is async.**
- **`readBytes` returns a `Uint8Array`.** It returns a Node `Buffer`
  today.
- **`readChunks` replaces `readStream`.** `readStream` returns an
  `fs.ReadStream`. It has three callers. `modelVerify.ts` hashes a large
  file in pieces. `speech.ts` and `approvedPath.ts` open a file and close
  it at once to check that it can be read, and they move to `stat`.
- **`realPath` replaces `_realTarget`.**
- **`resolvePath` replaces `resolveUnder`.** It has 12 call sites. Each
  one takes the path and hands it to something that is not the host's
  file part: a subprocess such as `ffmpeg` or `python`, a module loader,
  or an interrupt payload that shows the user which file is meant. The
  function stays, and its meaning is "a path that this host's subprocess
  part understands". `browserHost` refuses it.
- **`updateText`, `locate`, and `withLock` are new.** See below.
- **`seams` leaves `WriteOptions`.** The symlink tests use it to act
  between an open and a check. It becomes an option of `nodeHost`.

Two functions stay outside the host because they do not touch the disk.
`fixedRoot` wraps a path that is already real and moves to
`lib/host/roots.ts`. `isContained` compares two path strings. It uses
`path` and `process.platform` today, so it moves to the portable path
module from section 5 when that module exists, and stays where it is
until then.

#### `updateText`

```ts
await host.files.updateText(root, "config.json", (current) => {
  const config = JSON.parse(current ?? "{}");
  config.lastRun = today;
  return JSON.stringify(config);
});
```

`updateText` reads a file, calls `change` with its text, and writes the
result. `current` is `null` when the file does not exist.

Every host must meet this rule: no other call on the same file runs
between the read and the write of one `updateText`.

`nodeHost` meets the rule because it reads and writes with synchronous
`fs` calls inside one function. A host with async storage needs a lock
per file. The shared test file for hosts tests the rule.

This replaces a pattern that is safe today and unsafe once the file
functions are async:

```ts
const text = readText(root, "config.json");
writeText(root, "config.json", edit(text));
```

Today no other branch can run between those two lines, because both are
synchronous. With an `await` on each line, another branch of a `fork` or
a `parallel` block can write the same file in between, and one write is
lost.

Phase 3 finds every helper that reads a file and writes it back, and
moves each one to `updateText`.

#### `withLock`

```ts
await host.files.withLock(root, "skills/notes.md", async () => {
  const existing = await host.files.stat(root, "skills/notes.md");
  if (existing === null) {
    await host.files.writeText(root, "skills/notes.md", draft);
  }
});
```

Some helpers make several file calls that belong together, such as a
`stat`, then a `mkdir`, then a write. The save gates in `std::skills`
and `std::toolbox` are likely examples. Those run inside `withLock`,
which holds a lock on one path for the length of `work`.

The lock belongs to the host and is keyed by path, so it covers every run
that shares the host. The per-run lock in `docs/dev/runtime/lock.md`
does not: under `agency serve`, two requests are two runs in one process,
and today those helpers are synchronous, so nothing runs in the middle of
one. The host's lock keeps that true. `updateText` takes the same lock,
which is how a host with async storage meets the rule above.

#### `locate`

`lib/stdlib/prepareContainedPath.ts` turns a directory and a filename
into the `dir` and `filename` an interrupt payload shows the user. It
makes three file calls, and its comment says why it must not await
between them: it runs between a wrapper's call and its interrupt, and an
`await` there would hand the event loop to another branch. `locate` is
that function on the host. `nodeHost` runs its three steps synchronously
inside one call.

### Network

```ts
export type HostNetwork = {
  fetch(request: Request): Promise<Response>;
};
```

`Request` and `Response` are the web standard types, which Node and
browsers both have. The stdlib calls the global `fetch` today. Every such
call moves to `host.network.fetch`, so a host can refuse it or limit it
to a list of sites. `installFetchMock` becomes a host that returns
scripted responses.

### Subprocesses

```ts
export type Command =
  | { kind: "program"; program: string; args: string[] }
  | { kind: "shell"; script: string };

export type HostSubprocess = {
  run(command: Command, options: RunOptions): Promise<RunResult>;
  start(command: Command, options: RunOptions): Promise<RunningProcess>;
};
```

The code calls Node's subprocess functions at 29 call sites in four
styles. They come down to three needs, and the host covers two.

1. **Run a command and wait.** `bash("ls | wc -l")` is a `shell` command.
   `exec("git", ["status"])` is a `program` command. The calls to
   `osascript`, `security`, `gh`, and `pbpaste` are all `program`
   commands. `RunOptions` holds the working directory, the environment,
   text to send as input, a timeout, an abort signal, and callbacks for
   output as it arrives. `RunResult` holds the exit code and both output
   streams.
2. **Start a process and keep a handle to it.** `ffmpeg`, `rec`, and the
   image tools script are started, fed input, and stopped later.
   `RunningProcess` has `write`, `kill`, and `wait`.
3. **Run a child Agency program.** This is the `fork` call in
   `lib/runtime/ipc.ts`, and it stays there. The child extends the
   parent's handler chain, which `docs/dev/runtime/subprocess-ipc.md`
   describes, and moving that code has the most handler risk in this
   spec. `ipc.ts` is Node-only, so a browser never reaches it either
   way. `_runFor` calls `requireCapabilities` for `subprocess` on its
   first line, so a host without the capability refuses a child program.

Phase 4 reads every call site before this part of the type is final.

### Environment variables

```ts
export type HostEnv = {
  get(name: string): string | null;
  set(name: string, value: string): void;
};
```

`env` is what the Agency functions `env` and `setEnv` in `std::system`
read and write. It exposes any variable to the program, and so to an
agent, which is why it is a capability of its own.

The runtime and the stdlib helpers also read environment variables for
themselves: test switches, the log level, and the API key a connector
sends. Those reads do not go through `env`. See `settings` below. A
host without `env` still runs a program that calls a connector.

### Terminal

```ts
export type HostTerminal = {
  readLine(prompt: string): Promise<string>;
  writeOut(text: string): void;
  writeErr(text: string): void;
  isInteractive(): boolean;
};
```

`print` writes through `writeOut`. `input` and the interactive interrupt
prompts read through `readLine`. `browserHost` takes these four functions
from the app that embeds it.

`print` and `input` raise no effect, so on a host without `terminal`
each one fails as a function call. The runtime's own messages do not go
through `terminal`. The logger writes through `settings.log`, so a
warning from the runtime never throws on a host with fewer capabilities.

The terminal UI needs more than this: the terminal's width and height,
raw mode, and listeners on the input stream. `std::ui`,
`lib/stdlib/cli.ts`, and `lib/stdlib/ui-region.ts` use them. Those files
stay Node-only. See [Stdlib modules that are Node-only as a whole](#stdlib-modules-that-are-node-only-as-a-whole).

### System

```ts
export type HostSystem = {
  operatingSystem(): OperatingSystem;
  cwd(): string;
  homeDir(): string;
  tempDir(): string;
  args(): string[];
  processId(): number;
  moduleDir(moduleUrl: string): string;
  exit(code: number): never;
};
```

`operatingSystem` replaces `process.platform` and `detectPlatform`, which
have 38 uses between them. `lib/stdlib/utils.ts` exports a type named
`Platform` for this today:

```ts
export type Platform = "macos" | "linux" | "windows" | "wsl" | "unknown";
```

That type is renamed to `OperatingSystem`, so "platform" means one thing.
`browserHost` returns `"unknown"`.

`moduleDir` turns a module's `import.meta.url` into its directory. The
generated header needs that value for `RuntimeContext`.

`exit` on `browserHost` throws `UnsupportedOnHostError`. `system` is not
a capability part, so this is the one refusal a host writes itself.

### Settings

```ts
export type HostSettings = {
  read(name: string): string | null;
  log(text: string): void;
};
```

`settings` is not a capability. It is how the runtime and the stdlib
helpers read what they need for themselves and report what they must.
On `nodeHost`, `read` reads `process.env` and `log` writes to standard
error. On `browserHost`, `read` reads an object the app passed in and
`log` calls `console.error`. `memoryHost` records both.

`settings.read` and `env.get` read the same variables on Node. The
difference is who asks. The runtime reading `AGENCY_MAX_COST`, or a
connector reading `TAVILY_API_KEY`, is the runtime acting for itself. A
program calling `env("TAVILY_API_KEY")` is the program reading a secret,
and that is what the capability can refuse.

### Clock and random values

```ts
export type HostRandom = {
  id(): string;
  bytes(length: number): Uint8Array;
};
```

`Clock` is the existing type in `lib/runtime/clock.ts`, with `now`,
`wallTime`, and `setTimer`. `RuntimeContext` already takes one. It moves
to `host.clock`.

`nodeHost` and `browserHost` take `bytes` from the platform's secure
source. OAuth state and keys depend on that. `memoryHost` returns a
sequence a test can predict, and uses `FakeClock`.

Most code does not go through either today. The runtime and the stdlib
call `performance.now()` 44 times, `Date.now()` 22 times, and `nanoid()`
21 times. Those calls work in a browser. Moving them is phase 9, and the
browser goal does not depend on it.

## 2. The three hosts

| Host | Capabilities | Files | Other parts |
| --- | --- | --- | --- |
| `nodeHost` | all seven | today's `contained.ts` | `process`, `os`, `readline`, `child_process`, the real clock |
| `browserHost` | `network`, `env`, `terminal`, `llm` | refuses | values and functions the app passes in, `console` when the app passed none, the real clock |
| `memoryHost` | whatever the test asks for | an object in memory | scripted subprocess and network results, `FakeClock` |

"Refuses" means the function throws `UnsupportedOnHostError`. Agency
turns an error thrown inside a function into a failure result, so the
program sees a failed call with this message:

```
readText needs the fileRead capability, which the browser host does not have.
```

A refusing host never reports success for work it did not do.

Each host is a function that returns a `Host`. Each one calls `makeHost`
with the parts it implements, so none of them contains a refusal.

Each takes an optional list of capabilities to grant. The default for
`nodeHost` and `browserHost` is their row in `PLATFORM_CAPABILITIES`. A
test that must not write files builds its host without `fileWrite`:

```ts
const host = memoryHost({ files, capabilities: ["fileRead", "terminal"] });
```

`memoryHost` is where a test replaces a part of the host. Three
environment variables switch on test doubles today: `AGENCY_FAKE_CLOCK`,
`AGENCY_FETCH_MOCKS_FILE`, and `AGENCY_LLM_MOCKS`. The first two describe
parts of the host. They stay as the way the test runner asks for a
double, and they are read in one place, `lib/host/default.node.ts`, which
returns a host with a fake clock or scripted responses. `AGENCY_LLM_MOCKS`
stays with the `LLMClient`.

`nodeHost` keeps the synchronous `fs` calls it has today and wraps each
result in a promise. One file operation still runs in one piece, and it
takes the same time. The symlink checks stay inside `nodeHost`.

`memoryHost` has two uses. Tests use it so they do not touch the disk.
A playground can use it as the file system of a browser session.

### What a capability stops

A host stops code that goes through the host. Under `--agency-only`, a
program cannot import a non-Agency file, so everything it does goes
through the stdlib, and the stdlib goes through the host. A TypeScript
file that a program imports can still import `fs` directly.

The `llm` capability stops model calls. It does not route the model
client's own requests through `host.network`.

Capabilities add to handlers and policies and replace neither:

| | Effects, policies, handlers | Capabilities |
| --- | --- | --- |
| Question | May this action happen? | Can this host do it at all? |
| Detail | This file, this command | Seven names |
| Who answers | A handler, a policy, or a person | Nobody. It is fixed when the host is built. |
| Can the program approve it | Yes, with `with approve` | No |

## 3. Where the code lives

| File | Contents |
| --- | --- |
| `lib/host/host.ts` | The types above, `NEEDS`, `PLATFORM_CAPABILITIES`, `makeHost`, and `UnsupportedOnHostError`. Imports no Node module. |
| `lib/host/nodeHost.ts` | `nodeHost`. Its file part is `contained.ts`, moved. |
| `lib/host/browserHost.ts` | `browserHost`. |
| `lib/host/memoryHost.ts` | `memoryHost`. |
| `lib/host/default.node.ts` | Exports a `nodeHost` as the default host. |
| `lib/host/default.browser.ts` | Exports a `browserHost` as the default host. |

### How the default host is chosen

The two `default.*.ts` files, and the `#sha256` pair from section 5,
are the only code that differs by platform. Both go through the
`imports` field of `package.json`, which the hashing change adds:

```json
"imports": {
  "#default-host": {
    "browser": "./dist/lib/host/default.browser.js",
    "default": "./dist/lib/host/default.node.js"
  }
}
```

The runtime imports `#default-host`. Node resolves it to the Node file.
esbuild resolves it to the browser file when it bundles with
`--platform=browser`. Nothing in the generated code changes.

Three places have to know about each `imports` entry, and the hashing
change set them up: `lib/utils/packageImports.d.ts` declares the name
for TypeScript, `vitest.aliases.ts` maps it for every vitest config, and
`tsconfig.json` has `rootDir` set. Phase 2 adds `#default-host` to the
first two. The name must not go in `paths` in `tsconfig.json`, because
the build rewrites `paths` entries into relative imports.

The stdlib ships compiled, as it does now. Because the generated code is
the same on both platforms, one compiled copy serves both.

### How code reaches the host

`RuntimeContext` takes an optional `host` and keeps it as `ctx.host`.
When the caller passes none, the context uses the default host.

A TypeScript helper reads the host from the run it was handed:

```ts
export async function _read(run: Run, dir: string, filename: string): Promise<string> {
  const { host } = run.ctx;
  const root = await host.files.root(dir);
  return host.files.readText(root, filename);
}
```

The host is not a global. Two runs in one process can have different
hosts, which is what lets a test give one run a `memoryHost`.

A compiled program builds its context in its generated header, with
fixed arguments, so nothing outside can pass a host to that constructor.
The way in is `InvocationOptions`, which already carries `config`,
`traceId`, and `policy` for one run. It gains `host`. Every entry that
takes `InvocationOptions` passes it on, and `createExecutionContext`
puts it on the run. A run with no `host` in its options uses the
default host.

`default.browser.ts` builds a `browserHost` whose terminal writes to
`console.log` and `console.error`, for an app that passed nothing.

### The lint rule

The structural linter gets a rule in phase 2. Files the browser entry
point can reach may not:

- import a Node module
- use the globals `process`, `Buffer`, `__dirname`, `require`, or
  `setImmediate`

The rule covers `lib/runtime`, `lib/stdlib`, `lib/simplemachine`, and
`lib/host/host.ts`, `browserHost.ts`, and `memoryHost.ts`. It also covers
these files outside those directories, which the runtime imports:

| File | Node imports | `process` uses |
| --- | --- | --- |
| `lib/importPaths.ts` | 4 | 0 |
| `lib/config/config.ts` | 2 | 3 |
| `lib/statelogClient.ts` | 2 | 1 |
| `lib/utils/termcolors.ts` | 0 | 6 |
| `lib/logger.ts` | 0 | 1 |

The rule starts with a list of the files that break it. Each later phase
shortens the list. A new `process.env` read in a file that is not on the
list fails CI from phase 2 on.

`lib/cli`, `lib/compiler`, and the rest of the toolchain are outside the
rule. The compiler stays Node-only in this spec. Two files there,
`lib/compiler/closureValidator.ts` and `lib/cli/hostedModels.ts`, call
the Node file functions directly and synchronously, because they have no
run to take a host from. Each gets a comment that says so.

### Three lists that say "Node-only"

Three places name the code that cannot run in a browser:

1. The Node-only array in the lint rule's exceptions, which lists
   TypeScript files.
2. The stand-ins that `lib/runtime/browser.ts` exports.
3. The compiler's array of Node-only stdlib modules, from section 6.

The first is the source. A test derives the other two from it and fails
when they differ. The lint rule also bans importing a file on the list
from any file that is not on it, so a file the browser can reach cannot
pull a Node-only file in. A stand-in is needed for exactly the header names that
come from a file on the list. A stdlib module is Node-only when its
compiled file imports a file on the list.

### Runtime files that use the disk

A stdlib function that the host refuses becomes a failure result. The
runtime's own file use is different, because a throw there lands in the
middle of a run. Each file gets one of three answers.

| File | Answer |
| --- | --- |
| `ipc.ts`, `subprocess-bootstrap.ts`, `cliEntry.ts`, `interruptPrompts.ts` | Node-only. The browser entry point exports stand-ins. |
| `localProvider.ts`, `providerModules.ts` | Node-only. They load modules from disk. |
| `coverageCollector.ts`, `trace/traceReader.ts` | Node-only. They are tooling. |
| `trace/sinks.ts` | `FileSink` moves to its own Node-only file. `CallbackSink` stays. |
| `trace/traceWriter.ts` | Writes through its sink and stops importing `fs`. Configuring a trace file on a host without `fileWrite` is an error when the context is built. |
| `memory/store.ts`, `memory/frame.ts` | Move to `host.files`. Enabling memory on a host without files is an error when memory is enabled. |
| `replyAttachments.ts`, `builtins.ts` | Move to `host.files`. A refusal is a failure of the function that asked. |
| `node.ts` | Phase 2 reads what it uses `fs` for and assigns it a row. |
| `effectSets.ts` | Stops reading the effect sets file at run time. `make` writes the sets into a TypeScript data file. |
| `policy.ts` | See below. |

**Policy matching stays synchronous.** `resolveDotDirPattern` in
`policy.ts` calls `realpathSync` on the working directory while an
interrupt is being answered. An `await` does not belong on that path. The
directories it needs are resolved once, when the context is built, and
the matcher is handed plain strings. The existing `catch` already says
what happens when a directory cannot be resolved, so a host that refuses
changes nothing.

## 4. The generated header

The header loses every Node import. These replace them.

1. **The working directory and the module directory come from the host.**
   The header passes `import.meta.url` to the runtime. The runtime calls
   `host.system.cwd()` and `host.system.moduleDir(...)`.
2. **The two test-mock blocks move into the runtime.** They read
   `AGENCY_LLM_MOCKS` and `AGENCY_FETCH_MOCKS_FILE` while the module
   loads, and the second one calls `readFileSync`. Through an async host
   that read has to be awaited. It moves into the functions that already
   await static and global initialization, which run before any node.
3. **The four names from `"agency-lang"` come from `"agency-lang/runtime"`.**
   This removes the compiler from every program's imports.

The header also imports two names from Node-only files:

```ts
import {
  ...
  _runFor as __runtime_run_impl,
  ...
  runCliEntry,
} from "agency-lang/runtime";
```

`runCliEntry` comes from `cliEntry.ts`, and `_runFor` comes from
`ipc.ts`. A bundler fails on a named import that the entry point does not
export. `lib/runtime/browser.ts` exports a stand-in for each, and the
stand-in throws `UnsupportedOnHostError`. A test reads the names the
header imports and checks that `browser.ts` exports every one.

The header is then the same text for both platforms. Phases 1 and 2
change it, so the generator fixtures are rebuilt in both.

Two files that the prelude reaches also change:

- `std::index` imports `_callback` from `lib/stdlib/agency.ts`, which
  imports the compiler. `_callback` moves to its own file.
- `lib/stdlib/builtins.ts` imports `child_process` for the desktop
  notification function. That function moves to its own file.

## 5. Things that rely on Node and do not need it

The rule in `running-without-node.md` says to remove these for both
platforms. They do not go in the host.

| What | Used for | Replacement |
| --- | --- | --- |
| `path` | joining and splitting path text, in 45 files | one portable module with POSIX rules |
| `createHash`, `createHmac` | tool-loop guards, the decision collector, the trace store, the S3 request signer | `lib/utils/hash.ts`, over a `#sha256` import that is Node crypto on Node and plain JavaScript in a browser |
| `randomUUID`, `randomBytes` | ids, OAuth state | `host.random` |
| `Buffer` | base64 and bytes, in 6 runtime files and 22 stdlib files | `Uint8Array` and `lib/stdlib/base64.ts` |
| `parseArgs` from `node:util` | `std::args` | a portable parser, or `std::args` joins the Node-only modules |
| `createHmac`, `timingSafeEqual` | the checkpoint checksum | see below |
| `statSync` on `import.meta.url` | module fingerprints | see below |

`createRequire` in `localProvider.ts` and `mcpResolver.ts`, `http` in
`oauth.ts`, and `pathToFileURL` in `providerModules.ts` are in Node-only
files and stay.

Two more uses of `crypto` are Node-only for now:

- `lib/stdlib/oauthEncryption.ts` encrypts stored tokens with
  `createCipheriv`. There is no portable cipher in this spec, so
  `std::oauth` is a Node-only module. A later spec can move it to the
  browser's built-in crypto.
- `lib/stdlib/modelVerify.ts` hashes model files of many gigabytes in
  pieces. A SHA-256 in JavaScript is much slower than Node's, so this
  file stays Node-only with the rest of the local-model code.

`lib/utils/hash.ts` already exports `sha256Text`, which calls Node's
`createHash`. Three runtime files call `createHash` themselves beside it.
All of them now go through `hash.ts`.

Hashing is the one place where Node keeps its own implementation. A
SHA-256 in JavaScript is about nine times slower than OpenSSL, and that
was measured. So the two primitives, `sha256Bytes` and `hmacSha256`,
have a Node file and a portable file, and `hash.ts` imports them from
`#sha256`. That entry in the `imports` field of `package.json` resolves
to the Node file by default and to the portable file under the `browser`
condition. It is the same mechanism that chooses the default host, so
the two pairs of files are the only per-platform code.

Windows paths need a decision before `path` is replaced. Phase 6 counts
what depends on Windows path rules today.

Two of these touch safety checks, so each gets its own PR and its own
review.

**The checkpoint checksum.** `lib/runtime/checkpointChecksum.ts` computes
an HMAC synchronously, and the browser's built-in crypto is async. The
checksum uses the portable SHA-256 in `lib/utils/hash.ts`.
The PR needs a constant-time comparison to replace `timingSafeEqual`, a
timing on a large checkpoint, and a test that the same bytes verify the
same way before and after.

**Module fingerprints.** `lib/runtime/moduleFingerprintRegistry.ts` calls
`statSync` on each module's file. In a browser bundle every module has
the same URL and there is no file. The compiler computes the fingerprint
and writes it into the generated code. The fingerprint refuses a resume
when the code has changed, and the PR must keep that refusal on Node.

Today the fingerprint is the modification time of the compiled file, so
it changes on every rebuild. A hash of the source alone would stay the
same after a compiler upgrade that changes the generated steps, and a
checkpoint from the old build would resume into code with different
steps. The fingerprint is a hash of the generated code, which changes in
both cases.

Seven runtime files import the parser, the type checker, or
`typeToString`: `agencyFunction.ts`, `agencyInterrupt.ts`,
`toolBlockDiagnostics.ts`, and the files under `runtime/template/`. None
is known to use Node. They add compiler code to every browser bundle.
Phase 7 measures the bundle size.

## 6. Capabilities in the language

### Declaring what an effect needs

```
@capabilities(fileRead)
@alwaysUnder(dir)
effect std::read {
  dir: string;
  filename: string
}
```

`@capabilities` is a tag on an effect declaration. It takes zero or more
capability names. An effect that needs two writes
`@capabilities(fileRead, subprocess)`.

The names are bare words from the fixed list of seven. The compiler owns
the list. Users cannot add to it, because a capability is a part of the
`Host` type. A name the compiler does not know is an error:

```
error: unknown capability 'flies'. Did you mean 'fileRead'?
```

The names mean something only inside the tag. A program can still name a
variable `network` or `terminal`.

Effect declarations already carry tags, and
`lib/typeChecker/effectPayloadCheck.ts` already validates `@alwaysUnder`
on them. The new check sits beside it.

**An effect with no tag needs nothing and works on every host.** This is
right for an effect a user declares and raises in plain Agency code.

**Every `std::` effect must carry the tag.** An effect that needs nothing
writes `@capabilities()`. A test enforces this, the way
`lib/prelude.test.ts` checks prelude names. The stdlib has about 300
effect declarations.

An effect whose behaviour on a host is undecided is tagged with what its
code uses today. `std::memory::recall` reads the disk, so it is tagged
`fileRead`.

### Checking a tag against the code

A tag is written by hand, and the code behind it can change. One check
compares them.

`makeHost` takes an optional `onUse` callback, which it calls with the
host function's name and its capability each time a function from
`NEEDS` runs. For each test, the Agency test runner records two lists:
the capabilities the host was asked for, and the capabilities on the tags
of the effects the test raised. A capability in the first list and
missing from the second fails the test, and the message names the host
function and the effects.

The runner starts each test in a subprocess, so a callback cannot cross
to it. A switch in `default.node.ts`, read through `settings`, turns
recording on and names a file the child appends to. The runner reads the
file when the child exits.

`terminal` is left out of the check, because `print` and `input` raise
no effect and nearly every test prints. The check covers `fileRead`,
`fileWrite`, `network`, and `subprocess`. Any use of those should come
from a function that raised an effect. A use that did not is one of the
functions in "Functions that use the host and raise nothing", and the
check is how phase 8 finds them.

The check sees only what the existing tests run. It does not prove a tag
is complete.

### The rename

`std::capabilities` holds named sets of effects for `raises` clauses, and
the keyword that declares one is `effectSet`. The module is renamed to
`std::effectSets`. `agency effects` prints "capability sets" today, and
that becomes "effect sets". About 18 files in `lib/` use the word. Each
one is read before it changes.

### Compiling for a platform

```
agency compile --platform browser app.agency
```

`compile`, `typecheck`, `bundle`, and `pack` take the flag. `run`
always runs on Node and does not.

The same setting can go in `agency.json`:

```json
{ "platform": "browser" }
```

The default is `node`. The word is "platform" because "target" already
means two other things in this codebase: the `ConfigTarget` type, and the
esbuild `target` setting in `agency.json`.

The compiler reads `PLATFORM_CAPABILITIES` from `lib/host/host.ts`, the
same constant the default hosts are built from:

| Platform | Capabilities |
| --- | --- |
| `node` | all seven |
| `browser` | `network`, `env`, `terminal`, `llm` |

The flag turns on a check. It does not change the code the compiler
emits.

### The check

The compiler already knows which effects each function can raise, across
files. `docs/dev/compiler/effect-propagation.md` describes how. That
analysis also follows a function handed to `llm` as a tool, a function
stored in a variable, and a function made with `.partial`.

The compiler looks at every node and every exported function in the files
it is compiling. It reads the type checker's list,
`interruptEffectsByFunction`, which is the list `agency policy gen`
reads. The symbol table's own list is weaker: it cannot see a function
stored in a variable or received as a parameter. If a function can raise
an effect that needs a capability the platform lacks, compiling fails
with a new diagnostic:

```
error: node 'main' raises 'std::read', which needs the fileRead capability.
The browser platform does not have it.
  main calls loadNotes (notes.agency:12)
  loadNotes calls read (notes.agency:4)
```

The effect lists hold no call path. `lib/analysis/interrupts.ts` has the
call graph and costs about fifteen times as much to run. The compiler
runs it only after the cheap check has found a violation.

A handler does not change the result. A file read wrapped in
`with approve` is still refused, because approving it would not make it
work.

The prelude needs no special case. Every file imports `read`, and a
program carries `std::read` only if it calls `read`.

The check does not cover `llm` yet. A call to `llm` raises no effect, so
there is nothing to tag. Both platforms have the capability, and a host
without it refuses the call at run time.

A TypeScript file that the program imports is invisible to the check. If
it imports `fs`, the bundler reports it.

### Refusing before the approval prompt

`read` raises its interrupt first and reads the file second. Without
another check, a user could approve a read and then see the host refuse
it.

When an interrupt is raised, the runtime calls `requireCapabilities` with
the effect's tagged capabilities and the run's host. If the host lacks
one, the interrupt is rejected before any handler or person is asked. The
program sees the same result as for any rejected interrupt, with a reason
that names the capability. The tags reach the runtime the same way the
`@alwaysUnder` scopes do.

Agency already has one way to refuse an effect, which is a handler that
rejects. A handler that the runtime installs at the root would use that
one mechanism. This spec uses a check at the raise instead, for one
reason. Handlers are not part of a checkpoint, so every path that
restores a run would have to install the root handler again, and a path
that forgot would let the effect through to the approval prompt. The
check reads `ctx.host`, which every restored run already has.

### Functions that use the host and raise nothing

Some exported stdlib functions call a helper that uses the host and raise
no effect, so they have nothing to tag. A rough scan found 87 candidates.
Many are false matches, because the scan flags any helper in a file that
also imports Node. `range` and `keys` are examples. The real ones
include:

- `stat`, `exists`, and `which` in `std::shell`
- `cwd`, `args`, `isTTY`, `readStdin`, and `setTitle` in `std::system`
- `print` and `input` in the prelude
- the model management functions in `std::agency/local`
- `readProjectMcpConfig` in `std::mcp`

Phase 8 goes through the list. Each function gets one of three answers.

1. **It uses a part every host provides.** `cwd` and `args` are in this
   group.
2. **It should have raised an effect all along.** It gets one, and the
   effect is tagged.
3. **It stays as it is.** A host without the capability refuses it at run
   time.

### Stdlib modules that are Node-only as a whole

A few stdlib modules cannot work without Node, and their functions raise
no effect. `std::ui` drives a terminal in raw mode. `std::agency/local`
manages model files and server processes. `std::agency` compiles Agency
code.

The compiler keeps a list of these module names in TypeScript. Importing
one when the platform is `browser` is a compile error. This adds no
syntax to the language. A test derives the list from the lint rule's
Node-only array, as section 3 describes.

## 7. The browser entry point

`lib/runtime/browser.ts` sits beside `lib/runtime/index.ts`. It exports
everything generated code imports, with stand-ins for the names that come
from Node-only files. `package.json` exposes it under the `browser`
condition of `agency-lang/runtime`.

A CI step bundles a small compiled program for the browser:

```bash
npx esbuild dist/smoke/hello.js --bundle --platform=browser --format=esm --outfile=bundle.js
```

The step fails if the bundle imports a Node module. esbuild does not
complain about a reference to `process.env.FOO`. The lint rule from
section 3 is what catches those.

A second smoke test runs the bundle in a headless browser. It runs a
program that prints, reads an environment variable, sleeps, raises an
interrupt that a handler approves, and calls `read` to check the refusal.

## 8. smoltalk

Every model call goes through smoltalk, and three of its files import
Node: `modelRefresh.js`, `clients/llamaCppLoader.js`, and
`util/blobRef.js`. Until they change, the browser bundle needs
`--external:smoltalk`. This is a change in the smoltalk repo. It depends
on no other phase and can start now.

## What changes, in order

The plan groups these phases into five PRs, each based on `main`. Each
PR leaves behaviour on Node unchanged and can merge without the next.

Each part of the `Host` type is added in the PR that implements it. No
PR declares a part that throws "not built yet".

1. **Clean the imports.** Generated code imports from
   `agency-lang/runtime`. `_callback` and the notification function move
   to their own files. Rebuild the fixtures.
2. **Add the host.** Add `lib/host/` with `system`, `settings`, `env`,
   `terminal`, and `clock`. Add the `#default-host` entry, its declaration, its vitest alias,
   `ctx.host`, and `host` in `InvocationOptions`. Move the `process` and `os` uses to the host. Remove the
   Node imports from the header. Rename `Platform` to `OperatingSystem`.
   Add the lint rule with its list of exceptions. Update
   `running-without-node.md`.
3. **Files**, in six PRs.
   1. Move `contained.ts` into `nodeHost` with no change in behaviour,
      and add `locate`.
   2. Resolve the policy directories when the context is built. This PR
      is reviewed on its own.
   3. Write the effect sets into a data file at build time.
   4. Move `FileSink` to its own file.
   5. Make the file functions async, add `updateText` and `withLock`,
      and replace `Buffer`. Count the synchronous functions that become
      async before starting.
   6. Write `memoryHost` and the shared test file for hosts.
4. **Subprocesses.** Read every call site, settle `HostSubprocess`, and
   move the calls. The `fork` call stays where it is.
5. **Network.** Add `host.network` and move the stdlib's `fetch` calls.
6. **Portable replacements.** `path`, hashing, and `Buffer`, then the
   checkpoint checksum and module fingerprints, each in its own PR.
7. **The browser entry point.** `browserHost`, the stand-ins, the CI
   bundle check, the headless smoke test, and a bundle size measurement.
8. **Capabilities.** Rename `std::capabilities` to `std::effectSets`. Add
   the `@capabilities` tag and tag every `std::` effect. Add the
   `--platform` flag, the diagnostic, the list of Node-only modules,
   `requireCapabilities`, and the review of functions that raise nothing.
9. **Clock and random values.** Move the direct calls to `host.clock` and
   `host.random`. The browser goal does not depend on this phase.

After phase 7 a compiled program that touches no files runs in a browser
with `--external:smoltalk`. When the smoltalk change lands it makes model
calls.

## Testing

- **The existing suites are the main check for phases 1 to 6.** Behaviour
  on Node does not change.
- **`nodeHost` keeps the `contained.ts` tests**, including the symlink
  battery in `contained.symlinks.test.ts`.
- **One shared test file runs against every host that has files.**
  `nodeHost` and `memoryHost` must agree on what each file function does,
  including the `updateText` rule.
- **`updateText` gets an Agency execution test.** Two branches of a
  `fork` edit one file, and both edits are present afterwards.
- **`makeHost` gets the refusal tests.** For every entry in `NEEDS`, a
  host built without that capability throws `UnsupportedOnHostError` from
  that function. A second test checks that `NEEDS` has an entry for every
  function in every capability part, so a new host function cannot be
  left out.
- **The Node-only lists** are compared by the test from section 3.
- **The tag check** from section 6 runs in the Agency test runner.
- **The header test** checks that `browser.ts` exports every name the
  header imports.
- **The platform check gets type checker tests**: a direct call, a call
  through an imported function, a tool handed to `llm`, a handled call, a
  program that never calls `read`, and an import of a Node-only module.
- **The tag gets type checker tests**: an unknown name, an empty tag, and
  a variable named after a capability.
- **The stdlib tag test** from section 6.
- **The early refusal gets an Agency execution test.** A program raises a
  tagged effect on a host without the capability, and no handler runs.
- **The CI bundle check and the headless smoke test** from section 7.

## Lessons from other projects

1. **A synchronous host is hard to change later.** TypeScript's
   `CompilerHost` reads files synchronously, and the compiler above it
   depends on that. A request for an async host stayed open for years.
2. **Copying Node's `fs` ties every host to Node.** isomorphic-git lets
   you supply a file system, and the file system must implement a subset
   of Node's `fs` module by name.
3. **Optional functions spread checks through the callers.** TypeScript's
   `System` type marks many members optional, and each caller tests for
   them.
4. **Several host types need adapters between them.** TypeScript has
   `System`, `CompilerHost`, `LanguageServiceHost`, and
   `ModuleResolutionHost`.
5. **A global host is hard to test.** `ts.sys` is a module-level value,
   and tests replace it by assignment.
6. **An interface allows a test double.** Kotlin's `expect` and `actual`
   give one implementation per platform. The common advice is to use
   interfaces for the work and one `expect` for the wiring.
7. **An in-memory host serves tests and a playground.**
   `@typescript/vfs` is a file system in a map. The TypeScript Playground
   runs on it, and so do tests.
8. **Hand out directories.** WASI and Rust's `cap-std` open each file
   relative to a directory the program was given.
9. **Capability lists are short, and the detail is in a scope.** Deno's
   flag is `net`, and its scope is a list of sites.

## Decisions

- **The file functions are async.** Two designs would keep them
  synchronous. One loads every file into memory before the program starts
  and writes changes back later, which limits how much data fits. The
  other runs Agency in a worker and uses the synchronous file handles a
  browser offers there, which forces every browser app to use a worker.
  Async costs the `updateText` work and the helpers that become async.
- **The stdlib keeps shipping compiled.** Shipping source would make
  every program that runs Agency code need the compiler.
- **The generated code is the same on every platform.** The platform flag
  only turns on a check.
- **Capabilities are declared on effects, with a built-in tag and a fixed
  list of names.** The tag is not allowed on a module.
- **There are seven capabilities.** `llm` is separate from `network`.
  Reading and writing files are separate.
- **The clock and random values are parts of the host and are not
  capabilities.**
- **An effect with no tag works everywhere. Every `std::` effect must
  carry the tag.**
- **A refusing host throws.**
- **One table, `NEEDS`, says which capability each host function needs.**
  `makeHost` builds every host from it, and no host writes a refusal.
- **`PLATFORM_CAPABILITIES` is read by both the compiler and the default
  hosts.**
- **An unsupported effect is rejected by a check at the raise, and not by
  a root handler.** A root handler would have to be installed again on
  every restore.
- **Hashing uses the existing `lib/utils/hash.ts`, over a `#sha256` import
  that is Node crypto on Node.** The portable SHA-256 was measured at
  nine times slower, and that loss was judged too large for Node.
- **The `fork` call stays in `ipc.ts`.** Moving it has the most handler
  risk and no browser gain. `_runFor` checks the `subprocess`
  capability instead.
- **The runtime reads its own settings through `settings`, which is not
  a capability.** A host with fewer capabilities does not break the
  runtime.
- **File locks belong to the host, keyed by path.** The per-run lock
  does not cover two runs in one process.
- **A run gets its host from `InvocationOptions`.**
- **The host lives on the run's context.**
- **The word for Node or browser is "platform".** The operating system
  type is `OperatingSystem`.
- **"Capabilities" means parts of the host.** The sets of effects are
  "effect sets".

## Not in this spec

- **Running the compiler in a browser.** The iPad runs programs that were
  compiled on a Mac. A playground that compiles in the browser needs the
  parser, the type checker, and the stdlib sources to run there, and a
  way to run the result without a subprocess.
- **A flag that removes capabilities from a run.** A host can already be
  built with fewer capabilities. A command line flag for it, and a way to
  give a subagent fewer capabilities than its caller, come later.
- **Scopes for `network`, `subprocess`, and `env`.** The table in section
  1 names where each would go.
- **Real file storage in the browser.** `browserHost` refuses files.
- **A simulated shell for the playground.**
- **Requests a browser blocks.** A browser refuses a request to another
  site unless that site allows it. Many data connectors in the `Network`
  effect set will fail in a desktop browser for that reason, although the
  host has the `network` capability.
- **Where API keys live on the iPad.** The OpenAI and Anthropic SDKs
  refuse to run in a browser unless a flag is set, because the page can
  read the key.
- **A portable cipher for `std::oauth`, and hashing large files
  outside Node.** Both stay Node-only.
- **Statelog in a browser.**
- **Config in a browser.** Config is read from `agency.json` on disk
  today. A browser program needs it passed in or written into the bundle.
