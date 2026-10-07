# The host

The host is everything a run takes from the platform it runs on: the terminal, environment variables, the clock, random values, and facts such as the working directory. A Node process, a browser, and a test each build one. The runtime and the standard library reach the platform only through it, so one compiled program runs on both platforms, and a test can run a program against a host it controls.

The design is `docs/superpowers/specs/2026-10-05-host-and-platforms.md`.

## The type

`lib/host/host.ts` holds the type. It imports no Node module and uses no Node global, because every platform's entry point reaches it.

```ts
export type Host = {
  name: string;
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

The host has two kinds of part.

**A capability is a part a host may lack or refuse.** There are seven names: `fileRead`, `fileWrite`, `network`, `subprocess`, `env`, `terminal`, and `llm`. `host.capabilities` lists the ones this host has. `PART_CAPABILITY` says which capability each capability part needs: `files` needs `fileRead`, and its writing functions (`FILE_WRITE_FUNCTIONS`) need `fileWrite` as well; `network`, `subprocess`, `env`, and `terminal` need their own names.

**Every host provides the other parts.** `system`, `settings`, `clock`, and `random` have no capability name. No platform lacks a clock, and nearly every function reads the time, so a capability for it would be on every effect.

`system` is where a helper learns about the platform: `operatingSystem()` (`macos`, `linux`, `windows`, `wsl`, or `unknown`; on Node, WSL is told from Linux by reading `/proc/version` once), `cwd()`, `homeDir()`, `tempDir()`, `moduleDir(import.meta.url)` for a file that ships beside a module, and the rest. A helper that picks a program by platform, such as the keyring over `security` or `secret-tool`, reads `operatingSystem()` and never `process.platform`; `expandPath(p, homeDir)` takes the home directory from `system.homeDir()`, and `resolveCwdPath(host, p)` the working directory from `system.cwd()`.

`PLATFORM_CAPABILITIES` is the capabilities of each platform. Node has all seven; the browser has `network`, `env`, `terminal`, and `llm`. The compiler and the default host of each platform both read it, so they cannot disagree.

### `env` and `settings` read the same variables

On Node both read `process.env`. The difference is who asks.

- `env` is what the Agency functions `env` and `setEnv` in `std::system` use. It hands any variable to the program, and so to an agent. That is why it is a capability a host can refuse.
- `settings` is how the runtime reads what it needs for itself: the test switches, the log level, and the API key a connector sends. A program that calls `search()` works on a host without `env`, because the connector reads `BRAVE_API_KEY` through `settings`.

`settings.log` is where the runtime's logger writes. A caller that has the run passes `run.ctx.host.settings` to `createLogger` as its sink, so a line written after an `await` still reaches that run's host; without a sink the logger falls back to the current run's host, and to the console when no run is current. On Node the sink is the console, by level, so a warning from the runtime lands in a `std::ui` REPL's transcript, which captures the console.

### The terminal

`print` goes through `terminal.print(values)`, which takes the values: `nodeHost` hands them to `console.log`, so an object prints the way Node prints it, and that is the text the stdlib's tests compare. `input` goes through `terminal.readLine(prompt, signal)`, which gives up the read when the signal aborts. `writeOut` and `writeErr` write raw text for the stdlib functions that write to standard output or standard error.

## `makeHost` builds every host

```ts
const host = makeHost({
  name: "node",
  capabilities: PLATFORM_CAPABILITIES.node,
  parts: { env, terminal, system, settings, clock, random },
});
```

For each capability part, `makeHost` takes the part from `parts` when its capability is granted, and fails at once when the part is missing. When the capability is not granted, it supplies a part whose every function throws `UnsupportedOnHostError`:

```
env.get needs the env capability, which the node host does not have.
```

That part is a `Proxy`, so `makeHost` keeps no list of the part's function names: any name a caller asks for refuses, with that name in the message. A files part on a host with `fileRead` and no `fileWrite` is real, with its writing functions replaced by refusals.

So no host writes a refusal, and a host with fewer capabilities is the same code with a shorter list:

```ts
const quiet = nodeHost({ capabilities: ["terminal"] });
quiet.env.get("HOME"); // throws UnsupportedOnHostError
```

Agency turns an error thrown inside a function into a failure result, so a program sees a failed call with that message. A refusing host never reports success for work it did not do.

`requireCapabilities(host, needed, what)` is the one function that reads `host.capabilities`. Code that needs a capability but calls no host function, such as a model call needing `llm`, calls it.

`makeHost` also takes `onUse`, which it calls with the function's name and its capability before any capability function runs. The test runner uses it to record which capabilities a test used.

## The hosts

| Host | File | Capabilities | What it is built from |
| --- | --- | --- | --- |
| `nodeHost` | `lib/host/nodeHost.ts` | all seven | `process`, `os`, `readline`, `crypto`, the real clock |
| `memoryHost` | `lib/host/memoryHost.ts` | whatever the test asks for; all seven by default | an object of files, recorded output, scripted input lines, an object of variables, `FakeClock` |

Each is a function that returns a `Host`. `nodeHost` takes `{ capabilities, clock, files, onUse }`, all optional; `files.seams` is the test hook the symlink battery uses. `memoryHost` takes `{ capabilities, files, variables, inputLines, cwd, homeDir, operatingSystem, clock, onUse }` and returns the host with a `state` the test reads afterwards: the files, what was printed, what was logged.

### The file part

`HostFiles` is the contained file operations of `docs/dev/stdlib/contained-files.md` as promises, and every file operation the stdlib performs on a path a program chose goes through it. Every function takes a `Root` an approval named. Resolving and reading need `fileRead`; writing, moving, and deleting need `fileWrite`. `nodeHost` implements them over `lib/host/nodeFiles.ts`, the synchronous module, one operation per call, so an operation still runs in one piece with the same checks. `memoryHost` keeps files in a plain object with POSIX path rules and no symlinks.

A stdlib helper reaches the file part the way it reaches every other part: through `run.ctx.host` when it was handed the run, through `currentHost()` on its first line when Agency calls it as a plain function, and as an argument when it is a helper below those. A helper that reads a path for a program outside the host, such as the ffmpeg command or a Python script, gets the string from `resolvePath`; nothing outside `lib/host` reads a `Root`. The files with no run to take a host from, the compiler and the local-model code among them, call the synchronous module directly and say so at the import.

Three functions exist only on the host:

- `updateText(root, target, change)` reads a file, calls `change` with its text (`null` when the file does not exist), and writes the result, with nothing able to run between the read and the write. A read followed by a separate write would let another branch of a `fork` write the same file in between, and one write would be lost.
- `withLock(root, target, work)` holds a lock on one path for the length of `work`. The lock belongs to the host, so it covers every run that shares it, which the per-run lock in `lock.md` does not.
- `locate(dir, filename, operation)` finds the `dir` and `filename` an interrupt payload shows, found in one synchronous piece because it runs between a wrapper's call and its interrupt.

`openForAppend(root, target)` keeps a file open for appends, for the trace writer, which adds a line at a time; `openForWrite` is for writes at an offset, for the model downloader.

`memoryHost`'s path rules (`normalize`, `isUnder`) are a second implementation of "nothing above the root", with no symlinks to refuse. They serve tests. Before `memoryHost` holds files for code the user does not trust, they need the review `nodeFiles.ts` had.

`lib/host/files.shared.test.ts` runs one battery against both hosts: every function, each write mode, a missing file, a path that escapes the root, two overlapping `updateText` calls, and two pieces of work under one lock. A host added later registers there.

A refusal from `makeHost` throws when the function is called, before any promise exists. An `await` in an async caller turns that into a rejection, which is where every caller stands.

### The network part

`HostNetwork` is the platform's own `fetch`, with the same arguments and the same `Response`, so a host can refuse it, limit it to a list of sites, or answer from scripted responses. `nodeHost` calls the global `fetch` at the time of each call, so a test that replaces the global is honoured. `memoryHost` refuses every request unless the test passed a `fetch`. Every `fetch` in the stdlib goes through `host.network.fetch`, and a helper reaches the network the way it reaches files: through the run it was handed, or `currentHost()` on its first line. The model client is the exception: smoltalk, and any `LLMClient` a caller supplies, makes its own requests, which the host neither sees nor refuses. `SimpleOpenAIClient`, the small client the runtime ships, is Agency's own code and does go through the network part of the host it was built under.

### The subprocess part

`HostSubprocess` runs a `Command`: a program with its arguments, or a script for the platform's shell. `run` starts the child and waits, collecting its output; `start` hands back the running child with `kill` and `wait`, for the one caller that stops a child on an event of its own (`record`, on a keypress). `RunOptions` carries the working directory, the whole environment, text or bytes for standard input, a time limit, an abort signal, a cap on each output stream, which streams to collect, and the signal a kill sends. `RunResult` reports the facts: the exit code or the signal, both streams, which stream reached the cap if one did, and whether the child was killed for the time limit or the abort signal. What each ending means is the caller's decision. A program that cannot be started rejects with the platform's error (`ENOENT` on Node).

`lib/stdlib/abortable.ts` is the stdlib's layer over it, and every stdlib helper that runs a program goes through one of its functions: `abortableSpawn` and `abortableShell` (output collected; the cap on standard output and the time limit resolve with a note, the cap on standard error resolves as a failure, an abort rejects with `AgencyCancelledError`), `abortableExec` (output not wanted; a non-zero exit rejects), and `runProgram` (the contract of Node's `execFile`: each output stream is capped at 1 MiB unless the caller says otherwise, and a child that exited with anything but 0, wrote past the cap, ran past its time limit, or was cancelled rejects with `ProgramFailed`, which carries the output). The one `fork` in `lib/runtime/ipc.ts` stays there, Node-only, and `_runFor` checks the `subprocess` capability on its first line. The ffmpeg probe in `ffmpeg.ts` stays on `spawnSync`, because it runs inside a synchronous check before an interrupt and the host runs nothing synchronously.

A test of a helper that runs a fixed program mocks `lib/host/nodeSubprocess.ts` and scripts `run` with the helpers in `lib/stdlib/__tests__/fakeSubprocess.ts`. `memoryHost` refuses every command unless the test passed a `subprocess`.

### The default host

`lib/host/default.node.ts` exports `defaultHost()`, which returns a `nodeHost`. The runtime imports it as `#default-host`, an entry in the `imports` field of `package.json` that resolves to this file under the `default` condition. `running-without-node.md` explains the mechanism and the three places that have to know about each entry.

