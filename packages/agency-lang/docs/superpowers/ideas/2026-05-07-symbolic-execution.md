# Symbolic Execution

## The Idea

Explore all possible execution paths through an Agency program to verify properties — such as "no path leads to an unhandled dangerous operation" or "every path eventually terminates" — without actually running the program.

## Why It Matters

Static analysis (type checking, handler coverage) examines code structure. Symbolic execution goes further: it *simulates* running the program with symbolic values (placeholders instead of concrete data) and explores every branch. This catches issues that structural analysis misses:

- "If the LLM returns `category: 'delete'`, execution reaches `deleteAll()` without a handler — but only on that specific branch"
- "If the loop runs more than 100 times, the checkpoint store overflows"
- "There's a path where the agent calls `write()` then `delete()` in sequence, creating a race condition"

For agent-generated code, this is powerful: you can verify that *no possible execution* violates safety properties, not just that the code *looks* safe structurally.

## How It Would Work

1. Parse and compile the Agency program to an intermediate representation
2. Replace concrete inputs with symbolic values (e.g., `x` is "any string" instead of "hello")
3. Execute symbolically: at each branch (`if`, `while`, pattern match), fork into both paths
4. At each dangerous operation, check: is there a handler? Does it always approve/reject correctly?
5. Report paths that violate properties, with concrete examples showing how to reach them

## Background

Symbolic execution is well-established in programming language research and security, but it's typically applied to low-level languages (C, Java bytecode) for finding bugs like buffer overflows and null pointer dereferences. Applying it to a high-level DSL like Agency is unusual but potentially more tractable because:

- Agency is simpler than general-purpose languages
- The things we want to verify (handler coverage, policy compliance) are well-defined
- LLM outputs can be modeled as "any value of type T" — we don't need to model the LLM itself, just the space of possible outputs
- Agency's type system already constrains what values are possible

## Key Questions

- **Path explosion**: The classic challenge. Every branch doubles the number of paths. How do we bound this? Options:
  - Loop unrolling limits (explore up to N iterations)
  - Path merging (combine paths with same security-relevant state)
  - Prioritize paths that reach dangerous operations
- **LLM calls**: What's the symbolic model for an LLM call? "Returns any value matching the output type"? This is conservative but sound — if no path with any possible LLM output violates safety, the program is safe.
- **Interrupts**: How does symbolic execution handle interrupts? Model both approve and reject paths?
- **External functions**: TypeScript imports are opaque. How do we model their behavior? Conservative assumption (can return anything, may have side effects)?
- **Scope**: Full symbolic execution of arbitrary programs? Or targeted "symbolic checking" of specific properties (handler coverage, policy compliance)?
- **Feasibility**: Is Agency simple enough to make this tractable? How much does language complexity affect the path space?
- **User-facing output**: When a violation is found, how do we present the "counterexample path" to the user in an understandable way?

## Complexity Considerations

This is the most research-heavy idea in the set. Key challenges:

- Building a symbolic executor is a significant engineering effort
- Path explosion is a real problem even for simple programs
- Modeling external dependencies (TS imports, LLM calls) requires careful abstraction
- May need to start with a limited version (e.g., only analyze handler coverage symbolically) before going general

However, Agency's relative simplicity compared to general-purpose languages makes this more feasible than it would be for, say, Python or Java.

## Dependencies

- Needs a clear intermediate representation to execute symbolically
- Benefits enormously from language simplification (fewer constructs = fewer paths = more tractable)
- Builds on handler coverage analysis (symbolic execution can verify handler coverage more precisely than structural analysis)
- Builds on policy checking (symbolic execution can verify policy compliance across all paths)

## Related Ideas

- Handler coverage analysis (symbolic execution does this more precisely but at higher cost)
- Policy checking (symbolic execution can verify policy compliance exhaustively)
- Dry-run execution (concrete execution with mocked tools; symbolic execution is the abstract version)
- Language simplification (directly affects feasibility)
