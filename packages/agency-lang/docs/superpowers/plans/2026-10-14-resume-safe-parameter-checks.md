# Resume-safe parameter checks: implementation plan

Read first:

- `docs/dev/runtime/interrupts.md`, for how a resume replays a function and
  skips the steps that already ran.
- `docs/dev/compiler/hoist-calls.md`, for why a call that runs again on
  resume takes a saved frame that belongs to another function, and for the
  "Resume desync" tripwire.
- `docs/dev/language/validation-annotations.md`, for how `!` parameters and
  `@validate` compile.
- `lib/runtime/runner.ts`: `step`, `hook`, and `halt`.
- `docs/dev/contributing/coding-standards.md` and
  `docs/dev/contributing/anti-patterns.md`.

**Branch:** `resume-safe-param-checks`, one PR based on `main`. All paths are
relative to `packages/agency-lang`. One commit per task.

## The problem

This program fails when it resumes:

```
effect test::confirm {}

def check(value: string): Result<string> {
  return success(value)
}

@validate(check)
type Stamp = string

def ask() {
  raise test::confirm("Go ahead?", {})
}

def schedule(when: Stamp!): Result<string> {
  ask()
  return success(when)
}

node main() {
  return schedule("2026-10-16T09:00:00")
}
```

After the user approves the interrupt, the run stops with:

```
Resume desync: function "check" tried to claim the saved state of "ask".
```

When `ask` raised the interrupt, the saved frames were `[main, schedule, ask]`.
`check` had already finished, so it had no frame. On resume, `schedule` takes
its own frame and then checks its `!` parameters again. `check` is an Agency
function, so it asks for a frame and gets the next saved one, which is
`ask`'s. The frame stamps catch the mismatch and throw.

The parameter checks are the only part of a function's opening code that
calls Agency functions outside a runner step. Everything inside a step is
skipped on resume once the frame's step counter has passed it. The checks
run on every entry.

The same bug shows up whenever three things are true:

1. A function has a `!` parameter whose type carries a `@validate` Agency
   function, at any depth.
2. The function pauses inside a call to another function.
3. The run resumes.

If the interrupt is raised in the function's own body, there is no saved
frame after the function's own, so the validator gets a fresh frame and the
resume works. That is why the bug is easy to miss.

## The design

### The checks move into step 0

Here is the opening code for a function with one `!` parameter today,
shortened:

```ts
__stack.args["when"] = when;                 // every entry
// ...argument overrides from a resume are applied here...
try {
  const __vr_when = await __validateChainRecursive(__run, __stack.args["when"], ...);
  if (!__vr_when.success) {
    return __invalidArgument({ ... });
  }
  __stack.args["when"] = __vr_when.value;
  await __withChildRun(..., async (__run) => {
    await runner.hook(0, __run, async (__run) => {
      await callHook(__run, { name: "onFunctionStart", ... });
    });
    await runner.step(1, ...);               // the body starts here
    ...
  });
  if (runner.halted) {
    return runner.haltResult;
  }
}
```

Here is the same code after the change:

```ts
// non-`!` parameters are still assigned here, on every entry
const __paramChecks = {
  when: { typeText: "Stamp", validate: (__run, value) => __validateChainRecursive(__run, value, ...) },
};
try {
  await __withChildRun(..., async (__run) => {
    await runner.hook(0, __run, async (__run) => {
      __stack.args["when"] = when;
      await __checkParams(__run, runner, __stack, "schedule", __paramChecks, ["when"]);
      if (runner.halted) {
        return;
      }
      await callHook(__run, { name: "onFunctionStart", ... });
    });
    // ...argument overrides from a resume are applied and checked here...
    await runner.step(1, ...);
    ...
  });
  if (runner.halted) {
    return runner.haltResult;
  }
}
```

Step 0 already exists in every function: it fires `onFunctionStart`. The
checks go at the top of it. A resume skips step 0, so the validators do not
run again and no frame is taken.

The line that stores a `!` argument moves into step 0 with its check. On a
fresh call, step 0 stores the raw argument, checks it, and stores the
checked value. On a resume, step 0 is skipped, and the frame keeps the
checked value it was saved with. That matters because a check can change
the value. zod drops unknown keys, so `{ "type": "daily", "extra": 1 }` is
stored as `{ "type": "daily" }`. If a resume stored the raw argument again
and skipped the check, the body would read a value the first run never saw.

Parameters without `!` keep their assignment at the top, on every entry.
This change leaves them alone.

A failed check halts with the failure. The body's steps see `halted` and
skip, and the existing `if (runner.halted) return runner.haltResult` returns
the failure. `lib/ir/builders.ts` documents this halt-and-return pattern on
`withAlsFrame`. The failure now passes through `stampFailureBoundary`. At
step 0 nothing destructive has run, so the failure comes out the same.

