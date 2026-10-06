# The host

The host is everything a run takes from the platform it runs on: the terminal, environment variables, the clock, random values, and facts such as the working directory. A Node process, a browser, and a test each build one. The runtime and the standard library reach the platform only through it, so one compiled program runs on both platforms, and a test can run a program against a host it controls.

The spec is `docs/superpowers/specs/2026-10-05-host-and-platforms.md`. This doc describes what is built.

## The type

`lib/host/host.ts` holds the type. It imports no Node module and uses no Node global, because every platform's entry point reaches it.

```ts
export type Host = {
  name: string;
  capabilities: Capability[];
  env: HostEnv;
  terminal: HostTerminal;
  system: HostSystem;
  settings: HostSettings;
  clock: Clock;
  random: HostRandom;
};
```

Later PRs add `files`, `network`, and `subprocess`.

The host has two kinds of part.

**A capability is a part a host may lack or refuse.** There are seven names: `fileRead`, `fileWrite`, `network`, `subprocess`, `env`, `terminal`, and `llm`. `host.capabilities` lists the ones this host has. An effect declaration in Agency will name the capabilities its function needs, and the compiler will check them against the platform a program is compiled for. In this PR two parts are capabilities: `env` and `terminal`.

**Every host provides the other parts.** `system`, `settings`, `clock`, and `random` have no capability name. No platform lacks a clock, and nearly every function reads the time, so a capability for it would be on every effect.

### `env` and `settings` read the same variables

On Node both read `process.env`. The difference is who asks.

- `env` is what the Agency functions `env` and `setEnv` in `std::system` use. It hands any variable to the program, and so to an agent. That is why it is a capability a host can refuse.
- `settings` is how the runtime reads what it needs for itself: the test switches, the log level, and the API key a connector sends. A program that calls `search()` works on a host without `env`, because the connector reads `BRAVE_API_KEY` through `settings`.

`settings.log` is where the runtime's logger writes. A caller that has the run passes `run.ctx.host.settings` to `createLogger` as its sink, so a line written after an `await` still reaches that run's host; without a sink the logger falls back to the current run's host, and to the console when no run is current. On Node it is the console, by level, so a warning from the runtime still lands in a `std::ui` REPL's transcript, which captures the console.

### The terminal

`print` goes through `terminal.print(values)`, which takes the values: `nodeHost` hands them to `console.log`, so an object prints the way Node prints it. `input` goes through `terminal.readLine(prompt, signal)`, which gives up the read when the signal aborts. `writeOut` and `writeErr` write raw text for the stdlib functions that write to standard output or standard error.

## One table says what each function needs

```ts
export const NEEDS = {
  "env.get": "env",
  "env.set": "env",
  "terminal.print": "terminal",
  ...
};
```

`NEEDS` has one entry for every function in a capability part. A test walks the parts of a real `nodeHost` and fails when a function has no entry.

`PLATFORM_CAPABILITIES` is the second table: the capabilities of each platform. Node has all seven; the browser has `network`, `env`, `terminal`, and `llm`. The compiler and the default hosts both read it, so they cannot disagree.

## `makeHost` builds every host

```ts
const host = makeHost({
  name: "node",
  capabilities: PLATFORM_CAPABILITIES.node,
  parts: { env, terminal, system, settings, clock, random },
});
```

For each entry in `NEEDS`, `makeHost` takes the function from `parts` when its capability is granted, and fails at once when the function is missing. When the capability is not granted, it supplies a function that throws `UnsupportedOnHostError`:

```
env.get needs the env capability, which the node host does not have.
```

So no host writes a refusal, and a host with fewer capabilities is the same code with a shorter list:

```ts
const quiet = nodeHost({ capabilities: ["terminal"] });
quiet.env.get("HOME"); // throws UnsupportedOnHostError
```

Agency turns an error thrown inside a function into a failure result, so a program sees a failed call with that message. A refusing host never reports success for work it did not do.

`requireCapabilities(host, needed, what)` is the one function that reads `host.capabilities`. Code that needs a capability but calls no host function, such as a model call needing `llm`, calls it.

`makeHost` also takes `onUse`, which it calls with the function's name and its capability before any capability function runs. The test runner will use it to record which capabilities a test used.

## The hosts

| Host | File | Capabilities | What it is built from |
| --- | --- | --- | --- |
| `nodeHost` | `lib/host/nodeHost.ts` | all seven | `process`, `os`, `readline`, `crypto`, the real clock |
| `browserHost` | not yet | `network`, `env`, `terminal`, `llm` | values and functions the app passes in |
| `memoryHost` | not yet | whatever the test asks for | scripted answers, `FakeClock` |

