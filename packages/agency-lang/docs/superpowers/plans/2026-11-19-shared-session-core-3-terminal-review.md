# Review: Shared Session Core, Plan 3 (the terminal on the core)

Checked against agency-lang at `cfc225a6f` (this worktree) and Perry `origin/main` at `e794183`. Every claim below was read from the code. File paths are given so each can be checked.

## Summary

The plan has the right shape. One driver in agency-lang, a slow handoff test first (A1), and the switch held back until jobs are designed. These are the right calls, and the "What was found out" section is accurate where I checked it.

Two problems would stop the plan from meeting its own goal, and both get past the tests as written:

1. **"Stays that strict" does not hold.** With two policies as two handlers, only the session's *rejects* follow it. Its *silences* do not (see 1).
2. **A stored `*` reject ends the session.** The session's stored policy reaches the core's own pause, `agent::sessionInput` (see 2).

Next come a few gaps in Part D's description of the terminal driver (3 to 6). After that, smaller points.

---

## Must fix

### 1. A session started with `--policy minimal` is not kept strict

Plan goal 2 says: "A session started with `--policy minimal` stays that strict when another front-end resumes it." The mechanism in B1/B2 cannot do this.

- `minimalAutoApprovePolicy` (`lib/runtime/builtinPolicies.ts:119`) has rules only for memory and `std::exec`. It has **no rule** for `std::read`, `std::ls`, `std::http::fetch` and the rest.
- `makeRunPolicyHandler` returns `undefined` (no response) for an effect the policy does not match (`lib/runtime/runPolicyHandler.ts`, `checkPolicyExplicit(...) === null`).
- Handlers combine as reject > propagate > approve > no response (`lib/runtime/interrupts.ts:506-518`).

Take a session started with `--policy minimal` and resumed by a plain `agency agent --resume`. The resumer's own policy is `policy.json`, usually `recommended` (`getPolicyForAgent`, `AGENT/lib/policy.agency:84-102`). Perry's default is also `recommended`. The front-end's policy approves `std::read`, the session's policy says nothing, so the read is **approved without asking**. Only explicit rejects follow the session.

Review Focus 2 and the B2/E1 tests only try `--reject` and an explicit `reject` rule, so they pass while the headline goal fails.

What to decide, and write into "Decisions":
- **(a)** When a session carries a policy, a resuming front-end does not add its own default (`policy.json` or `recommended`). It uses the session's policy plus only the flags it was given now. This matches what the terminal does today: with any policy flag, `getPolicyForAgent` drops `policy.json` and saves "always" answers to `SESSION_POLICY_PATH` instead. "Follows the session" then means the same thing it means at start.
- **(b)** Only rejects follow the session. Then change the goal's wording and drop "`--policy minimal` stays that strict".

Pinning the session policy's unmatched effects to `propagate` is not a fix. Propagate beats approve, so it would also override every "always" rule the user saves later.

Either way, add the case to the tests: a `minimal` session resumed under `recommended`, then a read outside every rule.

Related, also to decide: a session started with flags saves its "always" answers to `SESSION_POLICY_PATH`. They are not in the session's stored policy, which is fixed at start. So the other front-end asks again. That is probably fine, but say so.

### 2. The session's stored policy can reject the core's own pause

`core.agency:10` says: "Its policy must leave that effect [`agent::sessionInput`] to `propagate`." Perry does this for its own policy (`withPerrysPauseLeftAlone`, `perry/src/agent/policy.ts`), and an effect's own rule beats `*` *within one policy*.

The session's stored policy gets no such pin. With two handlers, **a reject from either wins over propagate**. So a session started with `--reject '*'` stores `{"*": [reject]}`. At the next resume, that policy rejects `agent::sessionInput`, and the core ends the session (the same failure Perry's comment describes). A stored `*: approve` (`--policy approve-all`) is safe only because the front-end's propagate outranks it.

Fix: the driver pins `agent::sessionInput` to `propagate` in **every** policy it installs (move `withPerrysPauseLeftAlone` into the driver and apply it to both). Alternatively, B2 stores the session policy with the pin added. Add a test: start with `{"*": [{action: "reject"}]}`, then send a second message.

### 3. Who writes an "always" rule, and how the two in-memory policies stay in step

C3: `askAbout` "writes no file" and returns the updated policy. D2: the terminal driver holds "the policy and the file 'always' answers are saved to". The plan never says who writes the file, or with what.

