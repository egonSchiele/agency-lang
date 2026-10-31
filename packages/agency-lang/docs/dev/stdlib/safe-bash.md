# safeBash

`safeBash` (`stdlib/safeBash.agency`) is the shell tool the coding agents
carry. The plain `bash` tool raises `std::bash`, and no policy can safely
pre-approve that effect, because its payload is a string that could do
anything. safeBash reads the command, works out what it does, and asks a
narrower question when it can. A narrower question is one a policy can
answer in advance.

## Decide, then act

`planFor(source, cwd)` is a pure function. It parses the string,
classifies every command, and returns a `Plan`: the effects to raise and
an `Execution` saying what to run if every one is approved. Nothing runs
inside it, which is what makes the decision testable: hand in a string,
read the plan. `safeBash` then raises every effect with `raiseAll`, and
only when all are approved does it run the execution.

The parser is tarsec's bash parser (`lib/parsers/bash/` in the tarsec
repository, re-exported by `lib/stdlib/safeBash.ts`). An unparseable
string is "we understood nothing": the whole string asks `std::bash` and
bash runs the original text.

## The rules

- **The payload tells the truth.** A narrow effect's payload describes
  what bash is about to do. If the classifier cannot fill a payload that
  describes it, the command is unrecognized. safeBash never expands a
  variable or a glob itself; bash does that, which is why a variable in a
  recognized position makes the command unrecognized.
- **All or nothing.** If any command in the string is unrecognized, one
  `std::bash` is raised for the whole string and the original text runs.
  Asking narrow questions and then the broad one would add prompts
  without adding information.
- **Rebuilt text when narrow.** When every command was recognized, the
  text that runs is rendered from the tree that was classified
  (`astToBash`), so a parser bug degrades to running what was read.
- **Every shell spawn raises at least one effect.** A string of nothing
  but echoes still raises `std::bash` (`bashPlan` substitutes it for an
  empty effect list), so the effect log is a complete audit of shell
  invocations.
- **A relabeled effect approves the question, not the bytes.** Approving
  `std::write` for a redirect approves "a write to this file"; the
  content does not exist until bash runs.

## The three outcomes

`refuse`: the refuse wall (`isRefused`) matches `rm`, `rmdir`, `dd`,
`shred`, `mkfs`, `truncate`, and the destructive git spellings, by command
word including the last part of a path. Nothing is raised. The wall is
friction against the obvious spelling; `find -delete` gets past it and is
approvable under `std::bash`, which is where the control lives.

`shellFree`: a single literal `echo`, with or without one output
redirect, never spawns a shell. The output is computed in Agency and
returned, or written with `_write` under a `std::write` whose payload
carries the bytes. An `agency <sub> <file>` line runs in-process through
`std::agency`.

`bash`: everything else. Narrow when every command was recognized
(`git status`, `git log`, `git diff`, `git diff --staged`, a redirect
contributing `std::write`), broad otherwise.

`outcomeOf(plan)` names which of these a plan is (`refuse`, `shellFree`,
`agency`, `narrow`, `broad`) with an exhaustive match over the
`Execution` union, so a new execution kind is a type error there.

## Why a plan went broad

`Plan.broadReason` is null for a narrow, refused, shell-free, or agency
plan. For a broad plan it is `{ kind, detail }`:

| kind | detail |
|---|---|
| `unparseable` | the parser's message |
| `unrecognized` | the first failure message `effectsFor` returned, such as ``no rule for `xargs` `` |
| `noEffects` | `""`; every command was recognized and none raised an effect, so the audit rule asked `std::bash` |
| `unrenderable` | why the tree could not be rendered back to text |

The four broad branches of `planFor` go through `broadPlan`, which is
`bashPlan` with the `std::bash` effect and the reason.

`Plan.verbs` is the command word of every simple command `planFor`
decided over, in order: `""` for an assignment-only command, `[]` when
the string was unparseable.

## The debug event

Every call posts one statelog `debug` event with the message
`safeBash plan`, after `planFor` and before the refusal check, so a
refused plan is on the record too. The bridge is `_debug` in
`lib/stdlib/statelog.ts`, a no-op outside a run. The data:

```
{ command, cwd, outcome, reason, detail, verbs, effects }
```

`reason` and `detail` are the broad reason's fields or `""`; `effects` is
the list of effect names. A session's calls are tallied with a filter
over its JSONL for `debug` events whose message is `safeBash plan`.
There is no dedicated event type.

## What the model reads on a rejection

When the broad question is rejected and the plan has a `broadReason`, the
failure the model reads is the rejection text followed by one sentence
from `BROAD_SENTENCES`, keyed by kind, with the detail appended when
there is one:

```
interrupt rejected safeBash could not ask a narrower question because it has no rule for one of the commands: no rule for `xargs`.
```

A rejected narrow question carries no reason and reads as the rejection
text alone.

## Why the executors call `_bash` and `_write`

The `bash` and `write` tools raise their own interrupts. Calling them
after `raiseAll` would ask the broad question a second time. The bypass
is correct for one reason: the only path to an executor runs through a
`raiseAll` that raised every effect in the plan and returned success, and
every plan raises at least one effect.

## Files and tests

- `stdlib/safeBash.agency`: the classifier, `planFor`, `safeBash`.
- `stdlib/safeBash/actions.agency`: `Plan`, `BroadReason`, `Effect`,
  `Execution`, and the executors.
- `lib/stdlib/safeBash.ts`: the tarsec re-export.
- `lib/stdlib/statelog.ts`: `_debug`.
- `tests/agency/safeBash.agency`: plan tests (`planReasons`,
  `planVerbs`, `planOutcomes`, `wholeStringPlans`, ...), the end-to-end
  runs with interrupt expectations, and the rejection messages.
- `lib/stdlib/safeBash.test.ts`: `astToBash` round-trips every command
  family the classifier sees.
- `lib/stdlib/statelog.test.ts`: `_debug`.

Design: `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md`
(the plan-then-act model) and
`docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`
(the measurement, pipes, read family, and project scripts).
