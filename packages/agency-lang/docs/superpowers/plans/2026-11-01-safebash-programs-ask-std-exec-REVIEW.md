# Review: Programs with no rule of their own ask `std::exec` (ADI-243)

Plan: `docs/superpowers/plans/2026-11-01-safebash-programs-ask-std-exec.md`

## Verdict

The shape is right. Raising `std::exec` at the one spot where `otherVerbEffects` fails with "no rule for" is the smallest change that gives the ticket what it wants, and the ownership argument holds: I read `effectsFor` and the arms, and `git push`, `find . -delete`, and `tail -f` all fail inside their own arm or row, so they can never reach the new step. Reusing `std::exec` instead of a new effect was settled in the spec and I agree with it.

One thing blocks the plan as written. Bash builtins have no rule today, so they reach the same "no rule for" spot, and the plan would turn every one of them into a `std::exec`. That breaks the truthful-payload rule for `cd` and for the builtins that rebind what a later command runs. The fix is one more list, and it also removes most of the test churn in Task 2. Details below.

## Blocking: bash builtins must not become `std::exec`

I ran `planFor` on the main checkout (same code as this branch) with the fixtures folder as cwd. Every one of these is "no rule for" today, so under the plan each becomes a narrow `std::exec`:

| Line | Today | Under the plan | Why that is wrong |
|---|---|---|---|
| `cd .. && cat one.txt` | broad, "no rule for `cd`" | `std::exec { cd, .. }` + `std::read { <fixtures>, one.txt }` | bash reads the parent folder's `one.txt`. The read payload names a file that is not read. This is the mismatch ADI-245 exists to handle carefully. |
| `hash -p /tmp/x git; git status` | broad | `std::exec { hash, -p }` + `std::git::status` | `hash -p` makes `git` run `/tmp/x`. `recommended` approves the git half, and the question the person sees is about `hash`. |
| `enable -f /tmp/x.so git; git status` | broad | `std::exec { enable, -f }` + `std::git::status` | `enable -f` loads a shared object as a builtin named `git`. Same as above. |
| `export NODE_OPTIONS=--require=x; pnpm test` | broad | `std::exec { export, NODE_OPTIONS=... }` + `std::exec { pnpm, test }` | The plan keeps `NODE_OPTIONS=x pnpm test` broad on purpose. This spelling does the same thing in two commands. |
| `set -e; git status`, `shopt -s xpg_echo; echo 'a\tb'`, `test -f x && ...`, `true`, `false` | broad | `std::exec` | Harmless, but the payload says "the exec tool would raise this for the same program", and the exec tool cannot run a builtin at all: `spawn("cd")` is ENOENT. |

The plan's own list already contains some builtins (`eval`, `exec`, `source`, `.`, `command`, `builtin`), so the author saw part of this. The rule should be stated once and cover all of them: **a bash builtin never raises `std::exec`, because the exec tool cannot run it, so no payload of the exec tool's shape can describe it.** The list is `bash -c 'compgen -b'`, 60 names on bash 3.2 and 5. Put them in `BUILTIN_VERBS` beside `WRAPPER_VERBS`, drop the builtins from `WRAPPER_VERBS` so the wrapper list holds only programs, and fail with a message that says what happened, such as `` `cd` is a bash builtin, not a program ``. The `xargs` fixture is unaffected because `xargs` stays in the wrapper list with the "no rule for" text.

What this changes elsewhere in the plan:

- Task 2's "Rows that change meaning" shrinks. `true` and `false` stay broad, so `nonZeroExitIsAFailure`, `sequenceRunsThroughBash`, `echoIsTheSameAloneAndInAChain`, and the `echo a; true` row in `chainsOfInProcessCommands` keep their strings, their expectations, and their comments. Only `make 2>&1 | tail -100` and `rg hello .` change, which is what the ticket is about.
- `programsAskStdExec` should gain the rows `cd .. && cat one.txt`, `hash -p /tmp/x git; git status`, and `export X=1; pnpm test`, each expecting `std::bash` with the builtin message. The `cd` row is the one that protects ADI-245's design space.
- The dev doc section gets one more exception with its reason, and the ordering list in the spec's Part 6 should say builtins sit with the wrapper verbs.

## Should fix

