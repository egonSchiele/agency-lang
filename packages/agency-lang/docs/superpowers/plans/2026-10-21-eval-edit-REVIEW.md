# Review: `agency eval edit` plan (ADI-31)

Plan: `2026-10-21-eval-edit.md`. Reviewed against `origin/main` at d85eb14e3 with the ADI-30 plan and its review (`2026-10-21-eval-new-graders-section-REVIEW.md`) beside it. Line numbers are from `origin/main`.

Verdict: the state additions (`editing`, locks, dirty baseline), the loader, and the command are sound. Three things in Tasks 2 and 3 fail as written: the delete helper refuses every suite the tests build, the in-place write cannot keep the promise its own Review Focus makes, and the `id` rule contradicts the "never loses a key" constraint. Each is a small change.

## Blocking

### 1. `safeDeleteFile` refuses a file outside the nearest package (Task 3, step 4)

`safeDelete` runs `checkInsideProject` on the resolved path (`lib/utils.ts:60`), which walks up to the nearest `package.json` and refuses when there is none or the file is outside it (`lib/utils.ts:17-39`). Every test in the plan builds its suite under `os.tmpdir()`, where there is no `package.json` above, so "deletes graders.json when the last grader was removed" fails with "no project root found above it". A real suite that lives outside a package is refused the same way. `safeDeleteDirectoryWithin(root, target)` (`lib/utils.ts:110`) exists because of this; it takes the boundary as an argument, and the staging code already uses it.

Fix without a new helper: in step 4, `fs.renameSync` the old `<testDir>/graders.json` into the staging folder instead of deleting it, and let step 5's `safeDeleteDirectoryWithin(suiteDir, staging)` remove it with the rest. That also means nothing is deleted until every rename has succeeded. If a file helper is wanted anyway, it is `safeDeleteFileWithin(root, target)` beside the directory one, with the same realpath and strict-descendant checks.

### 2. "test.json first" breaks the leave-the-originals promise (Task 3, step 3)

Review Focus says a save that fails because `graders.json` became a directory must leave the originals as they were, and the test "a graders.json that became a directory fails with the problem and leaves test.json as it was" pins it. Step 3 renames `test.json` first and `graders.json` second. A rename of a file over a directory fails, and by then `test.json` has already been replaced. The test as written fails.

Fix: before any rename, check each target (`<testDir>/test.json`, `<testDir>/graders.json`) is absent or a regular file and not a symlink (`lstat`), and throw the `TestWriteError` then. After the checks pass, the order of the two renames does not matter much, and the paragraph about "an error during step 3 after test.json moved cannot be undone" shrinks to a race the checks cannot close.

### 3. Dropping `id` from the base loses a key (Task 2)

Global Constraints: "Opening a hand-written test in the form never loses a key." Task 2: "`base` is the parsed object with `id` removed when it equalled the folder name". A `test.json` that spells out its `id` loses it on save. The reason given, "so a test that never wrote an `id` does not gain one", does not need the rule: `base` is the parsed object, and `testJsonFor` writes only `description`, `input`, and `goal` over it, so a file with no `id` never gains one. Keep `base` untouched and delete the test "drops an id equal to the folder name from the base".

## Should fix

### 4. `files`, `graders`, and `rubric` keys in `test.json` (Task 2)

The loader honours three keys the form does not model:

- `files` may name any directory, and only defaults to `./files` when absent (`lib/eval/loadInputs.ts:151, 314`). The plan's files lock reads from the `files/` folder, so a test with `"files": "../shared"` shows `none`.
- `graders` may name any path, and only defaults when absent (`loadInputs.ts:158, 316`). A test with `"graders": "../common/graders.ts"` shows "no graders"; adding one writes a `graders.json` the loader ignores, because `spec.graders` is already set.
- `rubric` with `goal` is refused (`loadInputs.ts:234`). A test with a `rubric` opens with an empty goal; typing one produces a file the loader refuses.

