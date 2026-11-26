# Architecture review: the learntest brain plan

Reviewed: `docs/superpowers/plans/2026-11-25-learntest-brain.md`

**Summary.** The plan is small and mostly additive. It has three reuse mistakes, which are now fixed in the plan. It has four points that need the owner's decision. The largest is whether the experiment should be built into the stdlib before anything has shown that a model will go looking for tools.

Findings are marked **fixed** when the plan was corrected, and **decision** when the owner has to choose.

---

## 1. Major features and public API

The plan touches four public things.

| What | Change | Risk |
|---|---|---|
| `agencyAgent` in `std::agents/agency` | One more value for `brain` | None. Additive, and it follows `scripttest` and `spawntest`. |
| `minimalBrain` in `std::agents/brains/minimal` | Its options move into an exported `minimalOptions` | Low. The brain's behavior is unchanged, and `brainMinimal.agency` covers it. One new exported function with one outside caller. |
| The coordinator's `learnTools` | Two imports change | Low. The body does not change, and three existing tests cover it. |
| A new stdlib module, `std::agents/lib/learning` | New public functions `getGeneratedTools` and `learnSessionTools`, with a module-level global | See finding 1.1. |

Nothing in the plan changes how an interrupt is raised, answered, or resumed. The brain adds no handler.

### 1.1 The learned tools belong to the run, and the plan does not say so (decision)

`learnedState` is a top-level `let`, so there is one copy per run. In the command-line agent that is correct, because one run is one conversation.

`agencyAgent` is a library function. A program can call it several times in one run, and each call as a tool starts on a fresh thread. With the state in the stdlib, a tool that the first call learned is in the second call's tool list. Example:

```agency
node main() {
  const a = agencyAgent("Look up the top Hacker News story.", brain: "learntest")
  const b = agencyAgent("Fix the failing test in src/.", brain: "learntest")
  return [a, b]
}
```

The second call is offered `hnTopStories`, which it never asked for.

For a trial brain run once per process, this does not matter. It does matter for the claim in the plan that Perry can import the module. Perry's process holds many sessions (`docs/dev/agents/agent-brains.md`, "A process that holds many sessions"). If each session is its own run, the state is separate and there is no problem. If two sessions can share a run, they would share learned tools.

Options:

1. Accept it for the trial, and write one sentence in the brain's dev doc section: "Learned tools belong to the run. Two `agencyAgent` calls in one run share them."
2. Key the records by conversation thread. This is more code and is not needed to answer the experiment's question.

Recommendation: option 1. I have not checked how Perry maps sessions to runs, so the plan's sentence about Perry should say "can import" and promise nothing more.

### 1.2 The names in the new public module are the harness's names

`learnSessionTools` and `getGeneratedTools` were named for a private file. As stdlib exports they appear in the generated reference. The names are accurate enough, and renaming them turns a pure move into a larger diff across four test files. Recommendation: keep the names.

---

## 2. Effort and impact

| Task | Effort | Impact | Verdict |
|---|---|---|---|
| 1. Move the state into the stdlib | Small, mechanical | Required by the brain; also what Perry needs | Keep |
| 2. Path translation | Small after the reuse fix below | Required: a stdlib file must be learned as a module | Keep, with one optional part (2.1) |
| 3. `minimalOptions` | Tiny | Keeps the trial brain identical to minimal apart from its additions | Keep |
| 4. The brain and its tests | Medium. The scripted-client test is most of it | The feature | Keep |
| 5. The index file | Medium: 25 modules checked by hand | Required for the "categories plus a path" design | Keep, but see 2.2 |
| 6. Dev docs | Small | One section, the same size as the other trial brains | Proportionate |
| 7. Verify, and the manual run | Small | The manual run is the cheapest test of the largest risk | Move earlier (2.3) |

The feature is a trial brain. In the scale of the codebase it is small: about 60 lines of Agency, one TypeScript helper, one data file. The plan gives it one doc section, no user guide page, and tests that take about as long as the existing learning tests. That is in proportion.

### 2.1 The second lookup for relative paths is optional (decision)

