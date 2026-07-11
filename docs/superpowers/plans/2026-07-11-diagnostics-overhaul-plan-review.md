# Plan review: Diagnostics overhaul (issue #474)

**Plan:** `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-11-diagnostics-overhaul.md`
**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-11-diagnostics-overhaul-design.md`
**Reviewed:** 2026-07-11, verified against main.

## Verdict

The plan is well-built where it counts: the strangler migration (optional fields → sweep → required flip so tsc enumerates stragglers) is the right mechanism, the per-file inventory is accurate (I re-counted every file — all 17 counts match exactly), the worked example at `scopes.ts:118-123` matches the real code verbatim, and the two execution-time decisions are flagged with resolution instructions instead of left as TBDs. But it has one test that cannot pass as written, one design bug carried over from the spec review, and one under-scoped task that hides a public stdlib API break. Fix those three before execution.

## Must fix

### 1. Task 6 dedup key still collapses real errors (spec-review finding, not incorporated)

Task 6 Step 2 sets the dedup key to `${err.code}:${err.loc?.start ?? -1}`. This drops a case today's key (`message + start`) keeps: **same code, same position, different params**. Two `typeNotAssignable` errors at the same expression start with different expected types (union-branch checks, re-check passes) currently both survive because their rendered messages differ; under `code + start` one silently disappears. The fix costs nothing:

```ts
const key = `${err.code}:${err.message}:${err.loc?.start ?? -1}`;
```

This still achieves the goal (two *different* codes sharing a message and position no longer collapse) without becoming lossy in the other direction. The Task 6 dedup test should pin both directions: different codes at one position both survive, AND same code with different params at one position both survive.

### 2. The `plain()` helper in Task 5's test strips the wrong bytes — all three assertions fail

The test file defines:

```ts
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");
```

ANSI sequences are `\x1b[31m` — an ESC byte, then `[31m`. This regex removes `[31m` but leaves the invisible `\x1b` behind, so every `toBe` comparison fails with a mismatch you cannot see in the diff. And this WILL bite: `formatErrors` uses `color.red`/`color.yellow` from `lib/utils/termcolors.ts:158`, which is `createColorFunction()` — **unconditional** coloring (the TTY-gated variant is the separate `ttyColor` export). Test output will contain escape codes. Correct regex:

```ts
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
```

The same helper appears implicitly in Task 7 Step 2's end-to-end pin — use the fixed version there too.

### 3. Task 4 Step 2 hides a public stdlib API break as "mechanical tsc fallout"

The flip deletes `variableName`/`expectedType`/`actualType`, and Step 2 says consumers "migrate to `err.params.<key>`" as tsc errors surface. One of those consumers is not mechanical: `lib/compiler/typecheck.ts:37` mirrors all three fields into `TypeCheckDiagnostic`, which is re-exported from `lib/compiler/compile.ts:94` and published as a **public Agency-language type** — `TypeCheckReport` at `stdlib/agency.agency:79`, returned by `std::agency.typecheck` and consumed by the `writeAgency` review loop. Deleting or renaming those fields there is a stdlib API change that requires editing `stdlib/agency.agency`, running `make`, and updating the generated stdlib docs — none of which the plan's file list or any task mentions.

The plan must make the decision explicit (the spec's §3 audit demanded exactly this) and give it its own step in Task 4 or 5. Recommendation from the spec review: propagate `code`/`severity`/`params` into `TypeCheckDiagnostic` rather than aliasing the old fields — the LLM review loop is exactly where stable codes pay off.

**Coordination hazard, same file:** PR #514 is open and actively modifying `stdlib/agency.agency` and `lib/stdlib/agency.ts`. Sequence this work after #514 lands or plan for the conflict; the plan's worktree is cut from `origin/main` and says nothing about it.

## Should fix

### 4. The sweep recipe has no rule for conditionally-built messages

Recipe step 1 assumes every site's message is one fixed template literal. A site that builds its message with a ternary or a conditionally-appended hint forces a choice the recipe doesn't make: multiple registry entries, or a param holding a sentence fragment. The second option quietly poisons `params` as a structured payload. Add a recipe step 7: **conditional phrasing = separate registry entries; params never contain sentence fragments.** Cheap to state now, expensive to discover mid-sweep with inconsistent resolutions across files.

### 5. The suppression behavior change is undocumented (spec-review finding, not incorporated)

Today `applySuppressions` keeps loc-less errors unconditionally (`lib/typeChecker/suppression.ts:67`), so they are *immune* to bare `@tc-ignore`. The sweep gives those errors real locations, so existing bare `@tc-ignore` comments will start suppressing errors they previously could not touch. Messages stay byte-identical, so the plan's zero-message-churn gate (Tasks 2-3 Step 2) will not detect this. It is the intended fix, but it is a silent behavior change for users. Add it to the Task 7 PR-body checklist as a named, deliberate behavior change, and mention it on the `@tc-ignore` docs page Task 6 already updates.

### 6. The spec promised a plan-time `loc: null` list; the plan defers it to execution

Spec §3: "the plan lists every remaining `null` site explicitly so the review can challenge each one." The plan's recipe step 3 instead builds the list during execution (registry doc comment). The self-review note's staleness argument is fair for per-site *code*, but the null list is the one enumeration the spec explicitly made a review gate. Compromise that keeps both properties: require the final null-site list in the **PR body** (Task 7 Step 4 already collects audit lists there) so the review gate moves to the PR instead of vanishing. Add it to that checklist explicitly.

### 7. tsc-driven consumer audit misses dynamic and serialized consumers

The Task 4 flip catches typed TS consumers, but not: (a) access through `any`, (b) serialized snapshots — statelog events carrying typecheck error objects, and any `tests/agency/*.test.json` expectation embedding formatted error text. Task 5 Step 3 audits the LLM path and "greps statelog" — good — but add one grep to Task 4 Step 2: `grep -rn "variableName\|expectedType\|actualType" lib tests --include="*.ts" --include="*.json"` (minus parser/preprocessor hits, which are unrelated AST fields of the same names), so the audit is positive-evidence rather than tsc-only.

## Nits

- **Inventory arithmetic:** the header says "~72 sites" but the per-file list sums to 76 (verified: 11+11+11+7+7+7+4+3+3+2+2+2+2+1+1+1+1 = 76). The `logsViewer/parse.ts` 4 are *additional* (different error type), not part of the 76. Say "76 sites" to match the spec and the list.
- **Task 7 Step 1 stale boilerplate:** "Revert usaspending.md drift; delete stray `a.vs.b.verdict.json`" — neither file exists in this repo's status; this is leftover from another plan. Delete the sentence before an executor goes hunting for (or worse, deleting) files.
- **`name?: string` vs `name: DiagnosticName`:** the spec typed the field as `DiagnosticName`; the plan uses `string`, presumably to avoid a types.ts → diagnostics.ts → types.ts import cycle. A type-only import breaks no cycle at runtime — but if `string` was a deliberate choice, one comment saying so prevents a "fix" during execution. Either is acceptable.
- **Task 1 transitional loc note is good** — the `loc ?? undefined` mapping with a flagged flip in Task 4 is exactly the kind of transitional detail plans usually miss. No change needed; noting it as verified.

## Verified during this review (positive evidence)

- Per-file push counts: all 17 files re-counted against main; every number in the plan's inventory line is exact.
- `scopes.ts:118-123` worked example: byte-identical to the real site (field is `node.variableName`, as the plan has it — the spec's earlier `node.left.value` was wrong and the plan silently fixed it; fine).
- `lib/logsViewer/parse.ts` pushes into a different error type — correct, out of scope.
- `formatErrors` callers and line numbers (`serve.ts:63,66`, `buildSession.ts:648,652`, `compile.ts:157`): all correct; `compile.ts:157` already passes one arg, so only two call sites change. The plan's Task 5 Step 2 wording ("the three callers") is accurate.
- `currentFile` set once in the `TypeChecker` constructor (`lib/typeChecker/index.ts:105`); Task 4's stamping placement (before the `applySuppressions(deduplicateErrors())` return at `index.ts:400`) is coherent.
- Suppression line-indexing in Task 6's tests (directive on line 0 suppresses line 1, matching `ignoreLines.add(i + 1)` in current `parseSuppressions`): correct.
- The `Suppressions.ignoreLines` shape change to `Record<number, "all" | string[]>` matches the repo's objects-not-maps rule and the plan applies it consistently in the `applySuppressions` rewrite.

## Anti-pattern check (against docs/dev/anti-patterns.md)

**The big question — declarative interfaces encapsulating imperative code — the plan gets right at the architecture level.** The registry + factory design is exactly the pattern the catalog's "Imperative code everywhere" entry asks for: 76 call sites currently hand-assemble error objects imperatively (build the string, remember the fields, remember the loc); after the sweep each site is one declarative statement — `diagnostic("reassignToConst", { name }, loc)` — that says *what* went wrong, while the *how* (template rendering, severity defaulting, code lookup) lives in one place. Changing the "how" later (e.g. adding `agency explain` links) touches one file, not 76 sites. The same holds for the suppression rewrite: the imperative line-matching lives inside `applySuppressions`; callers keep a declarative filter interface. No leaky-abstraction issues either — sites never see codes, templates, or rendering.

**Concrete violations in the plan's own code blocks** (the executor will transcribe these literally, so they should be fixed in the plan):

1. **Nested ternary** (explicitly banned) — Task 5's `formatErrors`:

```ts
const where =
  err.file && err.loc
    ? `${err.file}:${err.loc.line + 1}:${err.loc.col + 1} - `
    : err.file
      ? `${err.file} - `
      : "";
```

Rewrite as if/else per the catalog's own worked example:

```ts
let where = "";
if (err.file && err.loc) {
  where = `${err.file}:${err.loc.line + 1}:${err.loc.col + 1} - `;
} else if (err.file) {
  where = `${err.file} - `;
}
```

2. **One-line if statements** — Task 6's `applySuppressions` uses three (`if (suppressions.nocheck) return [];`, `if (rule === undefined) return true;`, `if (rule === "all") return false;`), and the plan's own Global Constraints section says "no one-line ifs." The current `suppression.ts` already contains this style, so the codebase is inconsistent here — but new code written by this plan should use braces, especially since `lint:structure` runs in Task 7.

3. **Useless special case** — Task 4's stamping loop writes `err.file = err.file ?? file;`, but nothing sets `file` on an error before this point (the factory doesn't, and stamping runs once). The guard defends a case that cannot happen. Plain `err.file = file;` is correct and reads honestly.

**Minor, test-code only:** the Task 1 registry test uses single-character names (`e`, `m`) and an imperative accumulate-into-object loop for dummy params that could be `Object.fromEntries([...e.message.matchAll(...)].map(...))`. Low stakes in a test, but the catalog has entries for both; cheap to fix while transcribing.

**Checked and clean:** no duplication (I grepped — the repo has no existing `{placeholder}` render helper and no shared `file:line:col` formatter, only scattered ad-hoc `loc.line + 1` sites, so `renderMessage` and the new `formatErrors` duplicate nothing and arguably become the canonical formatter); no order-dependent mutable state (the factory derives everything from inputs with `const`); no nested type definitions (registry entries are flat); no dynamic requires; no magic numbers beyond the pre-existing `?? -1` dedup sentinel; no empty catch blocks (no try/catch at all); no `...(x ? { x } : {})` spread hack.

## Test-plan review

Question asked of every test: does it test what it claims, and does it fail when the code breaks?

### Tests that do not test what they claim

**T1. The registry render-invariant test is a near-tautology (Task 1).** It extracts placeholders with `/\{(\w+)\}/g`, fills exactly those, renders with `renderMessage` (which substitutes using the same regex), and asserts nothing matching `/\{\w+\}/` survives. Extract with regex R, replace with regex R, assert nothing matches R: this passes for ANY template and can only fail if `renderMessage`'s replace call itself is broken. It cannot catch a bad template. Worse, it misses the single likeliest sweep failure mode, which the recipe practically manufactures: step 1 says copy the message VERBATIM then convert `${expr}` to `{placeholder}` — forget the conversion and the template contains literal `${name}`, which neither the extract nor the render regex touches, so the invariant test stays green and users see `${name}` in output (if no existing test asserts that exact message, it ships). Two cheap, real invariants to add:

```ts
it("no template contains an unconverted TS interpolation", () => {
  for (const [, e] of entries) {
    expect(e.message).not.toContain("${");
  }
});
it("every brace in a template is part of a well-formed {word} placeholder", () => {
  for (const [, e] of entries) {
    expect(e.message.replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
  }
});
```

**T2. `renderMessage` silently renders the string "undefined" for a missing param — and no test pins this.** `String(params[key])` on an absent key produces `"undefined"` inside a user-facing message. Typed `DiagnosticParams<N>` protects TS-typed call sites only; an `as any`, a future JS caller, or the documented `Record<string, ...>` fallback leaks it. Recommendation: `renderMessage` throws on a missing key (a diagnostic about diagnostics beats silent corruption), with a unit test for both the throw and the happy path. If throwing is rejected, at least pin the current behavior so it is a choice, not an accident.

**T3. The Task 5 `plain()` helper makes all three formatter tests fail against correct code** (see must-fix #2 above — missing `\x1b` in the regex). A test that fails when the code works is as broken as one that passes when it doesn't.

**T4. The Task 6 dedup test is an empty body with a comment.** The plan flags it for resolution at execution — fine as process — but after the dedup-key fix (must-fix #1) it must pin BOTH directions: two different codes at one position both survive, AND one code at one position with different params/messages both survive. The second assertion is the regression guard for the key bug this review found; without it the `code + start` key could be silently reintroduced.

### Breakage no planned test would catch

**T5. The location sweep has zero test enforcement — the spec's test #6 is missing from the plan entirely.** Spec §Tests item 6: "for each site currently pushing without a loc, a pin that the diagnostic now carries one (or is on the explicit null list)." No plan task contains it. Recipe step 3 ("hunt the nearest AST node loc") is the most judgment-dependent part of the whole sweep, and existing tests almost never assert `loc` — an executor could pass `null` at every previously loc-less site and every planned check stays green. Add a Task 6.5 (or fold into Task 7): fixture sources that trigger each previously-loc-less diagnostic (the Verified-facts section already knows where they are: index.ts alias/type-param errors, reserved-name loops, etc.), asserting `loc !== null` — with the deliberate-null list as the explicit exception set.

**T6. File stamping (Task 4 Step 3) has no direct test.** Task 5's formatter tests set `file` manually via spread, so they pass even if `check()` never stamps. The only coverage is Task 7 Step 2's end-to-end pin — and as written ("compile a source string") it cannot assert a full formatted block deterministically, because `typeCheckSource` without a `sourcePath` synthesizes a random tempdir path (`.agency-tmp/typecheck-<nanoid>/agency_<nanoid>.agency`). Fix both at once: the e2e pin passes an explicit `sourcePath`, asserts the `file:line:col` prefix exactly, and is documented as THE stamping test. Or add a one-assertion unit test on `check()` output.

**T7. No warning-severity test anywhere in the formatter suite.** All Task 5 tests use error-severity diagnostics. Swap the `colorFunc` branches, or print the literal word "error" for warnings, and nothing fails. One test: a `severity: "warning"` diagnostic renders `warning AG####:` (and, if colors are asserted anywhere, yellow).

**T8. Config-driven severity routing is assumed covered, not verified.** After the sweep, a site that forgets the `overrides` argument inherits the registry default ("error"), and warn-configured diagnostics silently escalate. The plan leans on existing tests (the matchExhaustiveness / undefined-name config tests) to catch this. Plausible — but Task 3 should say "verify an existing test pins warn-mode output for each of the four config-driven sites (synthesizer strict member access, matchExhaustiveness, undefinedFunctionDiagnostic, undefinedVariableDiagnostic); add a pin where absent," not assume it.

### Missing suppression test cases — including a semantic hazard

**T9. "No valid codes after filtering → treat as `all`" turns a typo into maximal suppression, untested and undecided.** Task 6 Step 2: tokens are filtered to `/^AG\d{4}$/`; empty list → `"all"`. The mapping exists for good reason — `// @tc-ignore some explanation` (trailing prose, common in the wild, works today) must keep suppressing. But it also means `// @tc-ignore AG201` (three-digit typo) or `// @tc-ignore ag2001` (lowercase) suppresses EVERYTHING on the next line instead of nothing — the directive silently widens instead of narrowing. The plan neither decides this deliberately nor tests it. Minimum: pin three cases — (a) bare directive with trailing prose → all (today's-behavior regression guard); (b) directive whose only tokens are code-shaped-but-invalid (`AG201`, `ag2001`) → pin the chosen semantics, deliberately; (c) mixed `AG2001 plus junk` → only AG2001. A reasonable middle path for (b): a token matching `/^ag\d+$/i` that fails the strict pattern disables the "all" fallback (clear intent to name codes, malformed), suppressing nothing — but any deliberate, tested choice beats the current silent one.

**T10. `loc: null` immunity to `@tc-ignore` is documented in the spec (§5) and implemented in the plan's `applySuppressions` — and never tested.** One test: a file-level diagnostic survives a bare `@tc-ignore` regardless of directive placement.

### Golden coverage is thinner than the spec asked

**T11. Spec §Tests item 2 asks for byte-identical goldens on "3-4 representative diagnostics"; the plan has one** (`reassignToConst`, single-param). Add, as their entries land in Task 2: a multi-param golden (`typeNotAssignable`, exercising two placeholders plus `formatTypeHint`-computed values) and a config-driven one. Residual risk to name in the PR body: the zero-message-churn gate is only as strong as existing message-assertion coverage — a template mis-extracted for a diagnostic no existing test asserts drifts silently. The `${`-tripwire (T1) closes the worst class; the goldens close the highest-traffic ones.

**Minor:** spec item 1's "registry importable without cycles" has no dedicated test in the plan — acceptable, since every test file that imports `diagnostics.js` proves it transitively; not worth a test, worth deleting from the spec's list.

### What the planned tests get right

- The Task 6 suppression tests are genuinely red-first: on main, `parseSuppressions` returns a `Set` and `applySuppressions` ignores codes, so both new tests fail for the right reason, and the bare-directive test doubles as the regression pin the spec demanded.
- The Task 1 factory tests (golden message, severity override, null-loc carry-through, params landing) each fail on exactly one behavior breaking; the transitional `toBeUndefined` → `toBe(null)` flip is pre-planned rather than discovered.
- Per-file green runs during the sweep (Tasks 2-3 Step 2) with the fix-the-template-not-the-test rule is the correct enforcement direction for the byte-identical gate.
- The 1-indexing display test pins line 12 → `:13:` against a hand-built loc, and the col-indexing uncertainty is flagged with a "pin whichever is true" instruction instead of a guess.

## Summary of required changes

1. Dedup key → `code + message + loc.start`; pin both dedup directions in the Task 6 test.
2. Fix `plain()` regex to include `\x1b` in Task 5 (and Task 7's end-to-end pin).
3. Add an explicit step deciding the `TypeCheckDiagnostic` / `stdlib/agency.agency` public-API shape, with the `stdlib/agency.agency` + `make` + docs work in the file list; note the PR #514 conflict.
4. Add the conditional-message rule to the sweep recipe.
5. List the bare-`@tc-ignore`-now-suppresses-more behavior change in the Task 7 PR body and Task 6 docs update.
6. Move the `loc: null` site list into the Task 7 PR-body checklist explicitly.
7. Add the legacy-field grep to Task 4's audit.
8. Fix the anti-pattern hits in the plan's code blocks: the nested ternary in Task 5's `formatErrors`, the one-line ifs in Task 6's `applySuppressions`, and the `err.file ?? file` useless special case in Task 4's stamping loop.
9. Test plan (see Test-plan review): add the `${`-tripwire and well-formed-placeholder registry invariants (T1); make `renderMessage` throw on missing params, with a test (T2); restore the spec's location-audit test — currently absent entirely (T5); make the e2e pin pass an explicit `sourcePath` so file stamping is actually tested (T6); add a warning-severity formatter test (T7); pin the three `@tc-ignore` directive edge cases, deciding the invalid-codes-→-all hazard deliberately (T9); test `loc: null` immunity to `@tc-ignore` (T10); grow goldens to 3-4 per the spec (T11).
