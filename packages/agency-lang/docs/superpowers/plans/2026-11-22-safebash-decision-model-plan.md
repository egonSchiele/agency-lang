# Plan: a reject-only decision-model judge for safeBash's broad lines

Draft for the owner's yes, 2026-11-22. A change to a safeBash rule needs a
written design and the owner's yes before a pull request; this is that
design. When work starts, move this file and its review into the task's
worktree.

Revised three times: after the architecture review, after the first plan
review, and after the second plan review, all on 2026-11-22. §9 lists what
each pass changed.

## Summary

Add a parameter `commandJudge` (default `null`) to `safeBash`, `startJob`,
and `startShellJob`. When it names a decision model, any command line
safeBash planned as **broad** is checked before its question is asked. A
broad line is one where safeBash cannot describe what the line will do,
so it would raise the `std::bash` interrupt for the whole line.

The check has two steps:

1. Ask the approval policy whether a rule already answers this line's
   `std::bash` question. If one does, skip the judge: no person will be
   asked, so there is nothing to save them from.
2. Otherwise, ask the judge model whether the line is too complex for a
   person to review. If it says so with enough confidence, the tool
   returns a failure asking the agent to write a simpler command, and
   nothing is asked.

The judge never approves anything. When it passes a line, doubts, or
fails, the ordinary `std::bash` question is raised exactly as today.
With `commandJudge` left `null`, nothing changes.

Narrow, read-only, in-process, refuse, and agency outcomes never see the
judge.

```text
            safeBash(command, ..., commandJudge)
                              │
                     approvedPlan(...)          (the existing chokepoint)
                              │
             planFor → resolvedPlan → refuse check
                              │
                       asJobPlan (jobs)
                              │
          ┌── commandJudge set and toRaise.broadReason != null? ──┐
          │ no                                                    │ yes
          │                                          policy pre-check on the
          │                                          exact std::bash question
          │                                            ├─ a rule decides → raiseAll   (outcome "skipped")
          │                                            └─ no rule decides → judge
          │                                                  ├─ confident reject → failure, nothing raised ("rejected")
          │                                                  ├─ fine or doubtful → raiseAll ("passed")
          │                                                  └─ judge failed     → raiseAll ("unavailable")
          ▼
      raiseAll → runPlanned
```

## 1. Where the gate sits and why there

The chokepoint is `approvedPlan` in `stdlib/safeBash.agency` (line 6054).
Every route to a shell goes through it: `safeBash` (line 6009) through
`runApproved`, and `startJob` (line 6234) through `startShellJob` (line
6271, whose call to `approvedPlan` is at line 6295). It already does the
steps the gate needs, in this order:

1. `planFor(command, dir)` computes the first plan.
2. `resolvedPlan` finalizes it. The gh repository lookup can turn a first
   plan broad here, so the gate must look at the final plan.
3. The refuse wall returns before anything is raised. The judge's
   rejection follows the same precedent: "A refusal returns before
   anything is raised: there is nothing to approve."
4. `asJobPlan` may re-plan a stepped job line as broad.
5. `raiseAll(toRaise.effects, ...)` asks every question up front.

The gate goes between steps 4 and 5 and looks at `toRaise`, the plan that
is about to be raised.

### The exact condition for "broad"

The gate runs when `commandJudge != null && toRaise.broadReason != null`.

`broadReason != null` is the right test for three reasons:

- **It is what `outcomeOf` already calls broad.** `bashOutcome`
  (line 4556) returns `"broad"` exactly when a plan's `broadReason` is set.
  Only `bashPlan` sets a non-null reason, and only when `broadPlan` calls
  it (line 4484). `stepsPlan` and the other plan builders set `null`
  (lines 4457, 4498, 4697). So the gate and the `safeBash plan` debug
  event, which logs `outcomeOf(plan)`, always agree on which lines are
  broad.
- **It is the test `approvedPlan` already uses.** A few lines below,
  `approvedPlan` decides whether to add `broadExplanation` to a rejected
  question with `if (toRaise.broadReason == null)`. The gate uses the
  same field, in the same function.
- **It narrows the type.** Inside the `if`, `toRaise.broadReason` is a
  `BroadReason`, which the judge needs for its question.

