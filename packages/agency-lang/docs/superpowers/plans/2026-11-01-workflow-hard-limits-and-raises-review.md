# Review: workflow hard limits and `raises`

Plan: `docs/superpowers/plans/2026-11-01-workflow-hard-limits-and-raises.md`

## Verdict

The plan is sound and ready to build after one decision. The scaffold handler does make every limit hard. It also breaks `supervise()` inside any tool a workflow calls, and the plan does not mention it. Decide whether that is acceptable before Task 1. Everything else below is small.

## 1. The handler breaks `supervise()` inside a tool (decide before Task 1)

`supervise()` works by extending its own guard. `stdlib/supervise.agency:72-112` wraps the block in `guard(time: every, label: instanceLabel)`. On each trip, its handler approves with a grant:

```
"continue" => approve({ maxTime: grant })
```

Inside a workflow, the scaffold's handler also answers that trip, with `reject()`. A rejection beats every approval, so the guard stops at its first check. Take a tool that runs a coding agent this way, which is the pattern `stdlib/agents/coding.agency:11` recommends:

```
supervise(every: 5m, maxTime: 30m, check: myCheck) {
  return codingAgent(task, maxTime: 30m)
}
```

Called from a workflow step, it stops after 5 minutes, not 30. The same is true of any tool that answers its own guard with an approval. `supervise` is the only one in the stdlib today.

The spec's call 1 rejects a tool's guards on purpose, so that a caller cannot extend them. A handler cannot tell an approval from the tool itself apart from one from the caller, so there is no cheap way to keep `supervise` working and still close that hole. I see two choices:

- **Accept it** and say so. Put it in the scaffold comment, in `docs/dev/stdlib/workflow.md` under "Limits and the step guard", and in the `raises` or limits section of the module doc. A tool author needs to know that `supervise` inside a workflow tool stops at its first interval.
- **Reject only the workflow's own guards.** Match `guardTrip.data.label` against the workflow's step ids and the workflow guard's label. Then `supervise` keeps working, but a plain `guard` inside a tool can be extended by the caller again. That reopens the hole the spec closes.

I recommend accepting it, because the spec chose "every limit is hard" for a reason. Whichever you pick, write it down.

## 2. Test the workflow guard too, not only the step guard (small)

`stepLimitIsHard` trips the step guard (`limits: { maxTime: 100 }` on step `slow`). Nothing tests that the workflow-level guard is hard. That guard is the one `GUARDED_SCAFFOLD` writes, and it moved inside the new `handle` block. Add one more case: the same one-step workflow with no step limit and `limits: { maxTime: 100 }` on the workflow, a caller that approves `std::guard` with `approve({ maxTime: 60000 })`, and an expected failure. It costs one node and one test entry.

## 3. `catalog` and `check` disagree about `std::guard` (decide in Task 2)

Task 2 copies `effects` into each catalog entry exactly as `describe` reports them. So a tool that uses `guard` lists `std::guard`. Task 3's `stepEffects` drops `std::guard`, because the workflow rejects it. The basic-commands plan prints both. For a tool with a guard, a person would see:

```text
$ agency workflow tools ./src/research.agency
  research(question: string): Result<string>
    raises std::guard, std::http::fetch
```

and then, for a workflow that calls it:

```text
can raise:
  std::http::fetch   step look (research)
```

Both are correct for what they describe. A reader will still ask why `std::guard` disappeared. Either drop `std::guard` from catalog entries too, with the same reason in the doc comment, or keep it and say in the `CatalogEntry.effects` doc comment that a workflow never lets it reach the caller. I lean toward keeping it in the catalog, since a catalog describes the tool and not the workflow.

## 4. Smaller notes

- **`unknown` is a real effect.** A tool with a bare `interrupt("...")` gets `effects: ["unknown"]` from `describe`, and the runtime raises it as effect `"unknown"` (`lib/runtime/agencyInterrupt.ts:199`). So the `raises` check reports `addThing raises "unknown"`. That is correct. Mention it in the "What a workflow may raise" section, so a reader knows what to write in `raises` to allow it. The parse test already accepts `["unknown"]`.
- **User-defined effect sets.** `expandEffectNames` knows only the built-in sets. Agency's own `raises` clause accepts a set the user declared with `effectSet`. In a workflow, `raises: ["MyListEffects"]` is taken as one effect name, so every member is reported as not allowed. Say this in the docs section. Supporting user sets would need the workflow to name the module that declares them, which is more than this plan should do.
- **The handler's missing `pass()`.** The scaffold handler returns nothing for an effect other than `std::guard`. The guide says that counts as a pass (`docs/site/guide/handlers.md:207`), so it is correct. The `@guarded` decorator writes `return pass()` out loud. Writing it in the scaffold too would make the two read the same. Optional.
- **Task 4 Step 3 touches the runtime.** Moving `expandSetNames`' expansion into `effectSets.ts` is the right call, since it gives one rule for flags and for `raises`. List `lib/runtime/policyFlags.test.ts` among the tests to run in Step 6, since the plan says those tests must pass unchanged.

## What I checked and found correct

- **Line ranges.** `lineOf` counts the lines before `{{body}}` in the scaffold text. Adding the `handle {` line moves every range down by one, with no other change to `renderWorkflow`.
- **`return` inside `handle`.** The type checker's flow rule for `handleBlock` (`lib/typeChecker/flowBuilder.ts:362`) returns the flow after the body. So `main` still counts as always returning, and the strict compile in `_checked` should accept the new scaffold. Step 5's tests will confirm it.
- **`raises` as a field name.** It is also a keyword, so I parsed a type with a `raises?: string[]` field and an object literal with a `raises` key. Both parse.
- **The new test is meaningful.** Without the handler, the parent's `approve({ maxTime: 60000 })` would let `slowEcho`'s 2-second sleep finish, and the node would print "unexpected success". With it, the step fails. So `stepLimitIsHard` fails before Task 1 and passes after it.
- **Fixtures.** `addListItems` raises `test::lists::add`. `searchNotes`, `readNote`, and `findLists` raise nothing. The resolve tests use hand-built signatures that give `readNote` `std::read`, which matches the spec's example.
- **Effect sets.** `builtinEffectSets()` returns each set with `members` already flattened, so `FileSystem` expands to the members of `FileRead` and `FileWrite`.