The checks stay inside `runner.hook`, not a new `runner.step`. `step` calls
the debugger hook, so it would add a debugger stop at the opening line of
every function. `hook` runs the body once and advances the counter, which
is all the checks need.

All the checks share step 0. One hook per `!` parameter would let a
validator that pauses resume without re-running the validators of the
parameters before it, but it would also push the body's step ids up, and
with them the source map and every fixture of a function with a `!`
parameter. The follow-up for a pausing validator is out of scope, so step
0 stays one unit. Revisit this when that follow-up is built.

The `onFunctionStart` hook reports the arguments from the bare parameter
identifiers, so it reports the raw values, not the checked ones. That is
what it reports today, and this change leaves it alone.

The checks now depend on step 0 existing. `buildFunctionBody` has a
`skipHooks` option that would drop step 0, and nothing in `lib/` sets it.
Remove the option, so the checks cannot be dropped with it.

### Argument overrides are checked where they are applied

A resume can replace a paused function's arguments. Two places do this:
`agency resume` through `restoreForResume`, and `restore(cp, { args })`
through `applyRestoreSignal`. Both go through `_pendingArgOverrides` in
`resultCheckpointSetup.mustache`, which writes the new values into
`__stack.args`.

Today the overrides are applied just before the checks, so they get
checked. With the checks in step 0, a resume skips them. The overrides
would go unchecked.

The override block moves to just after step 0, inside the body wrap. After
writing the overrides, it calls `__checkParams` with the names of the
overridden `!` parameters, so they are checked and stored the same way
step 0 checks a fresh call.

The block has to be inside the `try`, so the frame pop in the `finally`
still runs when a check fails, and inside the body wrap, so a failed check
can halt the same way step 0 does and share its emitter. After step 0 is
the first place that satisfies both. The position is not about the value:
the override block assigns the JavaScript parameter as well as the stack
slot, so even if step 0 ran again after an override, it would store the
overridden value, not the original.

The whole block moves, for every parameter. For a parameter without `!`,
nothing between the old place and the new one reads the overridden value
on a resume, because a resume skips step 0.

Running a validator here is safe. An override always targets the last
frame on the stack, which belongs to the function that raised the
interrupt. No frame is saved after it, so a validator gets a fresh frame.

The override block must not run after step 0 halted. Wrap it in
`if (!runner.halted)`. When that guard skips the block, the pending
override is left unconsumed. That can only happen on a resume from a pause
taken before step 0 finished, and a stale override is matched by module
and scope name, so it is harmless. Say so in the doc from Task 4, so the
guard is not read as a bug later.

`resultCheckpointSetup.mustache` holds both the `let __resultCheckpointId`
line and the override block. The interrupt templates reference that
variable, so it stays at the top of the function. Split the template in
two: the variable stays in `resultCheckpointSetup.mustache`, and the
override block moves to a new `argOverrides.mustache` that is rendered
after step 0.

### One runtime helper runs the checks

Step 0 and the override block run the same sequence: validate a
parameter, halt with the invalid-argument failure if it fails, store the
checked value if it passes. That sequence does not belong in generated
code, which is neither type-checked nor unit-tested. It goes in the
runtime, and generated code describes what to check.

Each function with a `!` parameter emits one table, `__paramChecks`,
before the `try`. The table has one entry per `!` parameter: the type
text for the failure message, and a `validate` function that wraps the
expression `validateExpr` emits today, so the zod fast path and the
descriptor path both go through it unchanged. The table is the "what".

`__checkParams` in a new `lib/runtime/paramChecks.ts` is the "how". It
takes the run, the runner, the frame, the function name, the table, and
the names to check. For each name in order it reads the raw value from
`__stack.args`, calls the entry's `validate`, and on failure halts the
runner with `__invalidArgument` and returns without checking the rest.
On success it stores the checked value back into `__stack.args`. Step 0
calls it with every `!` parameter name. The override block calls it with
the overridden `!` parameter names only. Both call sites are one line,
followed by `if (runner.halted) { return; }`.

The helper gets a vitest file, `lib/runtime/paramChecks.test.ts`, with
a stub runner and frame. It is the only place the halt-and-store
sequence exists, so the fixture diffs in Tasks 2 and 3 are one table and
two calls per function.

## Tasks

### Task 1: tests that fail today

Add `tests/agency/validation/bangParamResume.agency` and its
`.test.json`, next to the other `!` parameter tests. Use
`interruptHandlers` with `"action": "approve"`, so the interrupt pauses
and resumes from outside the program. A `handle ... with approve` block
would answer inside the program, and nothing would pause. Count validator
runs with `setMutable` and `getMutable` from `tests/helpers/mutableVar.js`,
as `tests/agency/result/result-retry.agency` does, and read the count in
a separate node from the one that resumed, so the value is not itself
subject to the resume.

