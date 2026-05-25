# Language Simplification for Static Analysis

## The Idea

Simplify Agency's language specification to make static analysis (handler coverage, policy checking, symbolic execution) more tractable. Since Agency has no users, breaking changes are free.

## Why It Matters

Every language feature adds complexity to static analysis:

- **More constructs** = more cases the analyzer must handle
- **More dynamic features** = less the analyzer can prove statically
- **More interaction between features** = more edge cases and harder reasoning

If the goal is to make Agency a language where agents can write code that is *provably safe* before execution, the language's complexity directly impacts what "provably safe" means and how feasible it is to check.

This is the classic tradeoff: languages designed for verification (Rust's ownership, Dafny's contracts, Ada/SPARK's restrictions) are more restrictive precisely because restrictions enable stronger guarantees.

A simpler language also benefits the meta-programming use case: LLMs generate simpler code more reliably, the compiler can check more properties, and the generate-compile-fix loop is tighter.

Since Agency has no users, this is the ideal time to make this tradeoff.

## Agreed Changes

Based on brainstorming, these simplifications have been agreed on:

| Feature | Decision | Rationale |
|---------|----------|-----------|
| **Classes** | **Remove** | Experimental, currently broken, not very useful. Dynamic dispatch and mutable instance state complicate type and data flow analysis. Plain objects + functions cover the same use cases. |
| **Match blocks** | **Remove** | Not very useful, adds another control flow construct the analyzer must handle. Simplifies things with minimal expressiveness loss. |
| **Blocks/closures** | **Restrict to non-escaping** | Blocks already behave this way in practice (storing a block in a variable breaks interrupt resume). Making it an explicit restriction lets the analyzer safely assume a block's effects happen exactly at the call site. No behavioral change for correct code. |
| **Effect inference** | **Compiler infers from function bodies** | Instead of relying on user-provided annotations (which are unreliable), the compiler analyzes function bodies and call chains to determine what effects (interrupts, I/O, etc.) a function can have. For opaque TypeScript imports, assume the worst (has effects). This is strictly better than annotations for user code. |

## Features That Stay

| Feature | Rationale |
|---------|-----------|
| **Checkpointing** | Powers interrupts, debugger, traces. Core infrastructure. |
| **Restore** | Initially considered for removal due to non-linear control flow concerns. However, testing confirmed that **handlers survive restore** — they are re-registered as code re-executes from the checkpoint point forward. The safety property (handler coverage) is preserved across restore. Restore does add analysis complexity (implicit loops, resource counting, termination analysis) but does not create safety gaps. Keep for now; revisit if analysis complexity proves prohibitive in practice. |
| **Fork / Parallel** | Not as problematic for analysis as initially thought. Each branch has isolated state, so handler coverage can be checked per-branch independently. Path multiplication is mainly a concern for symbolic execution, not for handler coverage or policy checking. Subprocess execution (a separate idea) is actually harder to analyze than fork. |
| **Dynamic property access** | Useful in practice. Would be a hard sell to remove. |
| **Threads / subthreads** | Core to LLM conversation management. |
| **Result types, pipe operator, partial application** | Structured, well-typed — actually help analysis rather than hinder it. |

## Open Questions

- **What other features might benefit from restriction or removal?** This list may grow as we dig deeper into specific analysis passes (handler coverage, symbolic execution).
- **How does simplification interact with the meta-programming use case?** A simpler language is easier for LLMs to generate, but too simple means agents can't express sophisticated plans. Where's the sweet spot?
- **Are there features that should be added to help analysis?** Effect inference is agreed, but what about purity annotations (`safe` keyword already exists), capability types, or other analysis aids?

## Dependencies

- Should be evaluated before committing to specific static analysis approaches (handler coverage, symbolic execution) since the language's complexity directly affects their feasibility
- Affects all other ideas in this set

## Related Ideas

- All other ideas benefit from language simplification
- Handler coverage analysis (simpler call graph with fewer features)
- Symbolic execution (fewer constructs = fewer paths to explore)
- Policy checking (simpler language = more precise policy enforcement)