- Writing it from `agentTerminalDriver.ts` would add a second writer of `policy.json` beside `std::policy`'s `writePolicyFile`/`addPolicyRules` (`stdlib/policy.agency:453, 584`). That copy would also skip the `isOwnPolicyIo` re-entrancy rules. Use the existing writer.
- The shell run still installs `cliPolicyHandler` for its own interrupts (MCP connect in `maybeLoadMcp`, `!cmd`, `/image` reads). Its `_policy` global (`stdlib/policy.agency:231`) is a second in-memory copy. An "always" given at a session approval must reach it too. Otherwise the shell asks again about something the user just approved forever, or overwrites the file with its older copy at its next `maybeFlush`.

Simplest fix: `askAbout` keeps `std::policy`'s module state as the single copy (it runs in the shell run, where that state lives) and records and flushes the way `askUser` does now. The driver reads the current policy from it before each leg, through an exported getter, and keeps no copy of its own.

### 4. Esc inside `askAbout`

`askUser` calls `interruptChoice(..., allowCancel: true)`, and Esc there "raises a cancellation that unwinds the turn back to the REPL prompt" (`stdlib/policy.agency:1054-1057`). In D2, `askAbout` is called from TypeScript (`_send` → the function given to `_setAsk`), through `callBridgeFn` (`lib/stdlib/cli.ts:41`). That cancellation therefore arrives inside `_send` as an exception. D2 has to say that `_send` catches it and turns it into the driver's `approvalCancelled`. Otherwise Review Focus 5 depends on where the exception happens to land. `_cancel()` as listed covers only an Esc that arrives from outside the prompt.

### 5. Taking hold happens on resume, not first on the next save

"A session's record names the front-end that last resumed it". But the only writer of `heldBy` in the plan is `saveRun`, at a pause. Suppose the terminal runs `--resume` on a session Perry has open, and the terminal's first turn is long. Until that turn's first pause, Perry's `stillHeld` still says yes, and Perry can run a leg and save over the terminal's start. Add `takeHold({ dir, id, holder })` to `savedRun.ts`. `_resumeSession` and Perry's `POST /sessions/:id/open` call it before the first leg. Add a test: B resumes, then A's next leg is refused before B has saved anything.

### 6. A5 deletes Perry's `approvals.ts` whole, but Perry still needs part of it

A3 says the driver's queue is Perry's "without Perry's three-answer decisions". A5 Step 2 then deletes `perry/src/agent/approvals.ts`. Perry still needs `approvalKey`, `SessionApprovals`, `rememberDecision`, `answer` and the `yes / yesSession / no` mapping, and they need a home (say `perry/src/agent/sessionApprovals.ts`).

Perry also loses `CANNOT_ANSWER_REASON` with the queue's typed-value reject, which is A3's intended change. Perry's `settle` has to decline a typed-value raise itself. Otherwise "no behaviour changes" is false: the Mac app gets a typed-value prompt it cannot answer. Say both in A5.

---

## Should fix

### 7. `Happened` cannot carry "by the rule just saved"

`settle` returns `{ response, by: "rule" }`, but `Happened.settled` has only `interrupt` and `response`. Add `by`, or the terminal cannot print the line D2's test expects. Also say who prints it. `std::policy` prints it today, in `_handler` (`stdlib/policy.agency:1302-1306`), not in `askUser`. In the new flow the driver settles the rest of the queue *before* calling `askAbout`, so `askAbout` never sees those interrupts. The driver loop, or the shell code that handles `Happened`, has to print it.

D2's sentence "It re-reads the policy before each leg, so a rule saved by one answer settles the rest" mixes up two steps. The rest of *this* pause are settled by `settle` after each answer, inside the queue. Re-reading before each leg is about the next pause.

### 8. Perry-started sessions do not carry their policy

B2 ends with: "Its `programStart` passes `policy: null`." But Perry takes `--policy/--approve/--reject` too (`PolicyFlags`, `perry/src/agent/policy.ts`). A session started in Perry with `--reject std::bash` and continued in the terminal loses the reject. Pass the policy Perry's flags resolved to, without Perry's pause pin (or with it, if fix 2 lands), or null when no flags were given. The work is small, and it makes the decision hold both ways, which is the point of the plan.

### 9. B1 alternative worth weighing: the session's policy as a handler inside the core

B1 changes the public `InvocationOptions.policy` (every serve host sees `Policy | Policy[]`) and the resume setup, all to install one more policy. The core could do this itself. It already keeps the policy in a `let` (B2). It could wrap the turn in a `handle` block whose handler calls `checkPolicy(sessionPolicy, intr)` and returns reject, approve or `pass`.

