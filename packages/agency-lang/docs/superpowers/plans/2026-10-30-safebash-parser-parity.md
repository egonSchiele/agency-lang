# safeBash: parser parity with the new tarsec (ADI-241) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agency-lang uses the tarsec release that parses pipelines, dup redirects, globs, and `~`, and safeBash classifies the new shapes without changing which questions it asks.

**Architecture:** Bump the pin. Mirror the two new nodes in the Agency-side AST types. The refuse-wall walk (`flattenOne`) is an exhaustive match, so it fails to build until a pipeline arm returns the stages; once it does, classification needs no new code, because `planFor` already classifies every flattened simple command and asks the broad question if any is unrecognized. A dup redirect contributes no effect. A glob word is already refused by `literalWordText`'s catch-all; a test pins it.

**Tech Stack:** pnpm, Agency, Agency execution tests, vitest.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 4 "What changes here". Linear: ADI-241, blocked by ADI-239 and ADI-240 (a released tarsec).

## Global Constraints

- `tarsec` is in `minimumReleaseAgeExclude` in `/Users/adityabhargava/agency-lang/pnpm-workspace.yaml`, so a fresh release installs without waiting out the cooldown. Bump with `pnpm add tarsec@<version>` from `packages/agency-lang` so the lockfile updates; never hand-edit the lockfile.
- No question changes in this slice: every string that asked `std::bash` before still asks it, and no string that asked a narrow question asks a different one. The existing `tests/agency/safeBash.test.json` expectations must pass unchanged except where a case was unparseable and is now unrecognized, which produces the same plan.
- `make` after `.agency` changes; `pnpm run build` after `.ts` changes; `pnpm run typecheck`, `pnpm run lint:structure`, prettier on named files.

## Review Focus

- A pipeline whose every stage is recognized today can only be git commands and echoes, so `git status | git log` is the narrow case and `git status | head` is the broad case. Pinned in Task 2.
- `echo hi 2>&1` is recognized (echo, dup redirect contributes nothing) and raises nothing, so the audit rule asks `std::bash`; it must not be shell-free. Pinned in Task 2.
- `echo hi 2>&1 > out.txt`: one dup, one write; must raise `std::write` for `out.txt`. Pinned in Task 2.
- `echo *.md` must be unrecognized (the shell-free path cannot compute what bash expands). Pinned in Task 2.
- `rm -rf x | cat`: the wall must still refuse through a pipeline stage. Pinned in Task 2.

---

### Task 1: The pin and the mirrored types

**Files:**
- Modify: `package.json` (`tarsec` pin), `../../pnpm-lock.yaml` via pnpm
- Modify: `stdlib/safeBash.agency` (the `Word`, `FlagWord`, and `Command` types; `flattenOne`)
- Test: `lib/stdlib/safeBash.test.ts` (round-trip list)

**Interfaces:**
- Consumes: tarsec `Pipeline { tag: "pipeline"; stages: Command[] }`, `GlobWord { tag: "glob"; text: string }`, `FlagWord.valueIsGlob?: boolean`, redirect `op: ">&"`.
- Produces: the same shapes as Agency types in `stdlib/safeBash.agency`; `flattenOne` returns a pipeline's stages flattened.

