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

### File-level options

A few options live at the top of the file, and apply to the whole file:

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

### Test-level options

A `.test.json` file has a top-level `tests` array, where each entry is one test case. The fixtures command will generate these entries for you.

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

Required:

- **`nodeName`** — the node to run.
- **`input`** — the input passed to the node.
- **`expectedOutput`** — the expected return value, JSON-encoded as a string.
- **`evaluationCriteria`** — how to compare the result to `expectedOutput` (see below).

Optional:

- **`description`** — a human-readable description.
- **`skip`** — set to `true` to skip this test.
- **`skipOnCI`** — skip only when running in CI (i.e. when the `CI` env var is set). Handy for tests that depend on a developer machine, like macOS-only builtins or interactive prompts.
- **`retry`** — number of times to retry before failing. Useful for flaky tests.
- **`timeoutMs`** — per-test timeout in milliseconds. Defaults to 2 minutes and is capped at 5.
- **`argv`** — extra command-line arguments to hand the node. These show up as `process.argv.slice(2)`, so you can test `std::args` and other argv-reading code. A JSON array of strings.

### Evaluation criteria

There are two ways to judge a result:

#### Exact match

```json
"evaluationCriteria": [{ "type": "exact" }]
```

Actual output matches the `expectedOutput` exactly.

#### LLM Judge

```json
"evaluationCriteria": [
  {
    "type": "llmJudge",
    "judgePrompt": "The greeting can be any hello to Alice; exact wording doesn't matter.",
    "desiredAccuracy": 75
  }
]
```

Ask an LLM to judge the result. `judgePrompt` is a string that describes what a correct result looks like. An LLM judge will see how close the actual output is to the expected output and give a score between 1 and 100. The desired accuracy is the minimum score required.

### Interrupt handlers

If your node raises [interrupts](/guide/interrupts), list the responses in order under `interruptHandlers`:

```json
"interruptHandlers": [
  { "action": "approve", "expectedMessage": "confirm" }
]
```

- **`action`** — one of `"approve"`, `"reject"`, `"modify"`, or `"resolve"`.
- **`resolvedValue`** — the value to return when the action is `"resolve"`.
- **`expectedMessage`** — asserts the interrupt's message matches before responding.

### Mocking LLM calls

To keep a test deterministic, you can mock out `llm()` calls. Set `useTestLLMProvider: true` and give an ordered list of mocks, one per `llm()` call:

```json
"useTestLLMProvider": true,
"llmMocks": [
  { "return": "hello there" },
  { "toolCall": { "name": "search", "args": { "q": "cats" } } }
]
```

Each mock is
- a `return` (the value the call produces), or
- a `toolCall` (a tool the model "decides" to call).

If your test runs several agents, you can make `llmMocks` an object keyed by agent name (the agent's file basename), giving each agent its own queue of mocks. You can also use a `"*"` key to catch calls from any agent not listed.

```json
"llmMocks": {
  "main": [{ "return": "main-summary" }],
  "mutatePrompt": [{ "return": { "operations": [] } }]
}
```

## Coverage

Want to know which lines of your `.agency` code your tests actually exercise? Add `--coverage`:

```
agency test --coverage tests/
```

Agency tracks every step the runtime executes, and prints a summary when the run finishes:

```
Agency Coverage Report
======================
stdlib/array.agency                      100.0%  (76/76 steps)
stdlib/math.agency                        33.3%  (2/6 steps)
────────────────────────────────────────────────────────────
Total                                     53.8%  (162/301 steps)
```

Other things you can do:
- generate a detailed report with `agency coverage report`
- generate an HTML report with `agency coverage report --html`
- enforce minimum coverage in CI with `--threshold` / `--per-file-threshold`

See the [coverage CLI reference](/cli/coverage) for the full set of options.

## References

- [`test` CLI reference](/cli/test)
- [`coverage` CLI reference](/cli/coverage)