It excludes the read-only shell line, which also runs whole but raises
`std::bash::readonly` and has a `null` reason (line 5047). It includes a
job line that `asJobPlan` re-planned as broad, because the gate looks at
`toRaise` and not at `plan`.

### Why the gate keeps safeBash's rules

- **Everything is still asked up front.** A rejection returns before
  `raiseAll`, so nothing is asked, as with the refuse wall. The gate never
  adds, removes, or reorders a question. It only removes the whole ask.
  The policy pre-check reads the policy and does not raise the
  `std::bash` question. §3 covers the file reads it can cause.
- **The re-check a step gets before it runs is untouched.**
  `checkedStep` re-plans narrow steps at run time. A broad line runs whole
  in one shell and has no step re-check. The judge runs once per tool
  call, before anything runs, so its verdict cannot go stale.
- **The plan layer does not change.** The judge adds no `Execution` kind
  and no `outcomeOf` value. It is invisible to `planFor` and to every
  replay of a logged line through it. A later change that adds an outcome
  kind to represent the judge is going the wrong way.
- **Concurrency is unchanged.** Parallel tool calls spend the judge's
  latency before they raise, so prompts arrive slightly later. The check
  under the lock and the batching of parallel interrupts happen at raise
  time and do not change.

### Why a parameter and not a handler

Handlers are the language's way to decide about an interrupt in code, and
a handler can add a rejection without approving anything. A judge written
as a handler would still be wrong here, for two reasons:

- **The model would read the wrong lesson.** A handler's rejection
  reaches the model as `Tool call rejected: ...` followed by a
  do-not-retry line (`lib/runtime/prompt.ts:752`). The judge wants the
  opposite: write the command again, more simply. A plain failure from
  safeBash says that.
- **A handler cannot see why the line went broad.** It sees only the
  `std::bash` payload: `command`, `cwd`, `timeout`, and `stdin`
  (line 6463). The judge needs the `BroadReason`, which only safeBash has.

## 2. The parameter

`commandJudge` takes a small type defined in `std::safeBash`:

```ts
/** The decision model that judges broad lines: a model and its provider.
  The same shape as ModelChoice in std::agents/brains/settings, defined
  here so this module does not import an agents module. */
export type CommandJudge = {
  model: string;
  provider: string
}

export def safeBash(
  command: string,
  cwd: string = "",
  timeout: number = 120,
  exitIsFailure: boolean = true,
  commandJudge: CommandJudge | null = null,
): Result<string> raises <SafeBashEffects>

export def startJob(
  command: string,
  cwd: string = "",
  maxMinutes: number = 60,
  commandJudge: CommandJudge | null = null,
): Result<string> raises <SafeBashEffects>

export def startShellJob(
  command: string,
  label: string,
  cwd: string = "",
  maxMinutes: number = 60,
  foreground: boolean = true,
  commandJudge: CommandJudge | null = null,
): Result<ShellStart> raises <SafeBashEffects>
```

One parameter both turns the gate on and names the judge. `null` means
today's behavior. There is no separate on/off flag, so "on with no model"
and "a model but off" cannot happen.

Thread it: `safeBash` → `runApproved` → `approvedPlan(command, dir,
timeoutMs, jobMs, commandJudge)`, and `startJob` → `startShellJob` →
`approvedPlan`. `std::jobs.start` (`stdlib/jobs.agency:190`) calls
`startShellJob` from code and keeps passing nothing, so programs that
start jobs directly are unchanged.

`SafeBashEffects` (line 6007) does not change. The judge raises no
effect, so no policy, effect set, or `raises` clause changes.

## 3. The gate and the judge call

### The gate

