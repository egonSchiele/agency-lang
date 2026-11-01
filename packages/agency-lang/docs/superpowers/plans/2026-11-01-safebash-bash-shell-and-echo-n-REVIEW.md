# Review: safeBash runs bash, and a lone `echo -n` runs in process

This is a review of `docs/superpowers/plans/2026-11-01-safebash-bash-shell-and-echo-n.md`.

I checked the plan against the code on this branch (5f2b4db74). I ran the bash parser from the main checkout's build, which pins the same tarsec 0.5.6. I also ran `/bin/bash` (3.2) and `/bin/sh` on this Mac. I did not run any tests.

The findings come in three groups:

1. Fix before building. One of these lets code run that no question named.
2. Should fix. These are gaps in the tests and the scope.
3. Smaller points.

At the end there is a list of the plan's claims that I checked and found true.

---

## 1. Fix before building

### 1.1 bash runs code from the environment that `sh` ignores

Here is the case, on this Mac:

```
$ printf 'echo FROM-BASH-ENV\n' > benv.sh
$ BASH_ENV=benv.sh /bin/bash -c 'echo hi'
FROM-BASH-ENV
hi
$ BASH_ENV=benv.sh /bin/sh -c 'echo hi'
hi
$ env 'BASH_FUNC_git()=() { echo FAKE-GIT; }' /bin/bash -c 'git status'
FAKE-GIT
```

A non-interactive `bash -c` sources the file `BASH_ENV` names before it runs the script. bash also imports a shell function from any variable named `BASH_FUNC_<name>()` (bash 3.2) or `BASH_FUNC_<name>%%` (bash 4.3 and later). dash ignores both, and so does macOS `sh`, which is bash in POSIX mode.

After this plan, a narrow `git status` that the person approved as `std::git::status` would run the `BASH_ENV` script first, and with an exported `git` function it would not run git at all. That breaks the first rule in the dev doc: the payload describes what bash is about to do.

These variables can get into the environment in two ways:

1. A program can set them with `setEnv`. That asks `std::setEnv`, and a person who approves `setEnv("BASH_ENV", "/tmp/x")` has no reason to think every later shell command will run `/tmp/x`.
2. The user's own shell can export them. HPC clusters with Lmod export `BASH_FUNC_module%%`, for example.

Suggested fix: in the `{ kind: "shell" }` branch of `spawnCommand`, build the child's environment from `options.env ?? process.env` with these removed:

- `BASH_ENV` and `ENV`;
- every name that starts with `BASH_FUNC_`;
- `SHELLOPTS` and `BASHOPTS`. The bash manual says bash 4.1 and later read `BASHOPTS` from the environment, and `BASHOPTS=xpg_echo` would make `echo` read escapes again. I could not test that here, because bash 3.2 does not read it.

Add a test for each. Point `BASH_ENV` at a script that writes a marker file, run `echo hi`, and check that the marker does not exist. Export a `git` function in both spellings, run `git --version`, and check that the output is git's. Doing this in the host covers the `bash` tool as well as safeBash.

### 1.2 Task 1's restructure does not fit `startChild` as it is

The plan says to do the lookup in `startChild` "since it already returns a promise for `ended`". But `startChild` also returns `child` and `kill` synchronously, and `nodeSubprocess.start` hands `kill` to its caller at once (`lib/host/node/nodeSubprocess.ts:188-195`). If the spawn waits on an async `fs.stat` walk, then a `kill()` that arrives before the spawn has no child to kill, and the abort-signal wiring runs against a child that does not exist yet.

There are two ways to keep it simple:

1. Look bash up synchronously with `fs.statSync` and `fs.accessSync` inside `spawnCommand`, and throw the "bash was not found" error from there. In `run` and `start`, turn that throw into a rejected promise.
2. Resolve bash once, in `run` and `start`, before `startChild` is called, and pass the absolute path in. When it is missing, return `Promise.reject(...)` without calling `startChild`.

Either way, say which in the plan, so the implementer does not rebuild `startChild` around a deferred spawn.

While writing `locateProgram`, skip PATH entries that are not absolute. `path.resolve(dir, program)` resolves an entry such as `.` or `node_modules/.bin` against the parent's working directory, which is a folder the agent writes into. A file the agent writes there named `bash` would then run every safeBash command. Today's `spawn("sh")` has the same exposure through Node's lookup, so this is not new. But the plan now owns the lookup, so the fix costs one line.

### 1.3 `echoWords` has a second caller

Task 3 changes `echoWords(command)` to `echoWords(positionals)`. `agencyCommandPlan` also calls `echoWords(command)` (`stdlib/safeBash.agency`, inside `agencyCommandPlan`), to turn `agency test x.test.json` into arguments. Add it to the task's file list and change it to `echoWords(command.args)`. That keeps today's behavior, where a flag word on an `agency` line makes it refused.

### 1.4 The vitest tests delete with `fs.rmSync`