Each is a function that returns a `Host`. `nodeHost` takes `{ capabilities, clock, onUse }`, all optional.

### The default host

`lib/host/default.node.ts` exports `defaultHost()`, which returns a `nodeHost`. The runtime imports it as `#default-host`, an entry in the `imports` field of `package.json` that resolves to this file by default and will resolve to `default.browser.ts` under the `browser` condition. `running-without-node.md` explains the mechanism and the three places that have to know about each entry.

`default.node.ts` is the one place that reads the environment variables the test runner uses to ask for a double of part of the host. `AGENCY_FAKE_CLOCK=1` gives the host a `FakeClock`. `AGENCY_FETCH_MOCKS_FILE` names a file of scripted responses, which it installs once per process. `AGENCY_LLM_MOCKS` is about the `LLMClient`, not the host, and `RuntimeContext` reads it.

## How code reaches the host

`RuntimeContext` keeps the host as `ctx.host`. Its constructor takes an optional `host` and uses `defaultHost()` when none is given; a `clock` argument replaces only the clock of that host. `ctx.clock` is a getter for `ctx.host.clock`.

The generated header builds the global context with fixed arguments:

```ts
const __host = __defaultHost();
const __dirname = __host.system.moduleDir(import.meta.url);
const __globalCtx = new RuntimeContext({ ..., dirname: __dirname, host: __host });
```

The header imports no Node module. Agency code may still write `path.join(...)` and `os.homedir()`, which the old header made available by importing Node's modules; they now come from `agency-lang/runtime`, which re-exports Node's `path` and `os` on Node, and the browser entry point will export a portable `path` and a host-backed `os` in their place. Every environment variable it used to read through `process.env`, it now reads through `__host.settings.read`, and it starts `main` when `__host.system.isMainModule(import.meta.url)` says this module is the one the process was started with. `lib/backends/typescriptGenerator/header.test.ts` fails if a Node module comes back.

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

Two runs in one process can have different hosts, which is what lets a test give one run a `memoryHost`.

## The lint rule

A file the browser can reach may not import a Node module or use the globals `process`, `Buffer`, `__dirname`, `__filename`, `require`, or `setImmediate`. The rule is in `eslint.config.js`, over the files in `BROWSER_FILES`: `lib/runtime`, `lib/stdlib`, `lib/simplemachine`, `lib/host`, and the files outside them the runtime imports.

`eslint.node-exceptions.mjs` lists the files that fail it:

- `NODE_ONLY` is for good, with the reason beside each file. `nodeHost.ts` is one; so are the files that run a child process, prompt at a terminal, or load modules from disk.
- `WAITING` is for a file whose Node use a later PR moves into the host. It only gets shorter.

`scripts/lint-browser-reach.mjs`, which `lint:structure` runs, bundles the runtime and the stdlib with esbuild, stopping at every listed file, and fails when the bundle reaches a file `BROWSER_FILES` does not cover, or when a reached file imports one on `NODE_ONLY`. `node scripts/lint-browser-reach.mjs --list` prints what it reached.

## Adding a function to the host

1. Add it to the part's type in `host.ts`. If the part is a capability, add a `NEEDS` entry; the test that walks `nodeHost` fails until you do.
2. Implement it in `nodeHost.ts`, and in `browserHost.ts` and `memoryHost.ts` when they exist. `makeHost` fails at build time for a granted part with a missing function, so a forgotten host is found by the first test that builds it.
3. Call it through `run.ctx.host` or `currentHost()`, and take the file off `WAITING` when nothing Node is left in it.

A function goes on the host when its answer depends on the platform. Joining two path strings does not; it belongs in a portable module. Reading the time does, and so does reading a variable.

## Decisions

- **`terminal.print` takes the values.** `print(obj)` in Agency prints the object the way `console.log` does, and the stdlib's own tests compare that text. A host formats the values; a string would have moved the formatting into the stdlib and changed what every program prints.
- **`settings.log` takes a level.** The logger used to write `info` and `debug` to standard output and `warn` and `error` to standard error. One sink with no level would have sent them all to one stream, which is a change on Node.
- **`Host` has a `name`.** `UnsupportedOnHostError` names the host in its message, and `requireCapabilities` throws it without a host function in hand.
- **`system.isMainModule` is on the host.** The header used to compare `process.argv[1]` with `fileURLToPath(import.meta.url)`. A browser has neither, and answers false.
- **The default host is built per context.** A `FakeClock` has state, and each context used to get its own. Building the host is a loop over seven `NEEDS` entries.
