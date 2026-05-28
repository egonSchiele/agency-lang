# TS-helper integration tests — follow-up coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** close the remaining `agency.*` namespace gaps left by PR #213. That PR covered the highest-risk integration paths (interrupts/handlers/resume/forks/cost-guard) but deferred several user-facing helpers — this plan adds integration tests for them in the same triplet style.

**Architecture:** new tests live alongside PR #213's under `tests/agency/ts-helpers/`. Each test is a self-contained triplet — `agent.agency` + `helper.js` + `agent.test.json` — driven by the existing `tests/agency/` runner. No new test infrastructure, no production code changes. If a test surfaces a runtime bug, stop and file a precursor PR.

**Tech stack:** existing `tests/agency/` runner; `pnpm run agency test <dir>`; declarative `.test.json` assertions; deterministic LLM mock (`llmMocks` in `.test.json`) for the `agency.llm` test.

**Prerequisites:** PR #213 (`tests: integration coverage for agency.* TS helpers`) merged. The triplet pattern, helper-file `git add -f` requirement, and `agent.*` naming convention are all established there — re-read PR #213's helper files before starting.

**Anti-pattern review** (`docs/dev/anti-patterns.md`): re-read before opening the PR. Assertions stay in `.test.json` (declarative). No JS-side `expect` / `assert` calls.

---

## Coverage gap summary

After PR #213, these `agency.*` surfaces have no integration test:

| Helper | Status before this PR |
| --- | --- |
| `agency.thread.{user,system,assistant,with,current,store,storeMaybe}` | Unit-tested only — no integration test pinning that messages written from a TS helper appear in the surrounding node's thread on resume / inside a fork branch. |
| `agency.withTimeGuard` | No integration test — mirror of `agency.withCostGuard` but for `TimeGuard`. |
| `agency.withCallsite` | No integration test pinning that a TS-helper-created checkpoint inside `withCallsite(loc, ...)` carries the override location into the checkpoint store. |
| `agency.checkpoint` / `agency.getCheckpoint` / `agency.restore` | Indirectly exercised by resume tests; not directly tested from TS code. |
| `agency.llm` | Deferred in #213 (needs mocks). |
| `s.getLocal` / `s.setLocal` on `ResumableScope` | Unit-tested only; not pinned across the real resume cycle. |

**Out of scope:** pure ALS accessors (`agency.ctx`, `agency.ctxMaybe`, `agency.callsite`, `agency.global`) — these are exercised transitively by every test in PR #213 (every helper that reads runtime state goes through them). Adding standalone tests for them is busywork.

**Also out of scope:** `agency.withTestContext` — internal test helper, not user-facing.

---

## File Structure

All new files under `packages/agency-lang/tests/agency/ts-helpers/<name>/`:

- Create: `time-guard-trips/agent.agency`, `time-guard-trips/helper.js`, `time-guard-trips/agent.test.json`
- Create: `thread-from-ts-helper/agent.agency`, `thread-from-ts-helper/helper.js`, `thread-from-ts-helper/agent.test.json`
- Create: `with-callsite-override/agent.agency`, `with-callsite-override/helper.js`, `with-callsite-override/agent.test.json`
- Create: `ts-checkpoint-restore/agent.agency`, `ts-checkpoint-restore/helper.js`, `ts-checkpoint-restore/agent.test.json`
- Create: `resumable-scope-locals/agent.agency`, `resumable-scope-locals/helper.js`, `resumable-scope-locals/agent.test.json`
- Create: `ts-llm-call/agent.agency`, `ts-llm-call/helper.js`, `ts-llm-call/agent.test.json`

No production code is touched.

---

## Test inventory (7 tests)

Listed in landing order — earliest tests are the simplest mirrors of PR #213 patterns; the `agency.llm` test lands last because it introduces LLM mocks.

### Test 1: `time-guard-trips`

**Pins:** `agency.withTimeGuard(maxMs, fn)` trips when the wall-clock spent inside `fn` exceeds the budget; the trip surfaces as a catchable `GuardExceededError` with `type === "time"`.

**Shape:**
- `agent.agency`: `import { run } from "./helper.js"`, `node main() { return run() }`.
- `helper.js`: wraps body in `agency.withTimeGuard(10, async () => { await sleep(50); ... })`; catches `GuardExceededError`; returns `{tripped:true, type:"time", limit:10}`.
- `.test.json`: `expectedOutput` matches the structured failure shape. Use exact comparison on `tripped`/`type`/`limit` only — do NOT pin `spent` (timing jitter would flake the test).

**Verify pattern:** look at `cost-guard-trips`. Same shape, different guard.

### Test 2: `thread-from-ts-helper`

**Pins:** cross-language thread sharing — TS-side `agency.thread.user(...)` and agency-side `std::thread.systemMessage(...)` write to the SAME active `MessageThread`. Updated after PR #214 review feedback to actually exercise both sides (the initial JS→JS round-trip would have passed even if `agency.thread.*` targeted a separate store).