Cheapest rule: when `base.files` is a string, the files lock shows that string; when `base.graders` is a string, lock the section with `graders: <path>: edit the file`; when `base.rubric` is set, refuse at load with `${testDir}/test.json has a rubric; this form edits goal`. Add one load test per key.

### 5. Export the grader-file discovery from the loader (Task 2; altitude)

`loadTestDir` keeps `GRADER_FILES` and the "has both ... keep one" error (`loadInputs.ts:136, 154-157`). Task 2 writes both again. Export one function, `graderFileIn(testDir): string | null` that throws the both-present error, and call it from both places, so the form and the loader cannot disagree about which file a folder uses. `loadTestDir` itself cannot be reused for the rest: it normalizes to a `Test` and drops the keys the form must keep (`loadInputs.ts:302-320`), so reading the raw object in `load.ts` is right.

### 6. A `files` that is itself a symlink is followed (Task 2)

`walkTreeRefusingSymlinks` refuses links inside a tree, and `readdirSync` follows a link at the root. `snapshotGraderFiles` checks the root with `lstat` first (`lib/eval/grading/graderFilesSnapshot.ts:18`). The count is display only, so the cost is a wrong number; one `lstat` before the walk gives `files/ (could not be read: files must not be a symlink)` instead.

### 7. The terminal error names the wrong command (Task 5)

`openRealTerminal` throws "eval new needs an interactive terminal" (`lib/cli/eval/new.ts:227`). Once it moves to the shared module, it takes the command name as an argument.

## Minor

- Task 2's values paragraph still holds a drafting turn ("... shown as `""`... no: the loader would refuse it"). Keep the second half: a non-string `description`, `input`, or `goal` is refused with `${testDir}/test.json: ${key} must be a string`.
- `Editing.loaded.graders` as the JSON text and `isDirty` comparing `JSON.stringify(graders.map(specObjectFor))`: both sides go through `specObjectFor`, so `mustPass: false` in the file and `no` in the form compare equal. Say so in the dev doc, since it is why the comparison is on the object and not on the file's text.
- The staging folder `.staging-<id>` sits in the suite, where the loader lists every subdirectory holding a `test.json` as a test (`loadInputs.ts:96-100`), dot names included. The `finally` covers the normal paths and the dev doc already records the crash case for `eval new`; nothing new to do.
- Task 5 says `edit.test.ts` may copy or move the `drive` and `typing` helpers, preferring the move. Make it the move; two copies of a poller that asserts its own step count is the kind of thing that drifts.
- `nextCommands(suiteDir, id)` with `suiteDir` the folder's parent gives the right `--suite` and `--test` for an edited test.

## Altitude pass

- The locks are the right size. A `Partial<Record<FieldName, string>>` plus one `string | null` for the section covers every lock the spec names, and finding 4 adds two more texts without a new mechanism.
- `editing` is one optional field and the write branches on it once (`writeTest` to `replaceTestFiles`). No second form, no second reducer.
- The dirty baseline reuses `specObjectFor` rather than a deep-equal over drafts, which keeps `form.ts` free of `write.ts`. Right call.
- `load.ts` is the one new module and it re-derives three loader checks (object shape, grader-file discovery, type checks on the three fields). Finding 5 removes one; the other two are three lines each and the loader's own versions are private and shaped for `Test`.

## What was checked and held

- `safeDeleteFile(path, dryRun = true)` (`lib/utils.ts:83`): the Background's note is right that a real delete passes `false`; the project-root check is the part it missed.
- `fs.renameSync` of a file over a file in the same suite directory is one step on the same filesystem; the staging folder is under the suite, so nothing crosses a mount.
- `testJsonFor` today returns only the three fields (`lib/eval/newTest/write.ts:105-110`), so the base-object version is a change in one function and its callers.
- The loader refuses an empty `description` (`loadInputs.ts:289-294`) and an empty `input` string (`loadInputs.ts:251-255`), so deleting a key whose field was emptied is required, as the plan says.
- `assertSuiteDirectory` is not reused by `eval edit`, and `loadTestForm`'s "has no test.json; eval edit opens one test folder" covers a suite passed by mistake.