`default.node.ts` is the one place that reads the environment variables the test runner uses to ask for a double of part of the host. `AGENCY_FAKE_CLOCK=1` gives the host a `FakeClock`. `AGENCY_FETCH_MOCKS_FILE` names a file of scripted responses, read once per process, which becomes the host's network part (`fetchMock` in `lib/runtime/fetchMock.ts`); the global `fetch` is left alone. `AGENCY_LLM_MOCKS` is about the `LLMClient`, and `RuntimeContext` reads it.

## How code reaches the host

`RuntimeContext` keeps the host as `ctx.host`. Its constructor takes an optional `host` and uses `defaultHost()` when none is given; a `clock` argument replaces only the clock of that host. `ctx.clock` is a getter for `ctx.host.clock`.

The generated header builds the global context with fixed arguments:

```ts
const __host = __defaultHost();
const __dirname = __host.system.moduleDir(import.meta.url);
const __globalCtx = new RuntimeContext({ ..., dirname: __dirname, host: __host });
```

The header imports no Node module. Every environment variable it reads, it reads through `__host.settings.read`, and it starts `main` when `__host.system.isMainModule(import.meta.url)` says this module is the one the process was started with. Agency code may write `path.join(...)` and `os.homedir()` as free names; the header imports `path` and `os` from `agency-lang/runtime`, which on Node re-exports Node's modules from `lib/runtime/agencyGlobals.node.ts`. `lib/backends/typescriptGenerator/header.test.ts` fails if the header imports a Node module.