**Shape:**
- `agent.agency`: imports `writeFromJs, readThread` from `./helper.js` and `systemMessage` from `"std::thread"`. `node main()` interleaves three writes — `writeFromJs("first-from-js")`, `systemMessage("middle-from-agency")`, `writeFromJs("last-from-js")` — then returns `readThread()`.
- `helper.js`: `writeFromJs(content)` calls `agency.thread.user(content)`; `readThread()` returns `agency.thread.current().messages.map(m => ({role: m.role, content: m.content}))`.
- `.test.json`: `expectedOutput` is the JSON of all three messages in insertion order. If the two sides targeted different stores, either the agency-side "middle" or the JS-side bookends would be missing.

### Test 3: `with-callsite-override`

**Pins:** `agency.withCallsite(loc, fn)` makes `agency.checkpoint()` inside `fn` attribute the new checkpoint to the override `loc` (specifically `moduleId`, `scopeName`, `stepPath`) rather than the surrounding step's callsite.

**Shape:**
- `agent.agency`: `import { run } from "./helper.js"`, `node main() { return run() }`.
- `helper.js`: inside `run()`, calls `agency.withCallsite({moduleId: "my.helper", scopeName: "phase-a", stepPath: "9.9"}, async () => { const cpId = await agency.checkpoint(); return agency.getCheckpoint(cpId) })`. Returns `{moduleId, scopeName, stepPath}` extracted from the checkpoint.
- `.test.json`: `expectedOutput` is `{"moduleId":"my.helper","scopeName":"phase-a","stepPath":"9.9"}`.

**Note:** `agency.checkpoint()` takes no args (returns `Promise<number>`); the source location is read from the active ALS callsite, not a label arg. See `lib/runtime/agency.ts`.

### Test 4: `ts-checkpoint-restore`

**Pins:** a TS helper can take a manual checkpoint with `agency.checkpoint(...)`, do work that mutates frame-local state, then call `agency.restore(cpId)` to roll back to the snapshot. The post-restore execution observes the pre-mutation state.

**Shape:**
- `agent.agency`: `import { run } from "./helper.js"`, `node main() { return run() }`.
- `helper.js`: inside `agency.withResumableScope`, sets `s.setLocal("count", 1)`, takes `cpId = await agency.checkpoint()`, sets `s.setLocal("count", 999)`, calls `agency.restore(cpId)` (sync — throws `RestoreSignal`, no `await`). The post-restore continuation sees `count === 1`. Returns `s.getLocal("count")`. A JS-module-level counter prevents the would-be infinite "restore → re-enter → mutate → restore" loop (the marker survives node restart because module state is NOT serialized).
- `.test.json`: `expectedOutput` `1`.

**Risk:** `agency.restore` semantics inside `withResumableScope` are not documented at the integration level — the unit tests in `checkpointStore.test.ts` and `agency.test.ts` cover individual contracts but not this composition. If `restore` from TS aborts the surrounding step instead of resuming with restored locals, this test will fail; file a precursor PR rather than papering over.

### Test 5: `resumable-scope-locals`

**Pins:** `s.setLocal` / `s.getLocal` values persist across the real resume cycle — values written before an `agency.interrupt` are observable in the resumed pass.

**Shape:**
- `agent.agency`: `import { run } from "./helper.js"`, `node main() { return run() }`.
- `helper.js`: inside `agency.withResumableScope`, `s.setLocal("phase", "pre")`, `await s.step(() => agency.interrupt({kind:"x", message:"wait"}))`, `s.setLocal("phase", "post")`, returns `s.getLocal("phase")`.
- `.test.json`: `interruptHandlers: [{action:"approve", expectedMessage:"wait"}]`, `expectedOutput: "post"`.

**Why not just rely on the existing `resumable-scope-resume` test:** that one only pins `s.step` cached return values. `setLocal`/`getLocal` go through a separate `__userLocals` namespace in `frame.locals` (see `resumableScope.ts:104`), so the serialization path is distinct and worth a dedicated assertion.

### Test 6: `ts-llm-call`

**Pins:** `agency.llm(prompt, opts)` called from a TS helper participates in the surrounding node's run — the call cost is charged to the active branch's stack, the response is surfaced to the helper, and the deterministic LLM provider's mock entry is consumed.