```ts
type JudgeOutcome = "skipped" | "rejected" | "passed" | "unavailable"

type GateResult = {
  outcome: JudgeOutcome;
  verdict: Verdict
}

def judgeGate(command: string, reason: BroadReason, dir: string, limitMs: number, background: boolean, judge: CommandJudge): GateResult {
  """
  Decide whether a broad line is asked or refused. Only a confident judge
  refuses; a rule that decides the question, a doubtful answer, and a
  failed call all ask.
  """
  const question = bashQuestion(command, dir, limitMs, background)
  const decided = checkPolicy(currentPolicy(), question)
  if (decided.type != "propagate") {
    return { outcome: "skipped", verdict: "fine" }
  }
  const asked = try askJudge(command, reason, judge)
  if (isFailure(asked)) {
    return { outcome: "unavailable", verdict: "fine" }
  }
  if (asked.value.verdict != "fine" && asked.value.confidence >= JUDGE_MIN_CONFIDENCE) {
    return { outcome: "rejected", verdict: asked.value.verdict }
  }
  return { outcome: "passed", verdict: asked.value.verdict }
}
```

In `approvedPlan`, after `toRaise` is computed:

```ts
const reason = toRaise.broadReason
if (commandJudge != null && reason != null) {
  const gate = judgeGate(command, reason, dir, limitMs, asJob, commandJudge)
  _debug("safeBash judge", { command: command, outcome: gate.outcome, verdict: gate.verdict })
  if (gate.outcome == "rejected") {
    return failure(judgeRejection(gate.verdict))
  }
}
const raised = raiseAll(toRaise.effects, command, dir, limitMs, asJob)
```

The exact shape `checkPolicy` returns (`.type`, or a response value) is
to be checked against `stdlib/policy.agency:308` while building.

### The policy pre-check

Judging a line the user already approved would only add friction, and it
could reject a command the user deliberately allowed. `std::bash` is
declared `@always(command, cwd)` (`stdlib/shell.agency:58`), so an
"always approve" answer saves a rule for that exact command in that
folder. The pre-check keeps the judge off those lines.

- **One builder for the question.** Move the `std::bash` arm's message
  and payload out of `raiseOne` (line 6463) into
  `bashQuestion(command, cwd, timeoutMs, background)`. It returns the
  whole interrupt `checkPolicy` takes: `effect`, `message` (with the
  `" in the background"` wording for a job), `data` (`command`, `cwd`,
  `timeout`, `stdin: ""`), and `origin`. `raiseOne` raises from the same
  builder. A rule can match on `message` and `origin` as well as on data
  (`lib/runtime/policy.ts:234-235`), so a pre-check built separately could
  give a different answer from the raise. A job passes its job limit as
  `timeoutMs`, as `raiseAll` does, so a rule that names `timeout` gives
  the same answer too. The compiler injects `origin`. Confirm the exact
  string safeBash's raises carry with a probe, and keep it in one
  constant.
- **What it can see.** `currentPolicy()` (`stdlib/policy.agency:1541`)
  returns the policy of the `cliPolicyHandler` this program installed, or
  an empty policy when there is none. The agency agent installs one, so
  its saved rules, including rules saved earlier in the session, count.
  It cannot see approvals given any other way: a TypeScript host or a
  served agent that answers interrupts itself, a session front-end that
  keeps the policy outside the Agency code, a `handle` block or
  `with approve` around the agent, or a parent process that answers for a
  subprocess. For those, the pre-check returns `propagate`, and the judge
  runs on a line that would not have prompted. Confirm whether
  `agency agent`'s `--approve` and `--reject` flags reach the policy
  `cliPolicyHandler` holds. If they do not, add them to this list.
- **It can read and save the policy file.** The first call to
  `currentPolicy()` loads the policy file, and any call can save
  "always" answers that are waiting to be written (`maybeLoadPolicy` and
  `maybeFlush`, lines 557 and 586). Those raise `std::read` and
  `std::write` under the handler's own-I/O marker. The CLI handler skips
  its own raises; other handlers in the chain hear them. The agent's
  `lib/agents/agency-agent/lib/terminal.agency:52` already calls
  `currentPolicy()` this way. A test (§6, case 5) checks that the user is
  asked nothing extra.
- **Which way an error goes.** A wrong `skipped` sends the line to
  `raiseAll`, which is today's behavior. A wrong `propagate` judges a line
  that would not have prompted, which is the friction described above.
  Neither direction can run anything without its question being answered.

### The judge call

The judge follows the router's pattern
(`stdlib/agents/brains/coordinator/router.agency`): a fresh `thread`
holding only the input, one `llm()` call with `type: "decision"`,
`retries: 0`, and a short timeout, then `lastReply()` to read the
answer's confidence. A decision model answers with a label from a literal
union. It refuses a field that is a plain `string`
(`docs/dev/llm/decision-models.md`, "From a type to questions"), so the
answer is a union.