The existing tests in `tests/agency/validation/` already cover a fresh
call: a passing check, a failing check, the exact failure message with
and without a `@validate` function, two `!` parameters where either
fails, and a failure passed through unchanged. Those keep running and
would catch a helper that skips a check, returns the wrong message, or
stores the wrong value. The new tests cover what happens across a resume.

1. `once`: the program from "The problem", with a counter in the
   validator. It returns the counter after the resume. Expected: `1`. Today
   this fails with the desync error.
2. `checkedValue`: a `!` parameter of type `{ type: "daily" }`. The node
   passes `{ "type": "daily", "extra": 1 }` through a variable typed `any`,
   so the type checker allows it. The function pauses in a helper and then
   returns the parameter. Expected: `{"type":"daily"}`. This test passes
   today: a type with no `@validate` goes through the synchronous zod
   path, which takes no frame, so a resume re-runs it and strips the key
   again. It is a regression guard against a resume that stores the raw
   argument again and skips the check.
3. `bodyRaise`: the same as `once`, except the function raises the
   interrupt in its own body. Expected: `1`. Today this returns `2`: the
   resume re-runs the validator on a fresh frame, so there is no desync,
   but the validator runs twice.
4. `withDefault`: `def f(when: Stamp! = "2026-10-16T09:00:00")`, called
   with no argument, pausing in a helper, returning `when` and the
   validator count. Expected: the default and `1`. The default's ternary
   moves into step 0 with the store. If it is left behind, a resume
   stores `__UNSET` or `undefined` and the body returns the wrong value.
5. `mixedParams`: `def f(label: string, when: Stamp!)`, pausing in a
   helper, returning both. A parameter without `!` keeps its store outside
   step 0, and this proves the two kinds still agree after a resume.
6. `twoValidated`: two `!` parameters with two different counting
   validators, pausing in a helper. Expected: both counters `1`. This
   catches a helper that stops after the first name, or a step 0 that
   checks only the first parameter.
7. `failsBeforeBody`: a `!` parameter given an invalid value, a body that
   sets a flag, and a node that returns the flag and the failure message.
   Expected: flag unset, message unchanged from today. The check now fails
   by halting instead of returning, and this proves the body's steps see
   the halt and skip.
8. `inForkBranches`: a `parallel` block that calls the function from
   "The problem" twice, each call pausing in its helper, so both branches
   interrupt at once. Expected: both results and a validator count of
   `2`. A branch claims frames from its own branch stack, and this proves
   the step 0 skip holds there too.

Add the cross-module case as three files, following the sibling layout
`tests/agency/callback-imported-resume.agency` uses:

- `bangParamResumeCrossModule-types.agency`: a counting validator and
  the `@validate` type.
- `bangParamResumeCrossModule-lib.agency`: a function with a `!`
  parameter of that type that pauses in a helper. It imports the type
  only, not the validator.
- `bangParamResumeCrossModule.agency` and its `.test.json`: a node that
  imports only the function, calls it, and after the resume returns the
  value and the validator count. Expected: the value and `1`. A second
  node passes an invalid value and returns the failure message, so the
  descriptor also resolves across modules on the failing path.

This pins the property the `__agency_descriptor` side channel exists for:
a consumer never names the validator, so moving the check into step 0
must not make it start naming one.

Confirm that tests 1, 3, 4, and 6 and the cross-module resume node fail
on `main`, and that 2, 5, and 7 pass, before starting Task 2. A test that
fails on `main` for the wrong reason, or passes when it should fail, is a
test that does not test the fix. Save the output to a file.

### Task 2: move the checks into step 0

In `buildFunctionBody` in `lib/backends/typescriptBuilder.ts`:

1. Split the parameter assignments. `!` parameters move into step 0, and
   the rest stay where they are. Function-typed parameters are already
   handled at `lib/backends/typescriptBuilder.ts:2004`, where they are
   dropped from the schema. Read what `validateExpr` emits for a `!`
   parameter of function type before writing the emitter, and if such a
   parameter can exist, find out how a frame restores a function-typed
   argument from a checkpoint before moving its assignment.
2. Write `__checkParams` in `lib/runtime/paramChecks.ts` and export it
   through `lib/runtime/portable.ts` next to `__validateChainRecursive`.
   Write `lib/runtime/paramChecks.test.ts` first, with a stub runner that
   records `halt` and a plain frame object. Cases: every check passes and
   each checked value is stored; the first check fails, the runner is
   halted with the `__invalidArgument` failure, no later `validate` is
   called, and the earlier values are already stored; only the named
   parameters are checked; a name with no table entry is skipped; a
   `validate` that returns the value unchanged still stores it.