**`npx`, `bunx`, `uvx`, and `pipx` fit the wrapper definition.** The plan defines a wrapper as a program that exists to run another program, where a rule keyed on the wrapper would approve anything. `npx -y foo` has subcommand `-y`, so "approve always" on it saves `{ npx, -y }`, which then covers every package. The spec's list predates this thought and the plan may depart from it. `pnpm dlx` and `npm exec` are different: they are keyed on the subcommand, so a rule for them names the behaviour. Owner's call, but I would add the four.

**State the three payload differences, not one.** The plan and the doc say a glob argument is the one place the safeBash payload differs from the exec tool's. There are three:

1. A glob word is carried unexpanded and bash expands it. (In the plan.)
2. An unquoted `~` in an argument is carried as written and bash expands it. `node ~/x.js` is literal to `literalWordText`, and `execArgs` would carry `~/x.js`. Same treatment as the glob, same sentence in the doc.
3. The environment. The exec tool spawns with the process environment (`nodeSubprocess.ts`, the `program` branch passes `options.env` through). safeBash's bash runs with `shellEnvironment(env)`, which strips `BASH_ENV`, `BASH_FUNC_*`, and the rest. So a program approved through safeBash runs with slightly less than the same program approved through the exec tool. That is the safe direction, and worth one sentence.

**Say what `cwd` means for a hand-written rule.** The owner's stated case is "pre-approve `pnpm test` in a directory". "Approve always here" pins only `command` and `subcommand` (`@always` on the effect, built by `buildScopedMatch`), so that case needs a hand-written rule with a `cwd` glob. From safeBash, `cwd` is always the resolved absolute folder, while from the exec tool it is whatever the model passed, often `""`. So a `cwd` rule written for safeBash will not match the same program through the exec tool unless the model passes an absolute cwd. The paragraph planned for `approval-policies.md` should say this.

**Two more Review Focus rows worth pinning.** `pnpm test | grep -v warn` should be narrow with `std::exec` alone, because the grep reads the pipe and `stdinStage` returns its redirects. `cat one.txt | pnpm test` must be broad under the plan's own rule 2. The first is the pleasant case the ticket buys, the second is the guard against it.

## Questions for the owner

**Should a lone `pnpm test` run through `_exec` instead of bash?** The dev doc's rule is "a lone command that translates runs its stdlib tool in process". A lone program line with no glob, no tilde, no redirect, and no pipe translates exactly to `exec(verb, args)`. The plan keeps bash for every `std::exec` plan and says so. I think that is fine for this round, because the two paths differ only in the environment scrub and nothing else is gained, but the doc's table row for `pnpm test` must then say why this family is the exception to the lone-command rule, or a later reader will "fix" it.

## Nits

- The contract check in Task 1 will almost certainly pass on the first try. The header comment says a declaration comes with an import from its module, and `safeBash.agency` already imports `bash, grep, ls, glob` from `std::shell`, which is where `std::exec` is declared. The `std::ls` raise is checked through that same import today. Keep the misspelling probe, drop the alias-import branch unless the probe fails.
- `execEffects` takes `readsStdin` and then also reads `command.redirects` for `<`. Say in its doc comment why the redirect check reads the command and not the effects: the `<` has already become a `std::read` effect by then, and the effect does not say which command it belonged to.
- Putting the full line in `line` and not `command` is right, and the plan's reason is right. Extra fields on a raise are allowed: `std::ls` declares no `command` field and `raiseOne` passes one today.

## Verified against the code

- `otherVerbEffects` (stdlib/safeBash.agency:420) ends in `failure("no rule for ...")` after the `LIST_VERBS` and `READ_VERBS` lookups, and `effectsFor` (357) owns `echo`, `grep`, `git`, `tr`, and `find` by name, with the non-literal command word and leading assignment checks in front. The plan's description of where the step goes is exact.
- `planFor` (2178) runs the refuse wall per flattened command before `effectsFor`, so `rm` and destructive git never reach the step.
- `std::exec` is declared in stdlib/shell.agency:44 with `@always(command, subcommand)`, and the exec tool raises it with the message and fields the plan copies. `recommended` carries only the `agency` rules (`agencyExecApproveRules`).
- `literalWordText` accepts `literal`, `path`, `singleQuoted`, and all-literal `doubleQuoted` words, so `node ./x.js` is literal and `./gradlew` as a command word is refused earlier by the `name.tag != "literal"` check.
- `pipelineCommands` marks every command after the first stage as reading stdin, so rule 2 sees `python3` in `git log | python3 x.py`.
- The agency-js fixture pins `no rule for \`xargs\`` and `xargs` stays a wrapper, so the text survives.
