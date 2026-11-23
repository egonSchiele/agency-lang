# Review: `rejectComplexCommands` plan (second pass)

Re-reviewed 2026-11-22 against the revised plan, which now checks the
approval policy before judging and makes the judge a decision-model call.
Checked against `stdlib/safeBash.agency`, `stdlib/policy.agency`,
`lib/runtime/policy.ts`, `stdlib/agents/brains/coordinator/router.agency`,
`stdlib/agents/brains/settings.agency`, `stdlib/agents/lib/toolkits.agency`,
`lib/runtime/deterministicClient.ts`, and `tests/agency/last-reply.test.json`.

## Verdict

Both revisions go the right way. Copying the router's pattern is right:
a fresh thread, a `type: "decision"` call, no retries, a short timeout,
and confidence read through `lastReply()`. Answering with a literal union
whose sentences are written in safeBash is right too. The policy
pre-check fixes the main problem from the first pass for the agency
agent, which uses `cliPolicyHandler`.

The revision has created new problems, though. The tests as written
cannot pass, because a decision call refuses a `{ "return": ... }` mock
(finding 1). §3 and §4 disagree about whether the gate is on at all
(finding 2). The fallback of a fixed judge model would send command lines
to a third party nobody chose (finding 3). The policy pre-check sees less
than the plan says (finding 4). Each needs a small fix in the plan before
building.

## New findings, most important first

### 1. A decision call refuses the test mocks in §6

The deterministic client gives a decision call its answer only from a
`{ decide: {...} }` entry. Given a `{ "return": ... }` entry, it throws
`llm() call #N is a decision call but the mock is not a { decide: {...} } entry`
(`lib/runtime/deterministicClient.ts:432-434`). Tests 1, 2, and 7 use
`{ "return": "useSimplerCommands" }` and `{ "return": "fine" }`.

Because the gate fails open, that throw becomes outcome `unavailable`, and
the line goes on to ask `std::bash`. So test 1 fails where it expects a
rejection. Test 2 still sees the `std::bash` question but prints
`unavailable` where it expects `passed`. The outcome line that the first
review asked for is what catches this. Without it, test 2 would have
passed for the wrong reason.

Write the mocks in the form `tests/agency/last-reply.test.json` uses:

```json
{ "decide": { "answer": { "type": "choice", "choice": "useSimplerCommands", "confidence": 0.95,
  "probabilities": { "fine": 0.03, "useSimplerCommands": 0.95, "tooLongToReview": 0.02 } } } }
```

That form also carries a confidence, so test 6 ("a doubtful answer asks")
can be written now. The client can serve a low-confidence answer. Drop
that case's "waits for the post-merge LLM suite" clause.

Each test must also give the judge a model. Under §3, an empty model
means the gate is off, and then no call happens at all (see finding 2).

### 2. §3 says an empty model turns the gate off; §4 binds the flag with no model

§3 says that empty `judgeModel` / `judgeProvider` mean "the gate stays
off." The code in §4 binds `rejectComplexCommands: true` in
`modelSafeBash()` and passes no model, so under §3's rule the gate is off
for every agent. §2's signature still lists only the boolean. Yet
`askJudge` takes `judgeModel` and `judgeProvider`, and §4 says the pair
reaches the gate "as `.partial()` arguments on the bash and job tools."
So safeBash, `startJob`, and `startShellJob` each gain at least two more
public parameters that §2 does not show. That is the public surface the
architecture review removed, which §9 revision 2 still records.

Also, having two switches for one thing invites a state that means
nothing: the flag on with no model, or a model set with the flag off.
Replace both with one parameter of the existing `ModelChoice` type
(`stdlib/agents/brains/settings.agency:29`):

```ts
export def safeBash(
  command: string,
  cwd: string = "",
  timeout: number = 120,
  exitIsFailure: boolean = true,
  complexityJudge: ModelChoice | null = null,
): Result<string> raises <SafeBashEffects>
```

`null` keeps today's behavior. A model turns the gate on and names the
judge in the same argument. Then update §2, §4's code, the tests, and the
dev-doc wording to match.

The wiring is also bigger than §10 says. `codingFileAndShellTools()`,
`shellTools()`, and `jobTools()` take no arguments, so getting a model
from `AgentSettings` into them changes their signatures and every caller:
`coding.agency`, `minimal.agency`, `verifier.agency`, and the coordinator.
"Toolkits wiring is one `.partial()` argument" is no longer true. Update
the effort estimate.

### 3. Drop the fallback of a fixed judge model

§3 and §8 question 4 offer, as a fallback, to "bind a fixed decision
model in `modelSafeBash()` and rely on fail-open when its key is absent."
With `openrouter/jev-1.13` bound in the stdlib, any user who happens to
have `OPENROUTER_API_KEY` set would have every broad command line sent to
OpenRouter and TypeSafe. Nobody would have chosen that. Command lines
carry paths, hostnames, and sometimes secrets. `docs/dev/llm/decision-models.md`
(around line 205) already warns that a decision call can send data to a
different provider from the one that ran everything else. Users without
the key pay a failed call on every broad line. Keep the gate off unless
the user configures a judge model, and remove the fallback from §3 and
§8.

### 4. The policy pre-check sees only `cliPolicyHandler`'s policy