3. Emit the `__paramChecks` table before the `try` for functions with a
   `!` parameter, built from `validateExpr` per parameter. Emit the call
   and the `if (runner.halted) { return; }` at the top of the
   `onFunctionStartHook` body, after the `!` stores.
4. Delete the old `validationGuards` block and its comment about staying
   outside the wrap. Update the matching note on `withAlsFrame` in
   `lib/ir/builders.ts`.
5. Update the doc comment on `Runner.hook`. It says a hook body cannot
   raise interrupts, which is no longer true of step 0: a validator is an
   Agency function. Say that step 0 also runs the parameter checks, and
   point at the out-of-scope note below.
6. Remove the `skipHooks` option from `buildFunctionBody`. Nothing sets
   it, and the checks now depend on step 0 existing.
7. Add `tests/typescriptGenerator/bangParamDefault.agency`, a function
   with `when: Stamp! = "..."` and one plain parameter, so a fixture pins
   where the default's ternary and each store land.

Run `make fixtures`. Only the fixtures of functions with `!` parameters
should change, such as `tests/typescriptGenerator/bangParams.mjs` and
`genericAliasValidation.mjs`, plus the new one. Read the diff of each. Any
other changed fixture means something moved that should not have.

Run the Task 1 tests and `tests/agency/casts/` and
`tests/agency/validator-predicates.agency`.

### Task 3: check overridden arguments

1. Split `resultCheckpointSetup.mustache` as described in the design.
   The `__resultCheckpointId` line stays before the `try`. The
   `_pendingArgOverrides` block moves to just after step 0, inside the
   body wrap, guarded by `if (!runner.halted)`.
2. After the overrides are written, emit a `__checkParams` call with the
   overridden `!` parameter names, computed from `"name" in __overrides`
   for each `!` parameter, and the `halted` return.
3. Add `tests/agency/validation/bangParamOverride.agency`, which resumes
   with an overridden `!` argument and expects its check to run. Build it
   on `restore(cp, { args })` with an explicit `checkpoint()` call inside
   the function body. Cases:
   - a valid override of type `{ type: "daily" }` given as
     `{ "type": "daily", "extra": 1 }`, expecting the body to see
     `{"type":"daily"}`. A passing override only proves the check ran if
     the check leaves a mark, and the dropped key is that mark.
   - an invalid override, expecting the invalid-argument failure and a
     body flag left unset.
   - an override of a parameter without `!`, expecting the body to see
     the new value. The block moved, and this proves plain overrides
     still apply.
   That
   checkpoint's last frame is the function, so `applyRestoreOverrides`
   routes the override through `_pendingArgOverrides`. Do not build it on
   `result.checkpoint`: entry checkpoints are no longer pinned, so that
   field is undefined, which is why every existing `restore(cp, { args })`
   test under `tests/agency/result/` is skipped. This is the first live
   test of the function-argument override path. `lib/runtime/resumeSetup.test.ts`
   only checks that the pending record is set.
4. Add one agency-js case under `tests/agency-js/interrupts/` that resumes
   through `resumeCliFromCheckpoint` with `overrides: { args }` carrying
   an invalid `!` value and expects the failure. `agency resume` is the
   path a user actually types, and it reaches the block through
   `restoreForResume` rather than `applyRestoreSignal`.

Run `make fixtures`. This time every fixture changes, because every
function emits the override block. In the fixtures of functions without
`!` parameters, the move must be the only change. Keep this commit
separate from Task 2's, so each fixture diff has one explanation.

Run the override tests in `tests/agency-js/interrupts/` that touch this
path, and the new test.

### Task 4: docs

1. `docs/dev/language/validation-annotations.md`: a section on where `!`
   parameter checks run. They run in step 0, a resume skips them, and the
   frame keeps the checked value. Overridden arguments are checked after
   step 0, and the `if (!runner.halted)` guard can leave an override
   unconsumed only after a pause taken before step 0 finished. Say that
   all checks share one hook and why. Show the "after" code from this
   plan.
2. `docs/dev/compiler/hoist-calls.md`: the table already covers checked
   casts. Add one line saying that `!` parameter checks are covered by
   step 0, not by the hoist pass, and link the section from item 1.

## Out of scope

- A validator that raises an interrupt from a `!` parameter check. Today
  `__validateChainRecursive` hands back the interrupt list, and
  `__invalidArgument` reads `.error` from it and throws. Inside step 0, a
  later change can halt on the list instead, and a resume would then
  re-enter the validator with its own saved frame. That needs its own
  tests.
- The bmo workaround that moves `setApprovals` into `scheduleTask`. Once
  this ships, bmo only needs the version bump.
