# Handler Coverage Analysis

## The Idea

A static analysis pass that verifies every reachable interrupt-throwing function is wrapped in a handler. Like checked exceptions in Java, but for Agency's interrupt/handler model.

## Why It Matters

When an agent generates Agency code at runtime, the biggest safety risk is that the generated code calls dangerous functions (file writes, shell commands, network requests) without handlers. Today, unhandled interrupts propagate to the user — which is fine for human-written code. But for agent-generated code that runs automatically, you want a compile-time guarantee that every dangerous operation has a handler.

This is the "proof checker" for agent-generated plans. The agent writes code, the compiler says "you forgot to handle the interrupt from `std::fs.write()` on line 12," and the agent fixes it before execution.

## How It Would Work

1. Build a call graph from the program's entry point
2. For each function in the graph, determine if it can throw an interrupt (directly via `interrupt` or transitively via calling a function that can)
3. For each call site of an interrupt-throwing function, check whether it's inside a `handle` block
4. Report uncovered calls as errors or warnings

## Key Questions

- **Scope**: Should this analyze the full transitive call graph (including stdlib and imported code), or just user-written code? Analyzing stdlib is necessary to know which functions throw interrupts.
- **Annotation**: How does the compiler know which functions throw interrupts? Options:
  - Infer from source code (analyze function bodies for `interrupt` statements)
  - Explicit annotation (like Java's `throws` — `def dangerousFunc() throws Interrupt { ... }`)
  - Both (infer for local code, require annotation for external/opaque code)
- **Granularity**: Just "has a handler" or "has a handler that actually makes a decision" (vs. `with approve` which defeats the purpose)?
- **Opt-in vs mandatory**: Config flag? Always on for agent-generated code? `requireHandlerCoverage` in agency.json?
- **False positives**: What about functions that conditionally throw interrupts (e.g., only if a flag is set)? How precise does the analysis need to be?
- **Standard library impact**: The stdlib would need to declare which functions throw interrupts. Is this already inferrable from the source, or does it need new metadata?

## Complexity Considerations

- Agency's control flow features (fork, blocks, interrupts-inside-tools) make call graph construction non-trivial
- Dynamic dispatch (if Agency ever has it) would make this harder
- The simpler the language, the more precise this analysis can be (see: language simplification idea)

## Dependencies

- Needs a call graph builder (may already exist in parts for the compilation unit)
- Needs interrupt metadata for stdlib functions
- Benefits from language simplification (fewer constructs = more precise analysis)

## Related Ideas

- Subprocess IPC (handler coverage is most valuable for agent-generated code)
- Policy checking (handler coverage is one specific policy; general policy checking is broader)
- Language simplification (simpler language = more precise analysis)