```ts
type Verdict = "fine" | "useSimplerCommands" | "tooLongToReview"

type JudgeCall = {
  verdict: Verdict;
  confidence: number
}

// A judge call that takes longer than this fails, and the line is asked.
static const JUDGE_TIMEOUT = 3s

// A starting value, set above the router's measured 0.7 because a wrong
// rejection costs the agent a rewrite. Tune it from the "safeBash judge"
// events (§5); do not change it without measuring.
static const JUDGE_MIN_CONFIDENCE = 0.9

// The sentences the rejection message is built from. The judge answers
// with a label, and the label's words are ours.
static const VERDICT_SENTENCES = {
  useSimplerCommands: "it runs a script through awk, perl, sed, or an interpreter where plain commands would do",
  tooLongToReview: "it is too long or dense for a person to check at a glance"
}

// The question, built per call because it names why the line went broad.
def judgeQuestion(reason: BroadReason): string {
  return "${JUDGE_QUESTION}\n\nWhy safeBash could not describe it: ${broadExplanation(reason)}"
}

// One decision call on a fresh thread that holds only the command. An
// answer with no confidence is no rejection: it stays "fine", as the
// router treats a pick with no confidence as no pick.
def askJudge(command: string, reason: BroadReason, judge: CommandJudge): JudgeCall {
  let out: JudgeCall = { verdict: "fine", confidence: 0 }
  thread(label: "bash-judge") {
    userMessage(command)
    const verdict: Verdict = llm(judgeQuestion(reason), {
      ...judgeOptions(judge),
      type: "decision",
      retries: 0,
      timeout: JUDGE_TIMEOUT
    })
    const reply = lastReply()
    if (reply != null && reply.answers != null) {
      const answer = reply.answers["answer"]
      if (answer.type == "choice" && answer.confidence != null) {
        out = { verdict: verdict, confidence: answer.confidence }
      }
    }
  }
  return out
}
```

`judgeOptions(judge)` returns `{ model, provider }`, leaving out an empty
provider, as `modelOptions` does in `std::agents/brains/settings`. It is
written in `std::safeBash` so the core module does not import an agents
module. `JUDGE_QUESTION` states the rubric below in two or three
sentences.

Design points, each with its reason:

- **A fresh thread.** safeBash runs as a tool inside the agent's own
  conversation. A bare `llm()` call would send that conversation to the
  judge, and the judge's provider may not be the one the agent uses
  (decision-models.md warns about this near line 205). The thread holds
  only the command, so the question is the only other thing the judge
  sees.
- **The question judges two failure modes only:** (a) the line uses awk,
  perl, sed, or `python3 -c` where plain commands or the agent's other
  tools would do; (b) the line is too long or dense for a person to check
  at a glance. The question includes `broadExplanation(reason)`
  (line 6337), so the judge knows why safeBash could not describe the
  line. The judge can only answer with one of the three labels.
- **It may only reject.** The gate refuses only on a label other than
  `fine` with confidence at or above `JUDGE_MIN_CONFIDENCE`. No branch
  turns the judge's answer into an approval. A doubtful, missing, or
  failed answer asks.
- **A failure means "ask", and only a failure.** The call is wrapped in
  `try`, as `pickRoute` wraps `askRouter`. An error becomes a failure,
  which the gate reads as `unavailable`, logs, and then asks as today. A
  cancel passes through `try` and stops the run as it does today. A cost
  guard that trips during the call must also stop the run, and must not
  be read as `unavailable`. Before building, probe both cases with the
  throwaway-probe method from
  `packages/agency-lang/2026-11-21-handoff-safebash.md`: what a failed
  `llm()` call does inside `try` (a failure, or a throw), and what a guard
  trip does there.
- **The judge does not see the task.** It cannot always tell "scripting
  that is the task" from "scripting out of habit", so it may reject a
  legitimate interpreter use. The judge tends to give a similar line the
  same answer, so a rewrite may be rejected again, and a wrong rejection
  can cost more than one round trip. The rejection message gives the agent a way out that the
  gate never judges: write the script to a file and run the file. Adding
  the task to the judge's input would change safeBash's signature again,
  which is not worth it in v1. Tune the rubric from the log data instead.
