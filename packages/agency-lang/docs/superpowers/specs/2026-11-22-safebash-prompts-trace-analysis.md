# safeBash prompts in trace 25jnjA6u

An analysis of one `agency agent` session (Perry) from 2026-11-22: which
bash commands asked the owner for approval, why safeBash could not answer
them itself, and why the session went badly.

- Log: `~/.agency-agent/perry-log.jsonl`
- Trace: `25jnjA6uZK3QUpQjp7eh8` (110 LLM calls, 97 minutes, $0.54,
  model `z-ai/glm-5.3-flash`)

## How the numbers were counted

Each bash call logs a `safeBash plan` debug event with the command, the
outcome (`narrow`, `broad`, `shellFree`), and, for a broad outcome, the
reason. Each interrupt logs an `interruptResolved` event. An interrupt
with `resolvedBy: null` went to the owner. One with `resolvedBy:
"handler"` was answered by the saved policy.

The agent ran 47 bash command lines. 21 of them asked the owner at least
one question. 15 of those were broad questions, and 6 were narrow ones.

## Broad questions (15)

A broad question is the `std::bash` interrupt. safeBash raises it when it
cannot describe what the line will do, so it asks about the whole line.

| Why safeBash gave up | Count | Should safeBash catch it? |
|---|---|---|
| A glob in a path ("the grep path is not literal") | 6 | Yes |
| A path that does not exist | 4 | Yes |
| No rule for `git worktree add` | 1 | Yes |
| `find` with `-o` ("find takes `-name` only once") | 1 | Yes |
| No rule for `cp` | 1 | Yes |
| A command after `\|\|` follows a `cd` | 1 | No. The owner decided this is not worth fixing. |
| `python3 -c` reading a pipe | 1 | No. It runs arbitrary code, so asking is correct. |

### A glob in a path (6)

```bash
grep -rn "origin" tests/agency/structured-interrupts/*.agency tests/agency/safeBash*.agency 2>/dev/null | head -10; echo ----; grep -rn '"origin"' lib/runtime/interrupts.ts | head
grep -rn "origin" docs/dev/compiler/hoist-calls.md | head -3; grep -rn "origin" docs/site/guide/interrupts.md | head -6; grep -rn "origin" lib/compiler/*.ts 2>/dev/null | grep -i "module\|inject" | head -8
grep -rn "origin" lib/runtime/interrupts.ts 2>/dev/null | head -5; grep -rln "origin" lib/runtime/*.ts | head -8
grep -rn "origin" lib/compiler/codegen/*.ts 2>/dev/null | grep -i "module\|inject\|origin" | head -8; grep -rn "origin:" lib/backends/typescriptBuilder.ts | head -8
grep -rn "agency-lang/stdlib-lib\|resolve.*stdlib-lib" lib/backends/typescriptBuilder.ts | head -5; grep -rn "stdlib-lib" lib/backends/*.ts | grep -v test | head -8
ls stdlib/*.js 2>/dev/null | head -3; ls stdlib/ | head -5; find . -maxdepth 2 -name "*.mjs" -path "*shim*" | head -3
```

(Each line started with `cd <package dir> &&`, left out here.)

The folder part of every glob is a fixed path: `lib/runtime/`,
`lib/compiler/`, `stdlib/`, `tests/agency/`. Only the file name holds the
`*`. Five of the six are `grep`. One is `ls`.

### A path that does not exist (4)

```bash
grep -rn "origin" lib/runtime/policy.ts | head -20 && echo ---- && grep -rn "origin" lib/runtime/interrupts.ts lib/runtime/run.ts 2>/dev/null | head -20
grep -rn "origin" lib/host/node/nodeLLM.ts 2>/dev/null | head -3; grep -rn "origin:" lib/runtime/promptRunner.ts lib/runtime/prompt.ts 2>/dev/null | head -8; ...
grep -rn "origin" lib/compiler/typescriptBuilder.ts | head -8; echo ----; grep -rn "__origin\|originModule\|module path" lib/compiler/typescriptBuilder.ts | head -6
ls dist/scripts/agency.js 2>/dev/null || echo "no dist"; which node
```

The agent expected the file might be missing in three of the four: the
lines have `2>/dev/null` or `|| echo`. The cause is in
`_searchTarget` (`lib/stdlib/shell.ts:549`). It throws "No file or
directory at …" when the path does not exist. The message is written for
the model, but it fires while safeBash is still planning, so the whole
line falls back to a broad question. A grep of a file that does not exist
reads nothing, and in a shell it prints an error and carries on.

