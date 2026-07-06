---
name: Agency vs TypeScript
description: Summarizes the syntactic and semantic differences between Agency and TypeScript, highlighting TypeScript features (like classes, destructuring, and ternaries) that Agency intentionally omits.
---

# Agency vs TypeScript
Because Agency compiles to TypeScript, it has many similarities, but some things are different.

There are some [syntactical differences](/guide/basic-syntax). For example, Agency does not have (an incomplete list):
- A ternary operator (it has the single-line if expression)
- `for (let i = 0; i < n; i++)` loops (it has a while loop and an iterative for loop)
- Classes
- Lambdas (it has [blocks](/guide/blocks))
- Conditional types

On the other hand, Agency has a lot of things built into the language that TypeScript doesn't. Most of them exist to make writing *agents* safe and easy:

- [LLM calls](/guide/llm) as a first-class primitive — `llm(...)` is part of the language, with structured output and tools that are just ordinary [functions](/guide/functions).
- [Interrupts](/guide/interrupts) — a function can pause execution to ask for approval or input before it does something risky, and resume right where it left off.
- [Handlers](/guide/handlers) — `handle` blocks that decide how to respond to interrupts. These are Agency's core safety infrastructure.
- [Effects and `raises`](/guide/effects-and-raises) — the compiler statically tracks which effects (and interrupts) a function can trigger, so you can see and constrain what your code is allowed to do.
- [Policies](/guide/policies) — reusable rules for approving or rejecting interrupts.
- [Checkpointing and resumability](/guide/checkpointing) — execution state is snapshotted as the program runs, so you can rewind, retry, or resume a run after an interrupt (even [from TypeScript](/guide/interrupts-from-typescript)).
- A graph-based execution model built on [nodes](/guide/nodes).
- A built-in [`Result` type and error handling](/guide/error-handling), with flow-sensitive narrowing so the compiler makes you handle failures.
- [Pattern matching](/guide/pattern-matching) with exhaustiveness checking.
- [Guards](/guide/guards) — constrain and validate what an LLM is allowed to return.
- [Runtime validation](/guide/type-validation) — assert that values match a schema at runtime, right in the type.
- [Partial function application](/guide/partial-application) as a language feature.
- Built-in [concurrency](/guide/concurrency) (`fork`) that works correctly with interrupts and checkpoints.
- A [memory layer](/guide/memory) and [message threads](/guide/message-threads) for managing LLM conversation history.
- An [agent-focused standard library](/guide/agency-stdlib) — web search, browsers, messaging, and more.
- Built-in tooling: a [testing framework](/guide/testing), [observability and tracing](/guide/observability), and an interactive [debugger](/guide/debugging) you can rewind.