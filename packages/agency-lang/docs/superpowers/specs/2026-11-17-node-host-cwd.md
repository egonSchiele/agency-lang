# A working folder for the Node host

Status: approved on 2026-11-17 and built in the same PR. What the code
does is in `docs/dev/runtime/host.md`, "The working folder".

## The problem, with an example

Perry's engine is one Node process that runs many agent sessions, each in
its own project folder. Take a session opened on `/Users/me/blog`. The
engine itself was started by the Mac app, so the process's folder is `/`.

The agent reads `/Users/me/blog/notes.txt`. The saved policy has the rule
`recommended` ships with, "reads in the launch folder need no approval",
written as `{.,./**}`. The policy reads `.` as the folder the process was
started in, which is `/`. So the rule does not match, and the user is asked
about every read in their own project.

Start the engine from a terminal in `/Users/me/work` and it goes wrong the
other way: every session, whatever its folder, gets reads under
`/Users/me/work` approved without a question.

I ran both cases with a real session. `agency agent` never shows this,
because its process is started in the project.

The same gap is there for a plain function call. `read("notes.txt")` called
as a function resolves against the process's folder, so in Perry it reads
`/notes.txt`.

## What already exists

Agency has two folders, and they are different things on purpose.

| | Value | Who can change it | Who reads it |
| --- | --- | --- | --- |
| `cwd()` | Where the program was run | Nobody, during a run | A relative path in a function call; a policy's `.` |
| The agent cwd | Set with `setAgentCwd` | The program, and the model | Tools bound with `useAgentCwd: true` |

`cwd()` comes from the run's host: `host.system.cwd()`. A run can already
carry its own host (`InvocationOptions.host`), and two runs in one process
can have different hosts. `memoryHost` and `browserHost` already take a
`cwd` option. `nodeHost` does not: its `cwd()` is always `process.cwd()`.

So nothing new is needed as a concept. What is missing is the one option
on the Node host.

## The change

`nodeHost` takes a `cwd`:

```ts
import { nodeHost } from "agency-lang/runtime";

const host = nodeHost({ cwd: "/Users/me/blog" });
const result = await main({ host, callbacks, policy });

// A resume does not remember the host, so it is given again, as today.
await respondToInterrupts(interrupts, responses, { invocation: { host, policy } });
```

- **It is set once, when the host is built, before the run starts.** A
  host has no function that changes it. A run cannot swap its host.
- **Only the TypeScript program that starts the run can set it.** There is
  no Agency function for it, so neither Agency code nor a model can move
  it. `setAgentCwd` stays as it is and stays separate.
- **With no `cwd`, nothing changes.** `cwd()` is the process's folder,
  read at the time of each call, as today. `agency run`, `agency agent`
  and every existing caller behave exactly as before.
- **`cwd` must be an absolute path.** `nodeHost` throws on anything else,
  when the host is built.

For a run whose host has a `cwd`, these all mean that folder:

| What | Example with `cwd: "/Users/me/blog"` |
| --- | --- |
| `cwd()` in Agency code | returns `/Users/me/blog` |
| A relative path in a function call | `read("notes.txt")` reads `/Users/me/blog/notes.txt` |
| `.` in a policy's `dir` pattern | `{.,./**}` covers `/Users/me/blog` and below |
| A shell command given no folder | `exec("ls")` lists `/Users/me/blog` |
| The base an allow-list is measured against | `ls(".", allowedPaths: ["."])` |

## How it is built

Most of the code already asks the host: 29 places read
`host.system.cwd()`, among them the policy directories, `resolveCwdPath`,
the allow-list check and `cwd()` itself. Those follow the option with no
change.

Three places in the Node host read the process directly and have to
follow the host's folder:

1. **`system.cwd()`** in `lib/host/node/nodeHost.ts` returns the option
   when it was given.
2. **The file part.** `lib/host/node/nodeFiles.ts` resolves a relative
   `dir` with `path.resolve(process.cwd(), …)` in five functions (`root`,
   `fixedRoot`, `fixedPath`, `wholePath`, `locateSync`). That module is
   also called with no host, by the compiler and the local-model code. So
   each of the five takes the base folder as a parameter that defaults to
   the process's folder, and the host's file part and `system.realDir`
   pass the host's folder.
3. **The subprocess part.** `lib/host/node/nodeSubprocess.ts` starts a
   child in `options.cwd`, and in the process's folder when the caller
   gave none. With the option, "none" means the host's folder.

A few readers of `process.cwd()` are about the process and not about a
run, and stay as they are: loading provider modules, the log file path a
subprocess inherits, the local model provider, and the search for
`agency.json` by the local-model commands.

A program run in a child process (`run` in `std::agency`, `spawn`) gets a
default host of its own in the child. The child has to be started in the
parent run's folder, or it would see the process's folder again. `spawn`
already reads `host.system.cwd()`. The `fork` in `lib/runtime/ipc.ts` did
not: a test showed the child in the process's folder, so `_runFor` now
starts it in the run's folder.

## Safety

- **The folder a policy trusts cannot be moved from inside a run.** That
  is the reason there is no `setCwd()`. A policy's `.` says "reads here
  need no approval". If code in the run could move it, a model could point
  it at any folder and read there unasked.
- **A host is a TypeScript object.** It cannot arrive in JSON, so a caller
  of a served agent cannot send one.
- **A resume must be given the same host.** A resume with no host falls
  back to the process's folder, and `.` would then mean a different folder
  than it did before the pause. That is already how hosts work, and it is
  already what happens when `agency agent --resume` is run from another
  folder. This change adds no check for it. The caller is responsible, as
  it is for the policy and the callbacks.

## What is not in this change

- No change to `setAgentCwd`, `getAgentCwd` or `useAgentCwd`.
- No `setCwd()` in Agency.
- No change to `browserHost` or `memoryHost`, which have the option.
- Nothing saves the folder in a checkpoint.

## How it will be tested

- **Unit, `lib/host/node`:** `nodeHost({ cwd })` reports the folder; a
  relative path is refused at build; the file part resolves `.` and a
  relative `dir` against it; `realDir(".")` is it; a command with no
  folder runs in it; and with no option every one of those is the
  process's folder, as today.
- **The shared file battery** (`lib/host/files.shared.test.ts`) runs
  against a Node host with a `cwd` as well.
- **Policy:** `resolvePolicyDirs(nodeHost({ cwd }))` gives that folder, and
  a `{.,./**}` rule approves a read under it and not one under the
  process's folder.
- **Two runs in one process, an agency-js test:** each run gets a host
  with a different folder. In each, `cwd()` returns its own folder,
  `read("notes.txt")` reads its own file, and a policy with `{.,./**}`
  approves the read in its own folder and asks for the other's.
- The Agency suite runs in CI. Locally I run only the tests above.

## After this

Perry gives each session `nodeHost({ cwd: sessionFolder })`, on the first
step and on every resume. Its core keeps calling `setAgentCwd` with the
same folder, so the two start equal, as they do in `agency agent`.
