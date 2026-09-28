# Eval input format cleanup: tests describe the task, not the agent

**Status:** draft for review
**Scope:** one PR. The command-agent feature (`--agent-cmd`, running `agency agent` under eval) is a separate spec that builds on this one.

## Background: what an eval input is today

An eval suite is a list of inputs. Each input is one test case: the framework
runs the agent once per input in an isolated working directory, and graders
score what the run left behind. Today an input looks like this (the type is
`Input` in `lib/eval/runTypes.ts`):

```json
{
  "id": "regex-log",
  "goal": "regex.txt matches the last date on lines with a valid IPv4 address",
  "node": "main",
  "args": { "task": "Write a regex expression that matches dates ..." },
  "expected": null,
  "files": "./files"
}
```

The fields split into two groups.

Fields that describe the test:

- `id` — names the input; becomes the run subdirectory name.
- `goal` — the success criterion. Grading-facing only: the bundled LLM judge
  scores the agent's output against it, `judgeSuite` uses it as the pairwise
  criterion, and the optimizer treats it as the objective. The agent never
  sees it.
- `expected` — optional gold answer, read by match graders and shown to the
  optimizer's reflection step.
- `files` — a fixture directory seeded into the working directory.
- `metadata` — free-form extra data for graders.

Fields that describe the agent:

- `node` — which entry node to invoke. This is a claim about the agent's
  internal structure: a test that says `"node": "check"` only works against
  agents that happen to have a node named `check`.
- `args` — a record of named arguments, keyed by the agent's parameter names.
  A test that says `"args": {"task": ...}` has silently decided that every
  agent it will ever run against takes a parameter called `task`.

## The problem

The second group is a conflict of interest. A test should define **what the
input is**; the person running the eval should define **how that input gets
to their agent**. When the test file carries `node` and `args`, the suite is
coupled to one agent's shape, and pointing the same suite at a differently
shaped agent means editing every test file — exactly backwards, since the
whole point of the suite/agent split (and of the seeding rule that forbids
tests from shipping agent files) is that one suite grades any agent.

Harbor (the harness terminal-bench runs on) draws this line correctly: a task
carries a single instruction, and each agent adapter decides where that
instruction goes — a flag, stdin, an environment variable. The task never
knows.

We hit this concretely while porting terminal-bench's regex-log task: the
instruction ended up duplicated (`goal` for grading, `args.task` for the
agent) purely because the input format had no agent-agnostic place to put
"what the agent is told."

## The new shape

One field replaces both: `task` — what the agent is told. It may be a string
(the common case: an instruction) or a JSON object (structured input for
agents that take data rather than prose). **Every input must define one** —
a test that tells the agent nothing isn't a test, and requiring it keeps
every downstream contract two-state instead of three (see the IPC section).
`node` and `args` are deleted.

```json
{
  "id": "regex-log",
  "task": "Write a regex expression that matches dates ...",
  "goal": "regex.txt matches the last date on lines with a valid IPv4 address"
}
```

```json
{
  "id": "classify-solar",
  "task": { "text": "The panel array produced 4.1 kWh", "categories": ["energy", "weather"] },
  "expected": "energy"
}
```

The full input vocabulary after this change: `id`, `task`, `goal`,
`expected`, `files`, `metadata`. Nothing in it refers to the agent.

## How the task reaches a native agent

The agent side of the line is the `--agent` flag, which already picks the
file and the node (`--agent foo.agency:main`, node defaulting to `main`).
The delivery convention is:

**The entry node takes exactly one parameter, and the task arrives as that
parameter — positionally, whatever the parameter is named.**

This works because compiled modules export a `__<node>NodeParams` list and
the subprocess bootstrap (`lib/runtime/subprocess-bootstrap.ts:82-117`)
already maps named args to positional order through it. Eval runs switch to
sending the task value itself; the bootstrap places it by position:

Since every input has a task, the convention is one sentence: **an eval
entry node takes exactly one parameter.** The parameter count is checked
before the node runs — a mismatch is an error, never a silent drop:

| node parameters | result |
|---|---|
| 1 | the node is called with the task value |
| 0 | **error**: "eval delivers the input's task as the node's parameter, but node `main` takes none" |
| 2+ | **error**: "eval entry nodes take exactly one parameter; node `main` takes N" |

A string task arrives as a string; an object task arrives as that object.
The parameter's declared type is the agent author's business; a mismatch
fails the run the same way any wrong-type call does. Agents whose natural
shape differs add a small adapter node — the adapter lives in the agent's
code, the correct side of the line. (An agent that genuinely ignores its
input declares the parameter and ignores it.)

**Design history — the zero-parameter reversal.** The first draft of this
spec let a zero-parameter node run with the task silently undelivered, to
keep input-free agents evaluatable. Review reversed it, twice: first
"task-with-0-params should be an error" (a silent drop is the exact failure
mode this change exists to remove), then "every input requires exactly one
task" (which collapsed the delivery matrix from five rows to three and
deleted the tagged IPC wrapper). The accepted cost: an input-free agent
must declare a parameter it ignores — that reaches across the
test-vs-agent line, but in the direction that costs one line in the agent,
and the mismatch is enforced *before* any run (see `agentTarget.ts`'s
`assertEvalEntryNodeTakesOneParameter`), never as a silent `undefined`.