Rule 3 looks for a relative path in the working directory and then in the stdlib folder. Its only purpose is to let the index list short paths. It costs one branch and three tests. The alternative is that the primer says "paths in the index are relative to the stdlib folder" and the model joins them, which is one more thing for the model to get wrong. Recommendation: keep the two-step lookup. It is cheap, and a wrong join would look like a failure of the idea when it is a failure of path handling.

### 2.2 The index is curated by hand and will drift

The descriptions are copied from each module's `@summary`. Nothing updates them when a summary changes, and nothing adds a line when a new connector is written. The test only catches a file that no longer exists.

Generating the index during `make` would fix the drift. It would also add a build step, a generator script, and a stamp file for a brain that may be deleted after the experiment. Recommendation: keep it hand-written for the trial. If the experiment succeeds, generating the index is the first follow-up.

### 2.3 The manual run should happen as soon as the brain exists (fixed)

The plan had the real-model run as the last step before the PR, after 25 modules had been curated and the docs written. The largest risk is that the model never calls `learn`. That can be tested the moment the brain and a three-line index exist. The plan now puts the manual run directly after task 4, with a short index, so the primer wording can change before the rest is built on it.

---

## 3. The 80/20 option (decision)

**The goal** is to find out whether a model with a small tool list will find and learn tools, and what that costs.

**A cheaper way to find out** needs no change to agency-lang at all. The experiment can be an Agency program in `~/agency-evals`:

```agency
import { agencyAgent } from "std::agents/agency"

node main(task: string) {
  return agencyAgent(
    task,
    brain: "minimal",
    context: PRIMER,
    extraTools: { main: [learn.partial(...)] },
  )
}
```

The `learn` handoff would be defined in that program. It would import `learnSessionTools` from the agent's compiled modules, which the package already exports by path (`docs/dev/agents/agent-brains.md`, "The agent's modules, from outside the package"). The index would be a file in the eval repo.

| | Built into the stdlib (the plan) | A program in the eval repo |
|---|---|---|
| agency-lang changes | Tasks 1 to 6 | None |
| Needs a release before phase 2 | Yes | No |
| Runs on the coding benchmark with `--brain` | Yes | No. The benchmark starts `agency agent`, which would need the program wired in another way |
| Usable by Perry | Yes, after the release | No |
| Matches how trial brains are done here | Yes | No |
| The primer's position in the request | A system message that stays on the thread and is cached | `context`, which is sent again on every call and is not cached |
| Finding the stdlib folder | A direct helper | Indirect: the parent of `bundledDocsDir()` |

The last two rows matter. The owner's concern is the cost of extra system text over a long run, and `context` would overstate that cost because it is not cached. A result from the eval-repo version would not transfer cleanly to a real brain.

Recommendation: keep the plan's approach. The stdlib version is perhaps a day more work, it measures the cost correctly, and it leaves something Perry can use. The owner asked for a new brain on top of minimal, and this section exists so that choice is made knowing the alternative.

One consequence of the plan's approach that the plan did not state: **phase 2 needs an agency-lang build that contains the brain.** If the eval suite runs in containers that install the published package, phase 2 waits for a release, and that release should be batched with other work. If the suite can run against a local build, it does not wait. The plan now states this dependency and leaves the choice to the phase 2 plan.

---

## 4. Reusing code

Three helpers the plan would have written already exist. All three are fixed in the plan.

### 4.1 Path to module name (fixed)

The plan had `_learnSource` build the `std::` name itself. `stdlibModuleName(absPath)` in `lib/importPaths.ts:150` already does this:

```ts
export function stdlibModuleName(absPath: string): string {
  const rel = path.relative(getStdlibDir(), absPath).replace(/\.agency$/, "");
  return "std::" + rel.split(path.sep).join("/");
}
```

### 4.2 "Is this path inside that folder" (fixed)

The plan described the check and added a test to guard against a string-prefix mistake. `isContained(target, root)` in `lib/stdlib/isContained.ts` already does it correctly, including the root-folder and Windows cases. The plan's test 9 stays, because it now tests that `_learnSource` uses the helper.

### 4.3 The stdlib folder (fixed)

The plan added `_stdlibDir()` in the new file and also exported `stdlibDir()` from `lib/stdlib/skills.ts`. That would have been two new names for one value, beside `getStdlibDir()` in `lib/importPaths.ts`, which already exists. The plan now adds one exported function, `_stdlibDir()`, in `lib/stdlib/skills.ts` next to `_agentPromptsDir()` and built the same way, through the host. `_learnSource` and the brain both use it.

