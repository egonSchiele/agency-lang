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

On the other hand, Agency has a lot of things built into the language that TypeScript doesn't. Most of them exist to make writing agents safe and easy:

- Human-in-the-loop support through [interrupts](/guide/interrupts) and [checkpointing](/guide/checkpointing). These let you pause a run, ask a human for input, and then resume the run from the same point. Also see [interrupts, part 2](/guide/interrupts-part-2.md).
- [Handlers](/guide/handlers), [Effects and `raises`](/guide/effects-and-raises) — all of these offer safety guarantees that TypeScript doesn't have.
- [Pattern matching](/guide/pattern-matching) with exhaustiveness checking.
- [Guards](/guide/guards) — set time and cost limits on LLM calls.
- [Runtime validation](/guide/type-validation) — do runtime validation using your types, no need to write separate Zod schemas.
- [Partial function application](/guide/partial-application) as a language feature.
- [Blocks](/guide/blocks).
- [State isolation](/guide/state-isolation).
- A huge, [agent-focused standard library](/guide/agency-stdlib) — web search, browsers, messaging, and more.

And of course you can easily [call TypeScript code from Agency](/guide/ts-interop.md), so you can use the best of both worlds. Agency compiles to TypeScript or JavaScript, so it fits right in with your existing stack.

See [Why Agency?](/guide/why-agency) for a more detailed discussion.