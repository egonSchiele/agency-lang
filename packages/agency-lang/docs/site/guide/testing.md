---
name: Testing
description: Introduces Agency's built-in testing framework, covering fixture generation, exact-match versus LLM-as-judge fixtures, and running tests with the `test` command.
---

# Testing

Agency comes with a built-in testing framework that makes it easy to test your agents.

## Generating fixtures

Generate fixtures for your agent by running

```
agency test fixtures foo.agency
```

Agency will execute your node. If there are multiple nodes, it will ask you which node to execute. The return value of the node will be saved as the fixture value.

## Test types

There are two test types:
- exact match
- LLM as a judge.

After you have generated the fixture, you can choose what test type you want. If you choose LLM as a judge, you'll need to provide a judge prompt that the LLM can use to judge the result.

## Test file

The fixtures command will create a test file with the same name as your agency file, but with the .test.json extension instead

```
foo.agency → foo.test.json
```

## Running tests

Use the `agency test` command to run the test. You can give it either the path to the agency file or the path to the test.json file.

## Test file options

A `.test.json` file has a top-level `tests` array. Each entry is one test case. The fixtures command fills in the common fields for you, but you can hand-edit the file to add any of the options below.

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"hello world\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

### Per-test options

Every test case has four required fields:

- **`nodeName`** — the node to run.
- **`input`** — the input passed to the node (a string; use `""` for none).
- **`expectedOutput`** — the expected return value, JSON-encoded as a string.
- **`evaluationCriteria`** — how to compare the result to `expectedOutput` (see below).

And a handful of optional ones:

- **`description`** — a human-readable note about what the test covers.
- **`skip`** — set to `true` to skip this test.
- **`skipOnCI`** — skip only when running in CI (i.e. when the `CI` env var is set). Handy for tests that depend on a developer machine, like macOS-only builtins or interactive prompts.
- **`retry`** — number of times to retry before failing. Useful for tests with a bit of nondeterminism.
- **`timeoutMs`** — per-test timeout in milliseconds. Defaults to 2 minutes and is capped at 5.
- **`argv`** — extra command-line arguments to hand the node. These show up as `process.argv.slice(2)`, so you can test `std::args` and other argv-reading code.

### Evaluation criteria

There are two ways to judge a result:

```json
"evaluationCriteria": [{ "type": "exact" }]
```

**`exact`** requires the output to match `expectedOutput` character for character.

```json
"evaluationCriteria": [
  {
    "type": "llmJudge",
    "judgePrompt": "The greeting can be any hello to Alice; exact wording doesn't matter.",
    "desiredAccuracy": 75
  }
]
```

**`llmJudge`** hands the result to an LLM along with your `judgePrompt`. The test passes when the judge's score meets `desiredAccuracy` (0–100). Use this when the output is valid in more than one form.

### Interrupt handlers

If your node raises interrupts (like `with approve`), list the responses in order under `interruptHandlers`:

```json
"interruptHandlers": [
  { "action": "approve", "expectedMessage": "confirm" }
]
```

- **`action`** — one of `"approve"`, `"reject"`, `"modify"`, or `"resolve"`.
- **`modifiedArgs`** — the replacement arguments when the action is `"modify"`.
- **`resolvedValue`** — the value to return when the action is `"resolve"`.
- **`expectedMessage`** — asserts the interrupt's message matches before responding.

### Mocking LLM calls

To keep a test deterministic (and free), you can mock out `llm()` calls instead of hitting a real provider. Set `useTestLLMProvider: true` and give an ordered list of mocks — one per `llm()` call, in source order:

```json
"useTestLLMProvider": true,
"llmMocks": [
  { "return": "hello there" },
  { "toolCall": { "name": "search", "args": { "q": "cats" } } }
]
```

Each mock is either a `return` (the value the call produces) or a `toolCall` (a tool the model "decides" to call). If several agents are involved, use the scoped form — an object keyed by agent name (its file basename, or `"*"` as a fallback) — so each agent draws from its own queue:

```json
"llmMocks": {
  "main": [{ "return": "main-summary" }],
  "mutatePrompt": [{ "return": { "operations": [] } }]
}
```

### File-level options

A few options live at the top of the file, alongside `tests`, and apply to the whole file:

- **`skip`** — skip every test in the file.
- **`skipOnCI`** — skip every test in the file when running in CI.
- **`skipReason`** — a note printed when the file is skipped.
- **`defaultTimeoutMs`** — default timeout for every test, unless a test sets its own `timeoutMs`.

```json
{
  "skipOnCI": true,
  "skipReason": "Needs a local Ollama server",
  "defaultTimeoutMs": 30000,
  "tests": [ ... ]
}
```

## Coverage

Want to know which lines of your `.agency` code your tests actually exercise? Add `--coverage` to any test run:

```
agency test --coverage tests/
```

Agency tracks every step the runtime executes — function bodies, `if`/`else` arms, loop iterations, handlers, and so on — and prints a summary when the run finishes:

```
Agency Coverage Report
======================
stdlib/array.agency                      100.0%  (76/76 steps)
stdlib/math.agency                        33.3%  (2/6 steps)
────────────────────────────────────────────────────────────
Total                                     53.8%  (162/301 steps)
```

You can generate detailed or HTML reports later with `agency coverage report`, and enforce minimums in CI with `--threshold` / `--per-file-threshold` (or the `coverage` block in `agency.json`). See the [coverage CLI reference](/cli/coverage) for the full set of options.

## References

- [CLI reference](/cli/test)
- [Coverage](/cli/coverage)