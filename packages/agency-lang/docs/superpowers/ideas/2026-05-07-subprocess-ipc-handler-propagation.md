# Subprocess Execution with IPC Handler Propagation

## The Idea

Give Agency agents the ability to write Agency code and execute it in a subprocess — while ensuring the parent process's handler chain applies to the subprocess. The subprocess cannot escape the parent's safety constraints.

## Why It Matters

Today, agents operate within a fixed program. They can call tools, make LLM requests, and follow control flow, but they can't create new structured behavior at runtime. Giving agents the ability to write and execute Agency code lets them create structured, typed, verifiable plans instead of relying purely on probabilistic LLM reasoning.

The critical safety property: the parent's handlers wrap the subprocess. If the parent has a handler that rejects file deletions, the subprocess cannot delete files — even if the agent writes `with approve` in the generated code. The "any reject wins" rule extends across the process boundary.

This is analogous to structured output: just as schemas constrain LLM data output to be more reliable, Agency code constrains agent planning to be more structured and verifiable.

## How It Would Work

1. Parent calls `std::agency.run(source)` (or similar)
2. Source is compiled (type checked, validated)
3. Compiled code executes in a subprocess
4. Subprocess communicates with parent via IPC (JSON over stdin/stdout or a socket)
5. When subprocess hits an interrupt:
   - Subprocess sends interrupt data to parent
   - Parent runs it through its own handler chain
   - Parent sends approve/reject back
   - Subprocess resumes or aborts
6. Subprocess's own handlers are innermost; parent's are outermost

## Key Questions

- **IPC protocol design**: JSON over stdin/stdout? Unix socket? What data needs to go back and forth beyond interrupt approve/reject? (stdout capture, errors, return values?)
- **Stdlib API shape**: `compile(source) -> Result` and `run(source) -> Result`? Should they operate on strings, files, or both?
- **Config inheritance**: Does the subprocess inherit the parent's `agency.json` config? Can the parent override config for the subprocess?
- **Error handling**: How do compilation errors, runtime errors, and subprocess crashes surface to the parent? As `Result` failures?
- **Nesting**: Can a subprocess spawn its own subprocess? If so, handlers should chain transitively (grandparent -> parent -> child).
- **Performance**: Subprocess startup cost. Is there a way to keep a warm subprocess pool, or is cold start acceptable?
- **Return values**: How does the parent get structured data back from the subprocess? JSON serialization of the return value?

## Dependencies

- Refactoring `lib/cli/commands.ts` to separate pure logic from CLI concerns (`process.exit`, `console.log`)
- Runtime changes to support "IPC mode" where interrupts are sent to parent instead of prompting user
- New stdlib module (`std::agency` or similar)

## Related Ideas

- Handler coverage analysis (verify generated code has handlers before running it)
- Policy checking (define and enforce constraints on generated code)
- Dry-run execution (preview what generated code would do before real execution)
- Language simplification (simpler language = easier to generate correct code)