Two functions for the stdlib folder remain in the codebase after this: `getStdlibDir()` for the compiler and the host-based one for the runtime. That split exists today and the plan does not widen it. `stdlibModuleName` uses the compiler's one. The implementer must confirm both return the same folder in a source checkout and in an npm install, and the module-source test in task 4 would fail if they did not.

### 4.4 The source type (fixed)

`_learnSource` returns a value of the existing `AgencySourceValue` type from `lib/stdlib/agencyFunctions.ts:23`. The plan now names it, so no fourth spelling of that union is declared.

### 4.5 The two learn handoffs are deliberately separate

The brain's `learn` and the coordinator's `learnTools` have the same shape: learn, rebuild the tool list, call `llm`, call `endTurn`. They could share one function that takes the tool list builder as a parameter.

They should stay separate for now. The coordinator is the production agent and the brain is an experiment. A shared function would mean a change made for the experiment could alter the coordinator. The duplicated part is about ten lines. If the experiment succeeds, the right unification is the other direction: give the coordinator's `learnTools` the flat `file` and `names` arguments and delete the nested `source` argument.

---

## 5. Concepts

### 5.1 Four things are now called "learn"

| Name | Where | What it does |
|---|---|---|
| `learn` | `std::agency` | The library function. Returns tools. |
| `learnTools` | the coordinator | A handoff that takes a `source` record. |
| `learn` | the `learntest` brain | A handoff that takes a file path. |
| `learnSkill`, `learned_<name>` | the command-line agent | Saved skills and saved tools, which are a different feature. |

A developer reading the brain file sees a `handoff def learn` that is not `std::agency`'s `learn`. The model-facing name matters for the experiment, and `learn` is the right word to show a model. The plan now names the def `learnFromFile` in the code and offers it to the model as `learn` with `.rename("learn")`, the way the minimal brain offers `readCapped` as `read`.

### 5.2 The index file is a new kind of file

`stdlib/agents/prompts/` holds system prompts read with `agentPrompt`. The index is a listing a model reads with its own `read` tool. It is in that folder only because the folder already ships. This is acceptable for a trial. A reader of the folder gets one sentence at the top of the file saying what it is and which brain uses it. The plan now says so.

No other new concept is added. The brain uses existing ones: a trial brain, a handoff, `.partial`, `ensureSystemMessage`.

---

## 6. What gets tied together

| Tie | Should it exist? |
|---|---|
| The trial brain uses the minimal brain's options through `minimalOptions` | Yes. The experiment is only valid if the two brains differ by the additions alone. A change to minimal should reach `learntest` automatically. |
| The coordinator and the trial brain share `std::agents/lib/learning` | Yes, with care. They share the storage, which is stable and tested. They do not share the handoff (4.5). |
| The index test fails when a listed stdlib module is renamed or removed | Yes. That is the test's purpose. The cost is that someone renaming a connector has to edit one line of a trial brain's file. |
| Perry would depend on `std::agents/lib/learning` | Not decided here. It is the owner's call when Perry's change is written, and finding 1.1 is the thing to check first. |

---

## Decisions for the owner

1. **Learned tools belong to the run (1.1).** Accept for the trial and document it, or key the records by conversation. Recommendation: accept and document.
2. **The two-step lookup for relative paths (2.1).** Recommendation: keep.
3. **Build into the stdlib, or run the experiment from the eval repo first (3).** Recommendation: the stdlib, as planned.
4. **How phase 2 gets a build with the brain (3).** A release, or a local build. This can wait for the phase 2 plan.

## Changes made to the plan

- `_learnSource` reuses `stdlibModuleName`, `isContained`, and `AgencySourceValue`.
- One `_stdlibDir()` export in `lib/stdlib/skills.ts`; no second wrapper.
- The handoff is `learnFromFile`, offered to the model as `learn`.
- The brain's code in decision 4 is the final code. Task 3 no longer asks for a line to be changed afterwards.
- The manual run moves to directly after task 4, with a short index.
- The plan states that phase 2 needs a build that contains the brain.
- The index file starts with a sentence saying what it is.