`currentPolicy()` returns the CLI handler's policy, "or an empty one when
none is loaded" (`stdlib/policy.agency:1534-1549`). The agency agent calls
`cliPolicyHandler`, so the pre-check works there. Anything that approves
`std::bash` in another way is invisible to it, and the judge then runs on
a line that would never have prompted:

- a TypeScript host or a served agent that answers interrupts itself;
- a session-core front-end that holds the policy outside the Agency code;
- a `handle` block or `with approve` around the agent;
- a subprocess child, whose parent's handlers answer for it.

That is the same problem the first review raised, reduced to these
hosts. Say in §3 and in the dev doc that "skipped" covers rules in the
CLI handler's policy only.

Two smaller corrections in the same bullet:

- **`currentPolicy()` is not a pure read.** The first call loads the
  policy file, and any call can save pending "always" answers to it
  (`maybeLoadPolicy` and `maybeFlush`, lines 557 and 586). Both raise
  `std::read` and `std::write` under the handler's own-I/O marker. The
  CLI handler skips its own raises, but other handlers in the chain hear
  them. So §1's "a read of policy data, not a raise" and §3's "raises
  nothing of its own" are wrong as written. The agent's `terminal.agency`
  already calls `currentPolicy()` this way, so it is probably acceptable.
  But state it, and check that it adds nothing to the questions the user
  sees.
- **Pass the whole interrupt to `checkPolicy`.** A rule can match on
  `message` and `origin` as well as on data (`lib/runtime/policy.ts:234-235`).
  The plan passes `{ effect, data }`. Pass the same message and origin the
  real raise carries, so a rule that names either field gives the same
  answer in the pre-check as at the raise.

### 5. Test 5 cannot work with the recording-handler pattern

The recording handler at `tests/agency/safeBash.agency:988` checks a
policy held in the test's own variable. The gate reads `currentPolicy()`,
which is empty unless the test called `cliPolicyHandler`. So under that
pattern, the policy-approved line still reaches the judge and never reads
`skipped`. Test 5 has to call `cliPolicyHandler` with a policy file. That
reads and writes files, so put the file and `HOME` in a throwaway
directory.

### 6. The `askJudge` comment says the opposite of what its code does

The comment says an answer with no confidence "is taken at its word", and
test 1 says "the label is taken as confident." The code does the
opposite. `out` starts as `fine` and changes only when a confidence is
present, so an answer with no confidence never rejects. The code is the
right behavior for a gate that may only reject, and it matches the
router's rule ("A pick with no confidence is no pick"). Keep the code,
and fix the comment and test 1's wording.

### 7. The question cannot carry the `BroadReason`

§3 says to include the `BroadReason` detail in `QUESTION`. But `QUESTION`
is a constant, and `askJudge(command, judgeModel, judgeProvider)` is never
given the reason. Pass the reason in, and build the question per call the
way `routeQuestion` does:

```ts
def askJudge(command: string, reason: BroadReason, judge: ModelChoice): JudgeCall
```

### 8. Name the confidence threshold and the timeout, and say how they are chosen

`JUDGE_MIN_CONFIDENCE` and `JUDGE_TIMEOUT` have no values. The router's
0.7 was measured on 60 logged turns, and its comment says not to change
it without measuring again. A gate that may only reject should start
higher. Name starting values, for example 0.9 and the router's 3 seconds,
and say they will be tuned from the `safeBash judge` events §5 records.

### 9. Smaller points

- `modelOptions` lives in `std::agents/brains/settings`. Importing it into
  `std::safeBash` makes a core module depend on an agents module. It
  creates no import cycle, since `settings.agency` imports nothing. Copy
  the six-line helper, or move it to a neutral module.
- The JSON in finding 1 is the shape of the `decide` mock. The exact
  probabilities do not matter, as long as the deterministic client's
  answer check accepts them.

## Status of the first review's findings

| # | Finding | Status |
| --- | --- | --- |
| 1 | The judge runs on lines the user approved | Fixed for the CLI handler's policy. See finding 4 for the hosts it does not cover. |
| 2 | Answer type cannot go to a decision model | Fixed: a literal union with sentences written in safeBash. |
| 3 | `startJob` not bound in `jobTools()` | Partly fixed. §2 adds the parameter, but §4's code still binds only `modelSafeBash()`, and `jobTools()` still returns `startJob` with nothing bound. |
| 4 | Failing open hides test failures | Fixed: each test prints the gate's outcome. Test 7 now says it checks the plumbing, not the rubric. |
| 5 | Checkpoints, resume, tampering | Partly fixed. A resume test was added. There is still no sentence saying where the verdict is saved, or why editing it in a checkpoint gains nothing. |
| 6 | Why a parameter and not a handler | Partly fixed. The do-not-retry reason is now in §3. The other reason, that a handler cannot see the `BroadReason`, is missing. |
| 7 | Name the test for "broad" | Open. Write `toRaise.broadReason != null` into §1. |
| 8 | A rejection can repeat | Mostly fixed: the message now suggests writing the script to a file. §3 still says a wrong rejection costs "one rewrite round-trip", which is not guaranteed. |
| 9 | CHANGELOG, `toolHint`, temperature, line numbers | The `toolHint` and temperature points no longer apply. §7 still has the CHANGELOG entry: remove it. §1 still says `startShellJob` is at line 6277: it starts at 6271, and its call to `approvedPlan` is at line 6295. |