- It uses handlers, the existing mechanism. The meaning is the same as two root handlers, since an inner reject is final and the outer front-end policy still sees the rest.
- The handler sits around the turn, not around the `agent::sessionInput` raise, so problem 2 cannot happen.
- No runtime or driver change, and no API change. Every caller of the core gets it, including one that does not use the driver.
- Cost: the dirs used for placeholders (`.`, `<agent-home>`) must resolve the same way inside Agency code. Check `std::policy`'s `checkPolicy` against `checkPolicyExplicit` with `PolicyDirs`.

If B1 stays, the docs change in `policies.md` should be short. It is a rarely used option.

### 10. `_setAsk` is module state that needs no setter

`agentTerminalDriver.ts` already holds one session per process. Passing `ask` to `_startSession`/`_resumeSession` (or to each `_send`) removes a setter that must be called in the right order. The same holds for keeping the policy file path there: with fix 3 it is not needed.

---

## Smaller points

- **A4's `PauseData.brain`.** `currentRecord` already returns `{ ...record, brain: currentBrainName() }` (`core.agency:179`). For a saved session the pause has it in `record.brain`. A separate field is only needed for an unsaved session. Fine, but say why both exist, or read it from one place.
- **Usage across a resume.** `invocationUsage.ts` calls itself "per-invocation usage accounting". The checkpoint does carry `usage` (`checkpointStore.ts:181, 786`), so the total probably does span legs. A1 already runs two legs, so assert there that the second result's usage is at least the first's before `/cost` and the footer rely on it. Also note that the footer's `TokenSnapshot.models` (`lib/stdlib/cli.ts:1162`) must be built from `RunUsage.entries`. D1 says only "tokens".
- **`resolvePolicy` in Perry** is a self-described copy of agency-lang's `resolveRunPolicy` (`perry/src/agent/policy.ts`, docstring). Plan 3 is the natural place to export the original from agency-lang and delete the copy, since B2 needs "the policy the flags resolved to" computed the same way in both front-ends. Not required, but the plan is already moving this boundary.
- **C2's 7 new answers.** `/local` and `/settings` (`capabilities: any`) are the largest. If Part D is blocked on jobs anyway, they could land with D rather than in the B+C release. That keeps the B+C pull request to what Perry can use now (policy, `rename`, `fork`, `compact`, `search`). That is a sequencing choice, not a correction.
- **E1's 409 text** says "continued in a terminal". The holder could be another Perry engine process (another pid), so use `heldBy.frontEnd` to choose the wording.
- **`heldBy.at`** is written but nothing reads it. Drop it, or say what it is for (a stale-holder rule?).

## Effort and impact

| Part | Effort | Impact | Note |
| --- | --- | --- | --- |
| A1 test | S | High | Right first step. Also measure file size (as the plan says) and usage across legs. |
| A2–A3 driver move | L | High | Must-do. The move is mostly code that already works in Perry. |
| A4 core fixes | S | Medium | Removes two Perry workarounds. |
| A5 Perry on driver | M | Medium | See 6. |
| B policy follows | M | High | Needs the decision in 1 and the fix in 2. 9 may make it smaller. |
| C1 trace to process | S | Needed for D | Fine. |
| C2 answers | M–L | Needed for D | Could split (see above). |
| C3 `askAbout` | M | Needed for D | See 3 and 4. |
| D switch | L | High | Blocked on jobs, correctly. |
| E1 lazy list + hold | M | High | The holder rule is needed once Perry sees terminal sessions. See 5. |

Nothing in the plan is low-impact work that should be cut. Docs are sized right: one new dev doc (`session-driver.md`), with updates to the docs that exist.

## Existing code to reuse (checked)

| Need in plan | Existing | Use it? |
| --- | --- | --- |
| Calling the `ask` function from TS | `callBridgeFn` (`lib/stdlib/cli.ts:41`) | Yes. Name it in D2. |
| Writing "always" rules | `addPolicyRules` / `writePolicyFile` in `stdlib/policy.agency` | Yes (see 3). |
| Pinning the pause effect | `withPerrysPauseLeftAlone` (`perry/src/agent/policy.ts`) | Move into the driver (see 2). |
| The brain in the pause | `currentRecord`'s `brain` (`core.agency:179`) | Partly (see smaller points). |
| Policy flag resolution | `resolveRunPolicy` (agency-lang CLI), copied in Perry | Export it and delete the copy. |
| Per-model footer data | `RunUsage.entries` (`lib/runtime/invocationUsage.ts`) | Yes, map it into `TokenSnapshot.models`. |
