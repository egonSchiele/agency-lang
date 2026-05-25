# Code-Writing Agent for Agency

## The Idea

A stdlib function that takes a natural-language description and produces correct, readable, well-structured Agency code. Internally it uses LLM calls, the `compile()` function, and multiple review passes to generate high-quality code.

## Why It Matters

Subprocess execution (the `compile()` + `run()` API) gives agents the ability to execute Agency code. But someone has to *write* that code. If the agent writes it via raw `llm()` calls, the code quality depends entirely on the prompt and the model. A purpose-built code-writing function can use structured techniques — generate-and-rank, incremental generation, specialized review — to produce code that is significantly more correct, readable, and maintainable than naive LLM generation.

This is the "structured output for behavior" thesis in practice: just as Agency's type system constrains LLM data output, a code-writing agent constrains LLM code output through compilation, type checking, and review.

## Architecture

The code-writing function combines several techniques from recent research:

### Stage 1: Specification

Before generating code, clarify the spec:
- What node(s) should the program expose?
- What are the input types and return types?
- What stdlib modules can it use?
- Are there example input/output pairs?
- Are there constraints (no LLM calls, no shell access, etc.)?

The function takes these as structured parameters, not just a prose description.

### Stage 2: Generate-and-Rank

Generate N diverse candidates in parallel using `fork`, then pick the best:

1. **Generate N candidates** — call `llm()` N times with varied prompts (different framings, different temperatures, different emphasis). Each candidate is a complete Agency program.
2. **Compile all candidates** — use `compile()` on each. Discard any that fail to compile. This is a fast, deterministic filter (AlphaCode's filtering reduced false positives from 62% to 4%).
3. **Run tests** — if the caller provided test cases, run each surviving candidate against them. Discard failures.
4. **Rank survivors** — use an LLM call to compare the surviving candidates and pick the best one based on correctness, readability, and simplicity.

This maps naturally to Agency's `fork` primitive — all N candidates are generated in parallel.

### Stage 3: Review

Run the winning candidate through specialized review passes:

1. **Correctness review** — does the code do what the spec says? Are there logic errors, edge cases, off-by-one errors?
2. **Readability review** — are variable names clear? Is the code well-structured? Are functions decomposed appropriately?
3. **Handler coverage review** — does every dangerous operation (stdlib calls that interrupt) have a handler? Are there unhandled interrupt paths?

Each review pass produces specific, actionable feedback. If issues are found, the code is revised and re-reviewed (up to a max number of iterations).

### Stage 4: Final compilation and return

Compile the reviewed code one final time and return the `CompiledProgram`.

## API Shape

```
import { writeCode } from "std::agency"

const compiled = writeCode({
  description: "An agent that reads a CSV file, summarizes each row using an LLM, and writes the summaries to a new file",
  node: "main",
  params: { inputFile: "string", outputFile: "string" },
  returnType: "{ rowsProcessed: number }",
  allowedImports: ["std::shell", "std::fs"],
  tests: [
    { input: { inputFile: "test.csv", outputFile: "out.txt" }, expectedOutput: { rowsProcessed: 3 } }
  ],
  candidates: 5,
  review: true
})
```

## Prompts

The code-writing agent needs three core prompts:

### Writer Prompt

The writer prompt includes:
- A condensed Agency syntax reference (~6500 words from the guide, or a further-condensed version with key examples)
- The available stdlib functions and their signatures
- The specific task description, types, and constraints
- 3-5 diverse example Agency programs showing different patterns (handlers, LLM calls, fork, error handling, etc.)

Key principle: **examples > documentation**. LLMs learn syntax better from examples than from reference docs. The syntax reference backs up the examples for edge cases.

The prompt varies across candidates to encourage diversity:
- Candidate 1: "Write clean, minimal code"
- Candidate 2: "Write robust code with thorough error handling"
- Candidate 3: "Break the problem into small functions"
- Candidate 4: "Use Agency's Result types and pipe operator"
- Candidate 5: Default prompt

### Reviewer Prompt (Correctness)

```
You are reviewing Agency code for correctness. The code was generated to fulfill this specification:

[spec]

Here is the code:

[code]

Check for:
1. Does the code do what the spec asks? Trace through the logic step by step.
2. Are there edge cases that aren't handled?
3. Are there logic errors (off-by-one, wrong comparison, missing return)?
4. Does the control flow make sense? Are there unreachable code paths?
5. If the code uses LLM calls, are the prompts clear and the output types correct?

If the code is correct, respond with: { "pass": true }
If there are issues, respond with: { "pass": false, "issues": [...], "suggestedFix": "..." }
```

### Reviewer Prompt (Readability)

```
You are reviewing Agency code for readability and maintainability.

Here is the code:

[code]

Check for:
1. Are variable and function names clear and descriptive?
2. Is the code well-structured? Are functions an appropriate size?
3. Is there unnecessary complexity that could be simplified?
4. Are Agency idioms used correctly (Result types, pipe operator, handlers, blocks)?

If the code is readable, respond with: { "pass": true }
If there are issues, respond with: { "pass": false, "issues": [...], "suggestedFix": "..." }
```

### Reviewer Prompt (Handler Coverage)

```
You are reviewing Agency code for handler coverage. In Agency, any function that performs a dangerous operation (file writes, shell commands, HTTP requests, etc.) throws an interrupt that must be handled.

Here is the code:

[code]

Check for:
1. Does every call to std::shell (bash, exec), std::fs (edit, remove, copy, move), and std::http (webfetch) happen inside a handle block?
2. Are the handler decisions appropriate? (approve, reject, or propagate based on the data)
3. Are there any interrupt paths that could reach the user unexpectedly?

If handler coverage is complete, respond with: { "pass": true }
If there are gaps, respond with: { "pass": false, "issues": [...], "suggestedFix": "..." }
```

## The Syntax Reference

The writer prompt needs a condensed Agency syntax reference. Two approaches:

**Approach A: Include the full guide docs (~6500 words, ~9K tokens).** Simple, complete, but uses context. Could be loaded via a `static` variable so it's only read once.

**Approach B: Write a condensed reference card (~2000 words, ~3K tokens).** Covers syntax, key patterns, and common pitfalls in a denser format. Backed by 3-5 full example programs.

Approach B is probably better for the generate-and-rank approach where we're making N parallel LLM calls — each call pays the prompt cost, so shorter is better. The examples do more work than the reference text anyway.

## Incremental Generation (Future Enhancement)

For larger programs, MCTS-style incremental generation could help:

1. Generate a plan/skeleton first (node signatures, function signatures, types)
2. Compile the skeleton to check structure
3. Generate each function body individually
4. Compile after each function
5. If a function fails, regenerate just that function

This keeps each LLM call focused and gives fast feedback at each step. It also helps with context — generating one function at a time uses less context than generating the entire program at once.

## Test-Driven Generation (Future Enhancement)

Generate tests from the spec first, then generate code that passes them:

1. LLM generates Agency test cases from the natural-language description
2. Test cases are validated (do they parse? are they reasonable?)
3. Code is generated with the test cases visible in the prompt
4. Code is compiled and run against the tests
5. Failures are fed back for iteration

This maps to TiCoder's approach, which saw a 45% improvement in correctness.

## Dependencies

- `compile()` and `run()` from the subprocess spec
- Agency's test runner (for running generated tests against generated code)
- `fork` for parallel candidate generation

## Open Questions

- **How many candidates?** AlphaCode generates millions. We probably want 3-10 for cost/speed. What's the sweet spot?
- **Should the syntax reference be static or dynamic?** Static is simpler. Dynamic (retrieving relevant docs based on the task) could save tokens but adds complexity.
- **How do we handle tasks that need multiple files?** The current design assumes a single-file program. Multi-file generation is more complex.
- **Should the review passes be LLM-based or rule-based?** Handler coverage could potentially be checked statically (a future analysis pass) rather than by an LLM.

## Related Ideas

- Subprocess IPC + Handler Propagation (the foundation — `compile()` and `run()`)
- Handler Coverage Analysis (could replace the LLM-based handler reviewer)
- Policy Checking (compile-time constraints on generated code)
