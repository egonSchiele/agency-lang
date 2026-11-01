# Review, round 2: safeBash runs bash, and a lone `echo -n` runs in process

This is a second review of `docs/superpowers/plans/2026-11-01-safebash-bash-shell-and-echo-n.md`, after the first review was folded in (commit cf555a63a).

I checked the revised plan against the code on this branch. I ran `/bin/bash` (3.2.57, the only bash on this Mac) with the environment variables the plan names and a few it does not. I did not run any tests.

Every first-round finding is folded in correctly. The new findings are in three groups:

1. Fix before building. One environment variable brings back the `echo -n` mismatch, and one test stops testing bash once the chains plan lands.
2. Should fix.
3. Smaller points.

---

## 1. Fix before building

### 1.1 `POSIXLY_CORRECT` puts bash 3.2 back into `sh` mode

When `POSIXLY_CORRECT` is set, bash starts in POSIX mode. On macOS, bash 3.2 in POSIX mode prints `echo` the way `/bin/sh` does, which is the mismatch this plan exists to remove:

```
$ POSIXLY_CORRECT=1 /bin/bash -c 'echo -n hi; echo "|"; echo "a\tb"'
-n hi
|
a	b
```

So with that variable in the environment, a shell-free `echo -n hi` prints `hi`, while the same echo in a chain through bash prints `-n hi` and a newline. A backslash in quotes becomes a tab. Passing `+o posix` on the command line does not help: `POSIXLY_CORRECT=1 /bin/bash +o posix -c 'echo -n hi'` still prints `-n hi`. bash reads the variable after its options.

A user can set this variable in their own shell, and a program can set it with `setEnv`, just as for `BASH_ENV`.

Suggested fix: add `POSIXLY_CORRECT` to `SHELL_ENV_REMOVED`, with the comment "starts bash in POSIX mode; on macOS that changes what `echo` prints". Add a sixth test to Task 1:

```ts
it("ignores POSIXLY_CORRECT: echo -n still drops the newline", async () => {
  const env = { ...process.env, POSIXLY_CORRECT: "1" };
  expect((await shell("echo -n hi", { env })).stdout).toBe("hi");
});
```

On Linux this test passes before the fix, because a GNU build of bash keeps `echo -n` in POSIX mode. On macOS it fails before the fix. Removing the variable also means GNU tools in the child stop reading options in POSIX order. That makes no difference to safeBash's plans, because every flag table that cares already sets `optionsFirst`. Say this in the dev doc's list of removed variables.

### 1.2 `echoIsTheSameAloneAndInAChain` stops testing bash once the chains plan lands

Task 2's node runs `echo 'a\tb'; echo x` to check that bash's echo keeps the backslash in a chain. The cat-and-chains plan makes that exact line a shell-free chain, so after it merges the node compares the in-process echo with itself. The node's one `std::bash` approval in the `.test.json` will also go unused.

Suggested fix: write the chain so the chain planner refuses it and bash runs it: `echo 'a\tb'; echo x; true`. `true` has no rule, so the line is broad, asks `std::bash`, and runs through bash. The expected value is `a\tb\nx\n` either way. Making the change here means the chains plan does not have to find this node.

---

## 2. Should fix

### 2.1 The comment for `ENV` is wrong for `bash -c`

The plan says `ENV` "names a file bash sources before the script". A non-interactive `bash -c` never reads `ENV`, even in POSIX mode. I checked both:

```
$ ENV=$PWD/e.sh /bin/bash -c 'echo hi'
hi
$ ENV=$PWD/e.sh POSIXLY_CORRECT=1 /bin/bash -c 'echo hi'
hi
```

(`e.sh` prints `SOURCED`.) Removing `ENV` does no harm. Either drop it from the list, or keep it with a comment that says it is removed in case a later change runs an interactive or POSIX-mode shell. A comment that names a mechanism that does not happen will mislead the next reader of the list.

### 2.2 `process.env` is not a `Record<string, string>`