The three tests in Task 1 clean up with `fs.rmSync(dir, { recursive: true })`. `docs/dev/contributing/anti-patterns.md` ("Not using safeDelete when deleting files") asks for `safeDeleteDirectoryWithin(os.tmpdir(), dir)` from `lib/utils.ts`. Use it, and put the cleanup in a `finally`, so a failing `expect` does not leave the folder behind.

---

## 2. Should fix

### 2.1 A third copy of the parity helper, and plan 2 depends on a fourth

The test file has `parityOf` (grep: sorted lines, `FIXTURES`) and `readParityOf` (exact, `READ_FIXTURES`). Task 3 adds `echoParityOf`, a third copy of the same steps: check the execution kind, run `safeBash` and `bash` under `with approve`, then compare.

The cat-and-chains plan then calls `parityOf(source, kind, cwd)`, "the helper the bash plan generalized". This plan never generalizes it. So plan 2 cannot run as written.

Suggested fix: in Task 3, replace `readParityOf` with `exactParityOf(source: string, kind: string, cwd: string)`. Use it for the echo rows, and tell plan 2 to use the same name. Keep the grep `parityOf` as it is, because it compares sorted lines.

### 2.2 Pin the quoted-dash echo

Today `echo "-n" hi` plans as a shell-free echo that prints `-n hi` and a newline. `literalWordText` accepts a double-quoted `-n` as text. Under macOS `sh` that matches, because its echo prints `-n hi` too. Under bash it does not: bash strips the quotes, sees the option, and prints `hi` with no newline.

So between Task 1 and Task 3 there is a real mismatch. Task 3 fixes it, because `splitFlags` refuses a quoted word that starts with `-`. Add two rows so the fix is pinned:

- `planDetail("echo \"-n\" hi")` expecting `["bash","",["std::bash"]]`;
- in `shellFreeEchoMatchesBash`, a row that checks `echo '-e' x` is not shell-free.

Task 3 also refuses `echo hi "-x"`, which is shell-free today. bash prints `hi -x` for it, so this is a small loss, and it fails safe. Say so in the dev doc's echo sentence.

### 2.3 Pin the bash 3.2 subset

The new dev doc section says the parser accepts what bash 3.2 accepts. That is true today. I checked: `make |& tail` and `echo hi &>> log` are unparseable, and `/bin/bash` 3.2 rejects both with "syntax error near unexpected token". A later tarsec release could accept them, and macOS would then fail on a narrow plan. Add both to `newShapes`, or to a node of their own, expecting `unparseable`.

### 2.4 The goal says "every shell script a host runs"

`lib/eval/gradersJson/build.ts:214` spawns `sh -c` itself, outside the host. That is a grader command, not safeBash. Narrow the goal to "every `{ kind: "shell" }` command the host runs", or say in Task 4's "left out" that the eval grader still uses `sh`.

### 2.5 The host contract sentence

`docs/dev/runtime/host.md` says "A program that cannot be started rejects with the platform's error (`ENOENT` on Node)." A missing bash now rejects with the plan's own message, so Task 2's edit to "The subprocess part" should change that sentence as well. Today it only adds a new one.

---

## 3. Smaller points

1. `locateProgram` runs a `stat` per PATH entry on every shell command. Caching the result per PATH string is cheap. It is optional, but an agent turn can run dozens of commands.
2. `flagNames` cannot be deleted. `effectsFor` computes `const flags = flagNames(command)`, and the git arm passes it to `gitEffects`. The plan says to check, and this is the answer.
3. Task 2's Step 1 asks the implementer to check that `&>` parses. It does: `echo hi &> out.txt` parses to a redirect with op `&>`. `redirectEffect` then refuses it ("`&>` is not an output redirect"), so the line is broad, which is what the test assumes.
4. The `echoIsTheSameAloneAndInAChain` node raises no question for the lone echo, so the one approve handler in the `.test.json` is used by the chain only. That is right. Say it in the node's comment, so a reader does not look for a second question.

---

## Claims I checked and found true

1. `spawnCommand` runs `spawn("sh", ["-c", script])` at `lib/host/node/nodeSubprocess.ts:51`, and `abortableShell` passes `"sh"` twice (`lib/stdlib/abortable.ts:117` and `:130`).
2. `RunOptions.env` is the child's whole environment (`lib/host/host.ts:264`), so the third test's `{ env: { PATH: empty } }` gives the lookup an empty search path.
3. macOS `/bin/sh -c 'echo -n hi'` prints `-n hi`. `/bin/bash -c` prints `hi` with no newline.
4. The only `HostSubprocess` implementations are `nodeSubprocess` and `memoryHost`, which refuses every command unless a test passes one. So no other host needs the change.
5. The eval Docker image is `node:22-bookworm-slim`, which ships bash.
6. `splitFlags` with `optionsFirst: true` refuses `echo hi -n` with the late-flag message. A combined `-nn` reads as two `n` letters, and `echo -nx` fails on `x`, which is right, because bash prints `-nx` as text.