A run can carry its own host through `InvocationOptions`:

```ts
const result = await mod.__invokeNodeForServe("main", {}, { host: myHost });
```

`createExecutionContext` puts it on the run's context, and a run with no `host` in its options uses the global context's host. A resume does not remember the host of the run it resumes, so a caller that resumes passes it again.

A TypeScript helper reads the host from the run it was handed:

```ts
export async function runS3Operation(run: Run, region: string, operation: S3Operation) {
  const { settings } = run.ctx.host;
  const credentials = resolveAwsCredentials(settings);
  ...
}
```

A helper that Agency code calls as a plain function, and that was not handed the run, calls `currentHost()` from `lib/runtime/currentHost.ts` on its first line, before any `await`, the same rule as `currentRun()` in `async-context.md`:

```ts
export async function _search(query: string, options?: SearchOptions) {
  const { settings } = currentHost();
  const apiKey = options?.apiKey || settings.read("BRAVE_API_KEY");
  ...
}
```

With no run current, `currentHost()` is the platform's default host, so a unit test that calls the helper directly sees the same `process.env` it always did.

Two runs in one process can have different hosts, which is what lets a test give one run a host of its own.

## The lint rule

A file the browser can reach may not import a Node module or use the globals `process`, `Buffer`, `__dirname`, `__filename`, `require`, or `setImmediate`. The rule is in `eslint.config.js`, over the files in `BROWSER_FILES`: `lib/runtime`, `lib/stdlib`, `lib/simplemachine`, `lib/host`, and the files outside them the runtime imports.