**Shape:**
- `agent.agency`: `import { run, getCost } from "./helper.js"`, `node main() { const result = run(); return { result: result, cost: getCost() } }`.
- `helper.js`: `run()` calls `await agency.llm("say hi")` (plain string overload — no schema needed for this test); after the call, reads `getRuntimeContext().stack.localCost` into a module variable. `getCost()` returns that variable.
- `.test.json`: `useTestLLMProvider: true`, `llmMocks: [{ "return": "hi" }]`, `expectedOutput` is `{"result":"hi","cost":0.000002}` (the deterministic provider's `SYNTHETIC_COST.totalCost` from `lib/runtime/deterministicClient.ts`).

**Risk:** `agency.llm`'s public signature is recent (PR #210); verify in `lib/runtime/agency.ts` and `lib/runtime/agencyLlm.ts` whether it takes a positional response-schema or an opts object before writing the helper. If the deterministic provider doesn't auto-activate inside the JS helper, file a precursor PR.

### Test 7: `ts-llm-call-schema`

**Pins:** the structured-output overload of `agency.llm` — when called with `{ schema: z.object(...) }`, the runtime JSON-parses the LLM content, runs the schema's `safeParse` via `extractResponse`, and returns the typed object to the caller (not the raw string). Added in response to PR #214 review feedback; mirrors Test 6 for the schema-bearing path.

**Shape:**
- `agent.agency`: `import { run } from "./helper.js"`, `node main() { return run() }`.
- `helper.js`: `run()` declares `const schema = z.object({ value: z.number() })` and returns `agency.llm("compute the answer", { schema })`. Imports `z` from `"zod"`.
- `.test.json`: `useTestLLMProvider: true`, `llmMocks: [{ "return": { "value": 42 } }]` (the object value — deterministic client `JSON.stringify`s it to `'{"value":42}'`), `expectedOutput` is `{"value":42}`.

---

## Steps

- [ ] **Step 1: Create worktree**

```bash
git worktree add .worktrees/ts-helper-integration-tests-followup -b ts-helper-integration-tests-followup main
cd .worktrees/ts-helper-integration-tests-followup/packages/agency-lang
```

- [ ] **Step 2: Land tests one at a time**

Order: 1 → 2 → 3 → 5 → 4 → 6. Rationale:
- 1 (time-guard) is the trivial mirror of PR #213's cost-guard test — de-risk the worktree setup with the cheapest test.
- 2 (thread-from-ts-helper) introduces the `thread` block pattern inside an agency node.
- 3 (with-callsite-override) introduces TS-side `checkpoint` + `getCheckpoint`.
- 5 (resumable-scope-locals) introduces interrupt round-trips for the locals path.
- 4 (ts-checkpoint-restore) is the riskiest non-LLM test (semantics of `restore` from TS).
- 6 (ts-llm-call) introduces LLM mocks — lands last so a failure here doesn't block the other 5.

**For each test:**

1. **Write the failing test triplet.** Start with `.test.json` so the expected behavior is locked in before writing the helper.

2. **Write the `.agency` entry** importing the helper.

3. **Write the `.js` helper** that exercises the target `agency.*` helper.

4. **Run the test:**

```bash
pnpm run agency test tests/agency/ts-helpers/<name>/agent.agency 2>&1 | tee /tmp/<name>.log | tail -30
```

Expected: PASS.

5. **If FAIL:**
   - Read `/tmp/<name>.log`.
   - If the failure is in the assertion: adjust the helper / `.test.json`.
   - If the failure is in the runtime (helper threw, missing API, wrong behavior): **stop**. File a precursor PR fixing the bug. Don't add test-only workarounds.

6. **Commit the triplet:**

```bash
# .js files are gitignored; force-add the helper.
git add tests/agency/ts-helpers/<name>/agent.agency tests/agency/ts-helpers/<name>/agent.test.json
git add -f tests/agency/ts-helpers/<name>/helper.js
git commit -F /tmp/<name>-msg.txt
```

Each test gets its own commit so a failed PR can be partially reverted cleanly.

- [ ] **Step 3: Validate full suite**

```bash
pnpm tsc --noEmit
pnpm run lint:structure
pnpm run agency test tests/agency/ts-helpers/ 2>&1 | tee /tmp/all.log | tail -30
```

Expected: all 16 tests (9 from PR #213 + 7 new) pass.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin ts-helper-integration-tests-followup
# Write PR body to a file to avoid shell apostrophe issues.
gh pr create --title "tests: agency.* integration coverage follow-up" --body-file /tmp/pr-body.md
```

PR body covers:
- The 6 behaviors pinned.
- Cross-link to PR #213; explicitly call out what this adds vs. what #213 covered.
- List any precursor PRs filed during execution.

---

## Verification checklist

- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm run lint:structure` clean
- [ ] All 16 tests pass under `pnpm run agency test tests/agency/ts-helpers/`
- [ ] Each test is a self-contained triplet; no shared mutable state across tests
- [ ] No JS-side `expect` / `assert` calls
- [ ] No production code changes (any runtime bugs were fixed in precursor PRs first)
- [ ] PR body cross-links every test to the `agency.*` helper it pins

## Open questions / risks

- **`agency.restore` from TS inside `withResumableScope`.** The unit tests don't cover this composition. Test 4 may surface a bug — that's the point. Budget time for a possible precursor PR.
- **`agency.llm`'s public signature.** Read `lib/runtime/agencyLlm.ts` and `lib/runtime/agency.ts` before writing Test 6. Don't guess the opts shape.
- **Deterministic LLM provider cost.** The exact per-call cost the mock provider charges is in the runtime; look it up rather than guessing.
- **`thread.current()` inside an agency `thread { ... }` block.** Verify the ALS frame inside the block exposes the block's `MessageThread`, not the surrounding node's. If not, Test 2's assertion structure has to change.
- **Coverage philosophy.** This plan deliberately leaves the pure accessors (`ctx`, `ctxMaybe`, `callsite`, `global`) untested at the integration level. If a future reviewer wants those pinned, a single test exercising all four in one helper is enough — don't write four separate tests.