- **The tool description does not change.** The `.describe(...)` text on
  the agent's `bash` tool stays as it is. The rejection message teaches
  the model the first time it happens. A sentence in every tool
  description would cost every request.
- **The rejection message** follows the refuse wall's style, with the
  reason taken from `VERDICT_SENTENCES`:

  > `This command is too complex to review safely: <the verdict's
  > sentence>. Write simpler commands that do the same thing, or write the
  > script to a file and run the file.`

  `judgeRejection(verdict)` builds it, and `approvedPlan` returns it as a
  plain `failure(...)`, like the refuse wall. It is not a rejected
  interrupt, so the `rejected`-flag pass-through for `raiseAll`
  rejections does not apply.

### Effects and capabilities

`llm()` raises no interrupt. It needs the host's `llm` capability, which
Node hosts always have, and `llm` is deliberately left out of the
`--check-capabilities` check (`docs/dev/language/capabilities.md`: "a
model call is made by `llm()`, which is not a function a tag can sit
on"). The pre-check's file reads are covered above. So `SafeBashEffects`,
the effect sets, and every policy need no changes, and `recommended`
needs no new rule.

### Latency and cost

For the agency agent, whose policy the pre-check can see, the judge runs
only on broad lines no rule decides: lines that would stop and wait for a
person. One decision call with a 3-second limit is cheap next to a prompt
the user has to answer. For the hosts listed in the pre-check, it also
runs on lines another handler would have approved. Narrow and in-process
lines never pay for it.

### Checkpoints, resume, and tampering

- **Where the verdict lives.** `gate` is a local `const` in
  `approvedPlan`, so it is saved in that frame's state in the checkpoint.
- **Resume does not judge again.** When a passed line's `std::bash`
  question goes to a person and the run resumes, the step counter skips
  the statements that already finished, including the `judgeGate` call.
  Keep the call in a statement of its own, the property
  `docs/dev/compiler/hoist-calls.md` describes. §6 has a test.
- **Tampering gains nothing.** Someone who edits the saved verdict in a
  checkpoint can only turn a rejection into a pass. A pass leads to the
  ordinary `std::bash` question, which still has to be answered. The judge
  never approves, so there is no approval to forge.
- **Handlers are untouched.** The gate registers no handler and removes
  none. Every question it does not remove goes through the same handler
  chain as today.

## 4. Wiring it into the agents

`commandJudge` comes from a new model slot, in the same way as the router
model. The slots are in `lib/agents/agency-agent/lib/slots.agency:6`
(`["main", "reasoning", "embedding", "router"]`). Add `"judge"`, so a
preset, `/model`, and the command-line flags can set it the way they set
`router`. An empty slot means no judge, and every broad line asks as
today. There is no built-in default model: a default would send command
lines to a provider the user never chose. Command lines carry paths,
hostnames, and sometimes secrets.

From the slot to the tools:

1. **`AgentSettings`** (`stdlib/agents/brains/settings.agency`) gains
   `judgeModel` and `judgeProvider` beside `routerModel` and
   `routerProvider`. `cliSettings()` in
   `lib/agents/agency-agent/lib/answer.agency` fills them from the slot,
   and `agencyAgent` in `stdlib/agents/agency.agency` gains the matching
   parameters, as it has `routerModel`. Every place that builds an
   `AgentSettings` record, tests included, gains the two fields.
2. **The toolkits** take the judge as an argument. In
   `stdlib/agents/lib/toolkits.agency`:

   ```ts
   def modelSafeBash(commandJudge: CommandJudge | null): any {
     return safeBash.partial(exitIsFailure: false, commandJudge: commandJudge)
   }

   export def jobTools(commandJudge: CommandJudge | null = null): any[] {
     return [startJob.partial(commandJudge: commandJudge), jobOutput, stopJob]
   }
   ```

   `bashTool`, `shellTools`, and `codingFileAndShellTools` gain the same
   parameter, defaulting to `null`, and pass it to `modelSafeBash`.
   Binding it with `.partial()` takes it out of the tool's schema, so the
   model cannot see or change it. That follows the file's existing
   pattern: `useAgentCwd`, `respectGitignore`, `refresh: false`, and
   `exitIsFailure`.
3. **The coder.** `runCoder` in
   `stdlib/agents/brains/coordinator/code.agency` passes
   `commandJudge: judgeOf(settings)` to `codingAgent`. `codingAgent` and
   its `solve` and `buildTools` gain the parameter and pass it to
   `codingFileAndShellTools`. `codingAgent` is also offered as a tool in
   some places. A model that cleared the parameter there would only
   restore today's behavior, but bind it with `.partial()` wherever
   `codingAgent` is offered as a tool, to keep the harness in charge.
4. **The minimal brain** (`stdlib/agents/brains/minimal.agency:31`) calls
   `codingFileAndShellTools(judgeOf(settings))`.
5. **Jobs.** `sessionJobTools()` in
   `lib/agents/agency-agent/lib/cliTools.agency` reads the judge slot and
   calls `jobTools(judge)`. Both places that offer job tools use it: the
   coordinator's tools (`jobAndSpillTools`) and the coder's tools
   (`cliSettings().coderTools`).

`judgeOf(settings)` returns `null` when `judgeModel` is empty, and
otherwise `{ model: settings.judgeModel, provider: settings.judgeProvider }`.

Agents that run without the agency agent's settings, such as the
standalone `std::agents/coding`, the planner, and both verifiers, pass
nothing, so they keep today's behavior. They can gain a judge the day one
of them needs it. §8 question 1 asks the owner to confirm this scope.

## 5. Observability

safeBash already logs `_debug("safeBash plan", planRecord(...))` before
anything happens. The gate adds a sibling event:

```ts
_debug("safeBash judge", { command: command, outcome: gate.outcome, verdict: gate.verdict })
```

`skipped` means the policy pre-check found a rule that decides the
question. `rejected`, `passed`, and `unavailable` are the judge's.

This event is the only record of why a broad line did or did not prompt.
The usual way to measure safeBash is to replay logged lines through
`planFor`. Once the judge exists, a replay no longer predicts a session:
the verdict cannot be derived from the plan, and two sessions with the
same command can differ, one prompting and one rejected. Because the judge
may only reject, that difference costs at most extra rewrites, never an
unsafe action.

After some agent sessions, count `safeBash judge` events next to the
`safeBash plan` events in `~/.agency-agent/perry-log.jsonl`. That shows
how many broad lines the gate removes from the prompt queue, and how
often it rejects wrongly. A rejection the agent answers with a command
that does prompt is a likely false positive. The same events are the data
for tuning `JUDGE_MIN_CONFIDENCE`.

## 6. Tests

Agency execution tests are `tests/agency/<name>.agency` plus
`<name>.test.json`, with exact-match expected output. In deterministic LLM
mode (`AGENCY_USE_TEST_LLM_PROVIDER=1`, which CI runs), each `llm()` call
takes the next entry of `llmMocks` (`docs/misc/TESTING.md`,
"Deterministic LLM mode"). A decision call takes only a `{ decide: {...} }`
entry. Given a `{ "return": ... }` entry, the client throws
(`lib/runtime/deterministicClient.ts:432-434`). The judge's mocks use the
form in `tests/agency/last-reply.test.json`:

```json
{ "decide": { "answer": { "type": "choice", "choice": "useSimplerCommands", "confidence": 0.95,
  "probabilities": { "fine": 0.03, "useSimplerCommands": 0.95, "tooLongToReview": 0.02 } } } }
```

A new file, `tests/agency/safeBashJudge.agency`, with its `.test.json`,
has two kinds of case:

- **Gate cases** call `judgeGate` directly, through
  `import test { judgeGate } from "std::safeBash"`, and print its
  `outcome` and `verdict`. A gate that fails open turns most mistakes into
  an ordinary `std::bash` question, so only the printed outcome can tell
  `passed` from `unavailable`.
- **End-to-end cases** call `safeBash` or `startJob` under a recording
  handler, in the pattern at `tests/agency/safeBash.agency:988`, and print
  the tool's result and the effects that were raised.

Every case that expects the judge to run passes a judge, for example
`commandJudge: { model: "jev-1.13", provider: "typesafe" }`. With `null`,
no call happens.

1. **Judge rejects (end to end).** `safeBash("python3 -c '<long script>'",
   commandJudge: judge)`, with a `useSimplerCommands` mock at confidence
   0.95. Expect a failure with the judge's message, and no `std::bash`
   raised.
2. **Judge passes (gate).** A `fine` mock. Expect outcome `passed`.
3. **No judge (end to end).** `commandJudge` left `null`, and no mock.
   Expect the `std::bash` question as today, which pins that the default
   changes nothing.
4. **Judge fails (gate).** No mock entry, so the client throws "no mock
   provided". Expect outcome `unavailable`. The throw-or-failure probe in
   §3 decides whether `try` catches this as written.
5. **A rule decides, so no judge (gate and end to end).** Call
   `cliPolicyHandler` with a policy file in a throwaway directory, with
   `HOME` also pointed at a throwaway directory, holding an
   `@always(command, cwd)` rule for the line: the rule an "always approve"
   answer saves. Give no judge mock. Expect outcome `skipped`, and end to
   end expect the rule to answer the question and no other question to be
   raised. Add one rule that names `origin` and one that names `message`,
   to check that `bashQuestion` builds the same interrupt as the raise.
   The recording handler on its own cannot test this, because the gate
   reads `currentPolicy()`, which is empty without `cliPolicyHandler`.
6. **A doubtful answer asks (gate).** A `useSimplerCommands` mock at
   confidence 0.6. Expect outcome `passed` with verdict
   `useSimplerCommands`.
7. **No confidence means no rejection (gate).** A mock with no
   `confidence`. Expect outcome `passed`, which pins `askJudge`'s rule.
8. **`exitIsFailure: false` keeps a rejection a failure (end to end).**
   The agent binds `exitIsFailure: false`, and `safeBash` turns only
   `EXIT_FAILURE` failures into successes. Call with both settings and a
   reject mock, and expect a failure.
9. **A job line that is broad only as a job (end to end).**
   `startJob("cd app && npm ci && npm run build", commandJudge: judge)`,
   which `asJobPlan` re-plans as broad, with a reject mock. Expect a
   failure, no `std::bash` raised, and no job started. Its gate case
   checks that the pre-check's question carries the job's limit and the
   "in the background" wording.
10. **Resume does not judge again (end to end).** A `fine` mock and
    exactly one mock entry. The `std::bash` question goes unanswered, so
    the run pauses, and the test then resumes it with an approval. The
    gate case alone cannot catch a second judge call, because a second
    call would fail open. So this test prints the number of
    `safeBash judge` events, or the number of `llm()` calls, and expects 1.

The existing exact-match expectations in `tests/agency/safeBash.test.json`
already pin that `planFor` and `outcomeOf` do not change. Rubric quality
is not tested with mocks: the mock decides the outcome. It belongs in a
later eval with a real judge model, and in the log measurement in §5.

Run only the new file:
`agency test tests/agency/safeBashJudge.agency --check-capabilities`,
with the flag after the path and the output saved to a file. Also run the
agent's tool-wiring test (`lib/agents/agency-agent/tests/toolWiring.agency`),
because `jobTools` and `sessionJobTools` change.

## 7. Documentation

`docs/dev/stdlib/safe-bash.md`: a short section after "Why a plan went
broad" that states the rule. With `commandJudge` set, a broad plan
(`broadReason != null`) is checked before anything is asked. A line a
rule in the CLI handler's policy decides is not judged. The judge may only
reject, and only when confident. A failed or doubtful judge asks anyway.
It also lists the approvals the pre-check cannot see.

## 8. Open questions for the owner

1. **Which agents get a judge in v1.** Recommended: the agency agent only
   (its coordinator, coder, minimal brain, and job tools), because only
   it has a model slot to set. Standalone stdlib agents and the verifiers
   keep `null` until one of them needs a judge.
2. **Jobs.** Recommended: judge job lines in v1, as §4 step 5 wires. That
   includes lines that are broad only because they run as a job.
3. **A length cutoff.** Should very short broad lines skip the judge? A
   cutoff saves a call but adds a magic number, and the rubric already
   handles short lines. Default: no cutoff in v1.
4. **Which model goes in the judge slot.** A decision model such as
   `openrouter/jev-1.13` (needs `OPENROUTER_API_KEY`) or a local Laya
   checkpoint. Nothing is set by default. Should the docs recommend the
   local Laya model, so command lines stay on the machine?

## 9. What the reviews changed

Architecture review, 2026-11-22, on the first draft:

1. §1 states that the plan layer gains no outcome kind, and adds the
   concurrency note.
2. §3 states that the tool description does not change and that the
   judge does not see the task.
3. §4 named the binding point as an owner question.
4. §5 states that a replay through `planFor` no longer predicts a session,
   and §6 adds the `exitIsFailure: false` case.

First plan review, with the owner's decisions:

5. The judge runs only when no policy rule decides the question.
6. The judge is a decision-model call in the router's pattern, answering
   with a `Verdict` label, with confidence deciding a rejection.

Second plan review:

7. One parameter, `commandJudge: CommandJudge | null`, replaces the
   boolean flag and the separate model fields, on all three functions.
   `CommandJudge` is defined in `std::safeBash`, and so is
   `judgeOptions`, so the core module imports no agents module.
8. The fallback of a built-in judge model is gone. The judge comes from a
   new `judge` model slot, wired through `AgentSettings`, the coder, the
   minimal brain, and `jobTools(judge)` (§4).
9. The pre-check builds its question with `bashQuestion`, the same
   builder `raiseOne` uses, so `message`, `origin`, and a job's limit and
   wording match the raise. §3 states what the pre-check cannot see, and
   that `currentPolicy()` can read and save the policy file.
10. `askJudge` takes the `BroadReason` and builds its question per call.
    Its comment now matches its code: no confidence means no rejection.
    `JUDGE_MIN_CONFIDENCE` starts at 0.9 and `JUDGE_TIMEOUT` at 3 seconds.
11. §1 names the exact condition for "broad" and why a handler is the
    wrong tool. §3 adds checkpoints, resume, and tampering.
12. §6 uses `{ decide }` mocks, gives every judged case a judge, tests the
    gate directly with `import test`, and adds the cases for policy rules
    through `cliPolicyHandler`, low confidence, no confidence, a job, and
    resume.
13. The CHANGELOG step is gone, and the line numbers are corrected.

## 10. Effort

About two to three days. The safeBash changes are small: the parameter on
three functions, `bashQuestion` taken out of `raiseOne`, `judgeGate`,
`askJudge`, and the call in `approvedPlan`. The wiring touches more files
than the first estimate assumed: the `judge` slot, `AgentSettings` and
every place that builds one, `agencyAgent`, the toolkits, `codingAgent`,
the minimal brain, and `cliTools`. The test file is the largest single
piece. The two probes in §3 come first, because their answers decide how
the `try` in `judgeGate` is written.

## 11. What the build settled and changed

- **The open checks in §3.** The origin is `std::safeBash`
  (`moduleIdToOrigin` in `lib/runtime/origin.ts`), pinned by the
  `gateMatchesOrigin` test. `checkPolicy` returns `{ type }`. A failed
  decision call inside `try` is a failure, as the router already relied
  on, pinned by the `gateUnavailable` test.
- **`shellTools()` takes no judge.** Its only callers are the two
  verifiers, which have no settings to pass, so it binds `null`. It can
  take the parameter the day a caller has a judge to give it.
- **The startup header shows a `Judge` line** when the slot is set, as it
  shows the router, so a user can see that command lines go to a judge.
- **A local session has no judge.** The local setup sets only the main,
  reasoning, embedding, and router slots. Carrying the judge there would
  widen the local-model request types for a case nobody has asked for yet.
- **The test lines.** A single unknown command such as `python3 -c pass`
  is narrow (it asks `std::exec`), so the broad test line is a pipe into
  awk, and the job line is two `python3` steps after a `cd`. A guard case
  (`linesFitTheirTests`) fails first if planning changes under them.
- **Resume.** The deterministic client keeps its mock counter across a
  resume in the same process, checked with a throwaway probe. So the
  resume test's second, refusing mock would be taken by a judge that ran
  again, and the test would fail.