- [ ] **Step 1: Bump the pin**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang/<worktree> && pnpm add tarsec@<released version> > /tmp/pin.txt 2>&1; tail -3 /tmp/pin.txt; git diff --stat`
Expected: `package.json` and the root lockfile changed, nothing else.

- [ ] **Step 2: Extend the round-trip test and watch it fail to build**

Add to the list in `lib/stdlib/safeBash.test.ts`: `"grep -rn foo src | head -20"`, `"make 2>&1 | tail -100"`, `"echo x >&2"`, `"ls *.txt"`, `"cat ~/notes.txt"`, `"grep -rn x --include=*.ts src"`.

Run: `pnpm vitest run lib/stdlib/safeBash.test.ts > /tmp/parity-t1.txt 2>&1; tail -6 /tmp/parity-t1.txt`
Expected: PASS already, since the test goes straight to tarsec. Then run `make > /tmp/make-parity.txt 2>&1; grep -n "safeBash" /tmp/make-parity.txt | head` and expect the exhaustive `flattenOne` match to fail the build on the new `pipeline` variant once the types in Step 3 are in. (If `make` hides the diagnostic, run `pnpm run agency typecheck stdlib/safeBash.agency`.)

- [ ] **Step 3: Mirror the types in `stdlib/safeBash.agency`**

Add `GlobWord` (`tag: "glob"; text: string`) to the `Word` union, `valueIsGlob?: boolean` to `FlagWord`, and `Pipeline` (`tag: "pipeline"; stages: Command[]`) to `Command`, each with the one-sentence comment from the tarsec types. In `flattenOne`, add the arm:

```
{ tag: "pipeline", stages } => [...[flattenOne(s) for s in stages].flat()]
```

or the loop equivalent if comprehension-plus-flat does not typecheck; the result is every simple command in every stage, in order.

- [ ] **Step 4: `make`; run the existing safeBash Agency tests**

Run: `make > /tmp/make-parity.txt 2>&1; tail -3 /tmp/make-parity.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/parity-t1b.txt 2>&1; tail -5 /tmp/parity-t1b.txt`
Expected: all pass. The `cat a.txt | grep x` row in `wholeStringPlans` gives the same `["bash",["std::bash"]]` as before, by the unrecognized path instead of the unparseable one.

- [ ] **Step 5: Commit**

```bash
git add package.json ../../pnpm-lock.yaml stdlib/safeBash.agency lib/stdlib/safeBash.test.ts
git commit -F /tmp/msg.txt   # "safeBash: tarsec <version>, pipelines and glob words in the AST"
```

---

### Task 2: Dup redirects contribute nothing; the new shapes in the plan tests

**Files:**
- Modify: `stdlib/safeBash.agency` (`redirectEffect`, `prepareRedirectWrite`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `BashExec.reason` and the `planReason` test helper from ADI-238 (merged first), and the `planSummary` and `effectNamesFor` helpers already in the test file.
- Produces: `redirectEffect` ignores redirects with `op == ">&"` before applying its one-redirect rule; `prepareRedirectWrite` is unchanged and still fails on any op other than `>` and `>>`.

- [ ] **Step 1: Write the failing plan tests**

Add a node to `tests/agency/safeBash.agency`:

```
node newShapes() {
  return [
    planSummary("git status | git log"),
    planSummary("git status | head"),
    planSummary("echo hi 2>&1"),
    planSummary("echo hi 2>&1 > out.txt"),
    planSummary("echo *.md"),
    planSummary("rm -rf x | cat"),
    planSummary("make 2>&1 | tail -100"),
    planReason("git status | head"),
  ]
}
```

`expectedOutput`:

```
[["bash",["std::git::status","std::git::log"]],["bash",["std::bash"]],["bash",["std::bash"]],["bash",["std::write"]],["bash",["std::bash"]],["refuse",[]],["bash",["std::bash"]],"unrecognized: no rule for `head`"]
```

- [ ] **Step 2: Run to see the dup-redirect cases fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/parity-t2.txt 2>&1; grep -n newShapes -A4 /tmp/parity-t2.txt`
Expected: `echo hi 2>&1` and `echo hi 2>&1 > out.txt` fail (today a `>&` op makes `redirectEffect` fail, which makes the command unrecognized; the second case would wrongly be `["bash",["std::bash"]]`).

- [ ] **Step 3: Skip dup redirects in `redirectEffect`**

At the top of `redirectEffect`, filter `redirects` to those whose `op != ">&"`, with a two-line comment: a dup redirect moves a stream and writes no file, so it contributes no effect; it is the only `>&` form the parser accepts. The rest of the function runs on the filtered list.

- [ ] **Step 4: `make`; run to see all pass**

Run: `make > /tmp/make-parity2.txt 2>&1; tail -3 /tmp/make-parity2.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/parity-t2.txt 2>&1; tail -5 /tmp/parity-t2.txt`

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a dup redirect contributes no effect; plan tests for the new shapes"
```

---

### Task 3: One end-to-end run through a pipeline

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

- [ ] **Step 1: Add the node and its approval**

```
node pipelineRunsThroughBash() {
  const result = safeBash("echo hi | tr a-z A-Z")
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return result.value
}
```

`interruptHandlers`: one approve of `Are you sure you want to run this shell command?`; `expectedOutput`: `"HI\n"`. This pins that the rebuilt text keeps the pipe and bash does the plumbing.

- [ ] **Step 2: Run, commit**

```bash
git add tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: a pipeline runs through bash as one string"
```

---

### Task 4: Dev doc, checks, PR

- [ ] **Step 1: Dev doc**

In `docs/dev/stdlib/safe-bash.md` (from ADI-238), a short section "Pipelines, dup redirects, and glob words": a pipeline is recognized when every stage is; the wall sees every stage; `2>&1` contributes nothing; a glob is never literal, so every rule that needs a literal treats it as unrecognized until a later slice gives it a meaning.

- [ ] **Step 2: Checks**

Run: `pnpm run typecheck > /tmp/tc.txt 2>&1; tail -3 /tmp/tc.txt; pnpm run lint:structure > /tmp/lint.txt 2>&1; tail -3 /tmp/lint.txt; npx prettier --check lib/stdlib/safeBash.test.ts`
Then `/anti-pattern-check` on the diff.

- [ ] **Step 3: PR**

Title: `safeBash: tarsec <version>, parity for pipelines, dup redirects, and globs (ADI-241)`. Body in a file. The owner merges.