`eslint.node-exceptions.mjs` lists the files that fail it:

- `NODE_ONLY` is for good, with the reason beside each file. `nodeHost.ts` is one; so are the files that run a child process, prompt at a terminal, or load modules from disk.
- `WAITING` is for a file whose Node use has not moved into the host yet. It only gets shorter.

`scripts/lint-browser-reach.mjs`, which `lint:structure` runs, bundles the runtime and the stdlib with esbuild, stopping at every listed file, and fails when the bundle reaches a file `BROWSER_FILES` does not cover, or when a reached file imports one on `NODE_ONLY`. `lib/runtime/index.ts` is the one exception to the second check: it is Node's entry point, and the browser has its own. `node scripts/lint-browser-reach.mjs --list` prints what it reached.

## Adding a function to the host

1. Add it to the part's type in `host.ts`.
2. Implement it in every host. `makeHost` builds a granted part from what the host passed, so a host that forgets the function fails the first call of it, and the shared tests under `lib/host` cover every function of every host.
3. Call it through `run.ctx.host` or `currentHost()`, and take the file off `WAITING` when nothing Node is left in it.

A function goes on the host when its answer depends on the platform. Joining two path strings does not; it belongs in a portable module. Reading the time does, and so does reading a variable.

## Decisions

- **`terminal.print` takes the values.** `print(obj)` in Agency prints the object the way `console.log` prints it, and the stdlib's tests compare that text, so the host formats the values.
- **`settings.log` takes a level.** The logger sends `info` and `debug` to standard output and `warn` and `error` to standard error, and a sink without the level could not keep that apart.
- **`Host` has a `name`.** `UnsupportedOnHostError` names the host in its message, and `requireCapabilities` throws it without a host function in hand.
- **`system.isMainModule` is on the host.** Node answers by comparing `process.argv[1]` with the module's path. A browser has neither and answers false.
- **The default host is built per context.** A `FakeClock` has state, and each context gets its own.