`shellEnvironment(env: Record<string, string>)` is called with `options.env ?? process.env`. The type of `process.env` allows `undefined` values, so this will not typecheck. `nodeHost.ts:79-86` already builds a clean copy for `env.all()` by skipping undefined values. Use the same loop, or move it into a helper both call.

### 2.3 Text that still says `sh`, which the plan does not list

The plan changes the `bash` tool's docstring, `runBash`'s docstring, and the host doc. These also describe the old shell:

- `lib/stdlib/shell.ts:193`: "routes the command through `sh -c`".
- `lib/host/node/nodeSubprocess.ts:5-7`: the file header says a program that cannot be started rejects with Node's own error, so a caller can read `ENOENT`. That is now true only for a `program` command.
- `lib/stdlib/abortable.ts:110`: "`abortableSpawn` for a script the platform's shell runs".
- `lib/host/host.ts:256-257`: the `Command` type's comment says "a script for the platform's shell".
- `tests/integration/stdlib-sandbox/fs.agency:18-20`: explains `printf` by saying `_bash` uses `sh -c`, where `echo -n` is not portable.

Add them to Task 1's and Task 2's file lists.

### 2.4 Task 1 Step 3 describes a mapping that does not exist

Step 3 says `lib/stdlib/shell.ts` "near line 41 ... maps `spawn <command> ENOENT` to a missing-cwd message". Nothing maps that error. `resolveSpawnCwd` (`shell.ts:72-90`) checks that the folder exists before anything is spawned, and its comment explains why. The plan's conclusion holds, because a missing bash rejects before spawn and never reaches that code. Change the sentence so the implementer does not look for a mapping to keep.

---

## 3. Smaller points

1. `run` in `nodeSubprocess` is not `async` (`nodeSubprocess.ts:187`), so a throw from `spawnCommand` leaves `run` as a thrown exception, not a rejected promise. `start` is already `async`. The smallest change is to make `run` `async` too. Then both turn the throw into a rejection with no `try`, and the ledger has nothing to record.
2. bash also reads `CDPATH` and `GLOBIGNORE`. With `CDPATH` set, `cd target` goes to `$CDPATH/target` and prints the folder. With `GLOBIGNORE=*`, a glob drops names. Neither changes a narrow plan today, because `cd` and globs are unrecognized. ADI-245 (`cd`) and ADI-247 (globs) will make both matter. `GLOBIGNORE` is read only by bash. `sh` reads `CDPATH` too. Since `SHELL_ENV_REMOVED` is the one list, I would add both now, with a comment naming the ticket each one protects. If not, write them into those two tickets.
3. bash does not take `IFS` from the environment. `IFS=x /bin/bash -c 'set -- $(echo axb); echo $#'` prints `1`. No entry is needed for it.

---

## Claims I checked and found true

1. The first-round findings are all in the plan: the environment scrub, the synchronous lookup, the non-absolute PATH entries, `safeDeleteDirectoryWithin` in a `finally`, the third `echoWords` caller, `exactParityOf`, the quoted-dash rows, the bash 3.2 subset rows, the eval grader in "left out", and the host doc's `ENOENT` sentence.
2. `abortableShell` is the only place that builds a `{ kind: "shell" }` command (`lib/stdlib/abortable.ts:121`), and `_bash` never sets `env`, so the child gets the host's whole environment today.
3. `nodeHost`'s `env.set` writes `process.env` (`lib/host/node/nodeHost.ts:77`), so a variable a program sets with `setEnv` reaches every later child, as Review Focus 0 says.
4. `splitFlags` checks every positional with `refuseQuotedOption` (`stdlib/safeBash.agency:610`), so `echo "-n" hi` and `echo hi "-x"` are refused once `echoText` goes through it, as Task 3 says.
5. The `echo -n hi` row exists in `shellFreeEcho` (`tests/agency/safeBash.agency:149`) and expects the bash path today.
6. `readParityOf` is the exact comparison and `parityOf` the sorted-lines one (`tests/agency/safeBash.agency:662`, `:1034`), so renaming the first to `exactParityOf(source, kind, cwd)` touches only the read rows.
