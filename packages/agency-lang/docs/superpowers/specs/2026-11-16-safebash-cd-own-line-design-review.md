# Review: safeBash, a `cd` on its own line

Spec: `docs/superpowers/specs/2026-11-16-safebash-cd-own-line-design.md`

## Verdict

The design is sound. I recommend a yes, with the small changes below.
None of them changes the design. The guard keeps safeBash's first rule:
every command after the guard runs in the folder its payload names, or
it does not run.

I checked each factual claim in the spec against the code on this
branch. All of them hold. The details are in "What I checked" at the
end.

## Findings

### 1. The "one thing to check before building" can be answered now

The job path runs the text the same way the foreground path does. Both
hand it to the host as `{ kind: "shell", script }` with nothing around
it:

- The foreground path: `runBash` calls `_bash`, which calls
  `abortableShell` (`lib/stdlib/abortable.ts:123`).
- The job path: `_startJob` calls `addJob`, which calls
  `host.subprocess.start` (`lib/runtime/jobs/jobTable.ts:104`).
- Both end at `spawn(bash, ["-c", command.script])`
  (`lib/host/node/nodeSubprocess.ts:158`).

The text is never wrapped in a function and never sourced. So `exit 1`
ends the job's script the same way it ends a foreground script.

A function cannot shadow the guard's `exit` either. The host already
removes `BASH_ENV` and every `BASH_FUNC_*` variable before bash starts,
which is the same protection the rewritten `cd` relies on today.

Suggested edit: replace the section with these facts, so the spec has no
open question left.

### 2. Should a trailing `cd` stay broad?

The spec keeps a lone `cd` broad when it is the last command. This line
is common in model output:

```
cd packages/agency-lang
make
cd ..
```

Under the spec, the trailing `cd ..` makes the whole line ask
`std::bash`, though `make` could be asked about narrowly. The reason the
spec gives is that the last `cd` "moves nothing that runs." That is true,
but it is a reason the `cd` is harmless, not a reason it is unsafe.

The guard design handles it with no new rule. The `!last` condition can
be dropped from the `cd` branch in `classifyAll`, and the line runs as:

```
cd '/abs/packages/agency-lang' || exit 1; make; cd '/abs' || exit 1
```

Every payload stays true. A line that is only `cd x` still asks
`std::bash`, because it raises no effect and `bashPlan` turns an empty
effect list into `std::bash`.

`!last` was needed in PR #1487, because a carried `cd` needed a command
after it to attach to. The guard has no such need.

This is the owner's call. If the answer is no, the spec should give a
reason other than "it moves nothing."

### 3. Reason 2 claims a little more than it delivers

Reason 2 says that with one `cd`, a later command cannot be sent
somewhere else by a folder swap. That is true for the folder.

It is not true for the files inside it. In both designs, an approved
command `a` can replace `lib/importPaths.ts` with a link to another file
before `b` reads it. The payload for `b` was resolved when the plan was
made. That gap exists today for `cd x && a && b` too, and it is not this
change's job to close it.

Suggested edit: say that the guard closes the folder swap, and keep the
reason. Without that limit, a reader could think the guard closes every
swap.

### 4. Reuse the existing word helpers in `cdOrExit`

`insideRepository` builds the same kind of hand-written command, and it
uses `literalWordOf` for its words. `cdOrExit` should do the same:

```
def cdOrExit(command: SimpleCommand, dir: string): Command {
  const exit: SimpleCommand = {
    tag: "simpleCommand",
    assignments: [],
    command: { tag: "literal", text: "exit" },
    args: [literalWordOf("1")],
    redirects: []
  }
  return { tag: "or", left: cdTo(command, dir), right: exit }
}
```

Two smaller code points:

- Keep the `@capabilities(fileRead)` tag and the docstring on
  `classifyAll`. The sketch drops both.
- Replace the comment above `classifyAll`. The spike's comment describes
  a copy of the `cd` before each command, which this design removes.

### 5. Say what makes test 8 fail

Test 8 runs `cd '/no-such-folder-xyz' || exit 1; echo ran` through the
`bash` tool. On its own, that tests bash, which cannot fail.

What it really guards is the executor: it fails if someone later wraps
the script in a function, a `source`, or a subshell followed by more
text. The test's comment should say that, so nobody deletes it as
redundant.

The test also needs a handler that approves `std::bash`, because the
`bash` tool raises it. The spec should say so.

### 6. Add three rows to the tables and to test 1

These shapes follow from the code but are not written down:

| Line | Result |
|---|---|
| `cd x; cd y; a` | narrow: two guards in a row, `y` resolved from `x` |
| `cd x; echo hi` | broad: no command raises an effect, so `std::bash` |
| `cd x; a; cd ..` | broad under the spec as written; narrow if finding 2 is accepted |

The second row matters most. A reader of the table could expect it to be
narrow.

## What I checked

Each of these claims in the spec matches the code:

- `rebuild` joins the top-level commands with `"; "`
  (`stdlib/safeBash.agency:3716`). The guard renders as
  `cd '/abs/x' || exit 1; a`.
- tarsec's `chainOperandToBash` adds parentheses only for an `and` or
  `or` on the right of a chain, and its comment says the parser never
  builds that shape (`node_modules/tarsec/dist/parsers/bash/astToBash.js:247`).
  The guard puts the `cd` on the left, so no parentheses appear.
- `cdTarget` refuses a missing folder through `resolveTarget`, a file,
  and a path with a single quote. So the guard's `exit` runs only when
  the folder vanished between planning and running.
- `planLine` runs the delete refusal with the launch folder.
  `removeEffects` checks again from the folder the `cd` moved to
  (`stdlib/safeBash.agency:4483`). The spike's `removeAfterCd` test
  confirms `cd ..` then `rm -rf <launch folder>` asks `std::bash`.
- A `gh` lookup uses the folder the command is classified in. A line that
  needs two lookups goes broad in `planLine`, before `resolvedPlan` runs
  the second plan. So one origin can never be applied to `gh` commands in
  two folders.
- `tryShellFreeChain` fails on a `cd` step, because `tryShellFreeStep`
  has no rule for `cd`. The line falls through to `classifyAll`, as the
  spec says.
- A broad plan runs the original text, with no guard. That matches
  today's behavior after a `std::bash` approval.
- `(cd x && a); (cd x && b)` is narrow today, through `classifyGroup`. So
  the policy argument holds: no line becomes narrow that could not
  already be written narrow.