There is **no fallback from `goal` to `task`**: the two fields are fully
independent, and `goal` is simply optional (it is already required only when
the default LLM judge would run). The one place the two coincide is the
quick one-liner, and that is handled at input *creation*, not delivery:
`agency eval run --goal "write a haiku to out.txt"` builds an input with
both fields set to the same text (`inputFromGoal` writes `task` and `goal`
explicitly, and the run directory's `input.json` shows both). Shorthand is
visible in the artifact; nothing is resolved implicitly later.

## Wire and code changes

**The IPC instruction, in detail.** When eval (or `std::agency.run`) runs an
agent, the parent process forks `lib/runtime/subprocess-bootstrap.ts` and
sends it one message: a `RunInstruction` (`lib/runtime/ipc.ts:530`), which
says "import this compiled script, run this node, with these arguments,
under these limits":

```ts
type RunInstruction = {
  type: "run";
  scriptPath: string;              // the compiled agent module
  node: string;                    // which exported node to call
  args: Record<string, any>;       // named arguments, keyed by parameter name
  ipcPayload?: number;
  configOverrides?: Partial<AgencyConfig>;
};
```

The child looks up the node function, reads the compiled module's
`__<node>NodeParams` export (the parameter names in declaration order), maps
the named `args` record to positional values, and calls the function
(`subprocess-bootstrap.ts:82-117`).

The problem for eval: filling that `args` record requires knowing the
agent's parameter *names* — which is exactly the coupling this spec removes.
The parent no longer knows (or wants to know) whether the node's parameter
is called `task`, `prompt`, or `x`; it only has a value to deliver.

So `RunInstruction` gains one optional field, which eval runs always send.
Because the loader guarantees every task is a string or a plain object
(never absent, never `undefined`), the field needs no wrapper — its
*presence* is the signal:

```ts
  /** Present on every eval run; absent on all other runs. Delivered as the
   *  node's single positional argument (eval entry nodes take exactly one
   *  parameter). Mutually exclusive with a non-empty `args`. */
  task?: string | Record<string, unknown>;
```

`executeRun` branches on the field: when present, it checks
`__<node>NodeParams.length === 1` and sends any violation back over IPC as
a run error *before* the node executes, then calls `nodeFn(task)` — the
parameter's name never matters. When absent, the existing named-`args`
mapping applies unchanged, so `std::agency.run` and hoisted calls are
untouched. Sending both `task` and a non-empty `args` is rejected as a
malformed instruction. The `ResumeInstruction` path (checkpoint resume)
carries no arguments and is unaffected.

**The eval call chain.** `runAgent(agentPath, node, args, ...)` becomes
`runAgent(agentPath, node, task, ...)` with `task: unknown`;
`EvalInputRunner`'s `args` field becomes `task`; `runSuite` resolves
`input.task ?? input.goal` and drops the `input.node ?? target.node`
override (the node comes only from the `--agent` target now).

**The loader** (`lib/eval/loadInputs.ts`). `task` is **required** on every
input and must be a string or a plain object. Inputs still carrying `args`
or `node` are **rejected with a migration error** naming the new shape — a
silent ignore would make old suites appear to run while sending the agent
nothing. The goal-requirement rule is unchanged: a goal is required exactly
when the default LLM judge would run (no custom graders, not `--no-grade`).

**Everything that reads `args` downstream.**

- `lib/eval/runArtifacts.ts` — each run directory's `input.json` records the
  input spec; it now records `task` instead of `args`/`node`. `judgeSuite`
  reads only `goal` from these files and is unaffected.
- `lib/optimize/reflectionFeedback.ts:18` — the reflection prompt's
  `Args: ...` line becomes `Task: ...`.
- `lib/optimize/baseOptimizer.ts`, `lib/optimize/mutator.ts`,
  `lib/eval/extract.ts` — mechanical renames at each `.args` use, found and
  migrated during implementation.
- Grader modules see the change through the `Input` type on their context
  (`ctx.input.task`); none of ours read `args` today.

**Suites and tests to migrate** (breaking change, no compatibility shims,
per the standing house rule):

- `evals/terminal-bench-mini/regex-log/test.json` — the duplication
  disappears: the instruction moves to `task`, `goal` stays the criterion,
  `node` is dropped.
- `evals-demo/` — deleted, not migrated (untracked scratch from the first
  framework test; terminal-bench-mini is the real example now).
- `lib/eval/loadInputs.ts` `inputFromGoal` — writes `task` and `goal`
  explicitly (the `--goal` shorthand materializes both at creation).
- `tests/integration/eval-run/test.mjs` — its fixture input and any
  `--agent` node expectations.
- Unit tests across `lib/eval/` and `lib/optimize/` that construct `Input`
  values.
- Docs: `docs/site/cli/eval.md` (input format section),
  `docs/dev/eval-grading.md` and `docs/dev/writing-optimizers.md` where they
  show input examples.

**Agent-side migrations in this repo:** none required — `foo.agency`'s
`main(task: string = "")` and the terminal-bench solution agent already fit
the one-parameter convention.

## What deliberately does not change

- `goal` semantics and every consumer of it (LLM judge, `judgeSuite`,
  optimizer objective).
- `expected`, `files`, `metadata`, `id`.
- Seeding, grading, the run-directory layout, the errored-runs-score-zero
  rule.
- The general subprocess IPC contract for non-eval callers.

## Testing

- Loader: string task accepted; object task accepted; missing task
  rejected; array/number rejected; legacy `args`/`node` rejected with the
  migration message; `inputFromGoal` sets both `task` and `goal`.
- Bootstrap: all three rows of the delivery matrix (1 param delivers the
  value, string and object; 0 params errors; 2+ errors), plus task-and-args
  mutual exclusion. (Unit tests against `executeRun` with a stub module,
  same style as existing bootstrap tests.)
- `runSuite` end-to-end (fake runner): the task value observed by the
  runner for both string and object tasks.
- The no-LLM smoke: the regex-log suite against `solution.agency` must still
  score 1.0 after its `test.json` migrates.
- Full eval + optimize unit test files, and the eval-run integration test.

## Future work this sets up (not in this PR)

The command-agent spec (`--agent-cmd 'agency agent ... -p -- {task}'`)
builds directly on `task`: a string task substitutes into the command as one
argv token; an object task substitutes as its JSON serialization. Because
tests are now agent-agnostic, that feature will touch only the runner side.