The owner rejected the third line, which was the only rejection in the
run.

### No rule for `git worktree add` (1)

```bash
cd /Users/adityabhargava/agency-lang && git worktree add packages/agency-lang/.worktrees/command-judge -b adit/safebash-command-judge main && cd packages/agency-lang/.worktrees/command-judge && git branch --show-current
```

safeBash has a rule only for `git worktree list`
(`stdlib/safeBash.agency:3310`). The message the log records is "git
worktree does not take `-b`", because the flag check runs before the
subcommand check. The message points at the wrong cause.

### `find` with `-o` (1)

```bash
ls dist/ 2>/dev/null; find dist -name "safeBash.js" -o -name "policy.js" 2>/dev/null | head -4
```

### No rule for `cp` (1)

```bash
cp packages/agency-lang/2026-11-22-safebash-decision-model-plan.md packages/agency-lang/2026-11-22-safebash-decision-model-plan-review.md packages/agency-lang/.worktrees/command-judge/ && ls -la packages/agency-lang/.worktrees/command-judge/2026-11-22* && rm packages/agency-lang/2026-11-22-safebash-decision-model-plan.md packages/agency-lang/2026-11-22-safebash-decision-model-plan-review.md && echo "moved"
```

The agent was moving two files. The line also has an `ls` with a glob.

### A command after `||` follows a `cd` (1)

```bash
cd <worktree>/packages/agency-lang && ls && sed -n '1,30p' makefile 2>/dev/null || sed -n '1,30p' Makefile 2>/dev/null
```

### `python3 -c` reading a pipe (1)

```bash
ls node_modules/ | head -20 && cat package.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('devDependencies',{}).get('agency-lang','MISSING'))"
```

## Narrow questions (6)

A narrow question names one step, such as `std::exec` for one program or
`std::write` for one file. safeBash understood these lines, and the
owner's policy had no rule that answered the question.

| Command | Question | Should it ask? |
|---|---|---|
| `pnpm install --frozen-lockfile` | `std::exec` | Yes. Install scripts run code. |
| `make build > /tmp/build-stage1.log 2>&1` | `std::exec` and `std::write` | The `make` question, yes. The `/tmp` write is the scratch-folder idea already queued. |
| `node ./dist/scripts/agency.js run tests/agency/zz-probe-origin.agency` | `std::exec` | Yes. It runs code. |
| `readlink <path>` | `std::exec` | No. `readlink` only reads a link. |
| `node -e "console.log(require.resolve(...))"` | `std::exec` | Yes. It runs code. The run is paused on this one. |

The agent's `write` tool also asked once, to write a probe test file in
the worktree. That is a policy question, outside safeBash.

## What safeBash could have handled

About 12 of the 21 questions: the 6 globs, the 4 missing paths, `git
worktree add`, `find -o`, `cp`, and `readlink`. That counts 13 lines, and
the `cp` line also holds a glob.

## Why the session went badly

1. **The wrong build sent the agent after an error that was not there.**
   The coordinator gave stage 1 of the plan to `agencyCodeAgent` with the
   instruction "Build the package". The code agent ran `make build`, which
   does not compile the stdlib. Its probe test then crashed with
   `ERR_MODULE_NOT_FOUND … stdlib/index.js`. Its last 14 calls searched
   `node_modules`, the pnpm store, `readlink`, `python3`, and
   `require.resolve` for a module-resolution bug. Running `make` would
   have fixed it. In 35 calls it wrote one probe file and no code.
2. **The context was very large.** The code agent inherits the whole
   conversation, so it started at about 165k tokens. The coordinator's
   call 72 sent 185k input tokens with none cached. A small model loses
   track in that much history.
3. **The coordinator guessed file paths.** Before the owner cancelled
   the turn, it grepped files that do not exist (`lib/runtime/run.ts`,
   `lib/host/node/nodeLLM.ts`, `lib/compiler/typescriptBuilder.ts`). It
   was doing the plan's probe research by guessing. Those guesses caused
   three of the missing-path questions.
4. **It retried a failing edit unchanged.** A multi-edit of the plan
   failed three times with "edit #6 oldText not found" before the agent
   rewrote the whole file.
