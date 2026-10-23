---
name: agency-language-docs
description: Developer docs for Agency language semantics and syntax features: blocks and closures, match expressions, null handling, parallel and seq blocks, splices, templates, validation annotations, pkg imports, handoff functions, and the with-approve modifier. Use when changing or reasoning about what an Agency language feature means.
---

# Language developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/language/agency-function.md` — The wrapper codegen emits around every Agency `def`. Covers tool metadata, argument resolution, and block arguments.
- `docs/dev/language/capabilities.md` — The `@capabilities` tag on a function or node: why it moved off effect declarations, the seven names and the diagnostics, the third propagation view that computes what a function needs across files, `agency test --check-capabilities` and the stack it replays from the capability log, `--platform` and the compile-time check with its call path, what the check does not cover, `enterCallable` and the refusal at function entry before any handler is pushed, and how the stdlib tags were decided and are kept honest.
- `docs/dev/language/closures-and-lambdas.md` — Why Agency has blocks and first-class functions but no lambdas, and what makes adding them hard.
- `docs/dev/language/decorators.md` — User-defined decorators: `@name(args)` above a def lowers to a call with the body as the block, the `call` record, stacking, why the lowering runs twice and before guards, how the symbol table credits a decorator as a callee, why mistakes are reported from `prepareProgram` and not the checker, the type errors that name the decorator and the table in `mismatch.ts` that picks them, a tag's argument count, the `raises` message that names the decorator, how `agency doc` prints the tags, why reusable decorators type their block as `any`, and the destructive-region gap the work found.
- `docs/dev/language/destructive-regions.md` — `destructive def` and the `destructive { }` region: the one `destructiveRan` flag per function activation, the five places that write or read it, why the generated code names it `__activation` so a block argument or fork branch marks the enclosing function, why the removed-tools list moved there too, when a pre-flip needs its own step, and why a region inside `parallel` is now allowed.
- `docs/dev/language/effect-patterns.md` — Naming an interrupt effect in a `match` arm and destructuring its payload, how it lowers, and its limits.
- `docs/dev/language/handoff-functions.md` — `handoff def`: a function that continues its caller's conversation when called as a tool, the marker and resume messages that replace its tool-call bookkeeping, the one-per-round rule, and `endTurn` and `handBack`: how a tool ends the caller's `llm()` call or replaces the hand-back message, which marks count, the fallbacks, and the `scope` argument.
- `docs/dev/language/lambda-sketch.md` — A design sketch for lambdas. Nothing here is implemented.
- `docs/dev/language/match-expression-positions.md` — Where a `match` may appear as a value, and why each such position has to be wired up by hand.
- `docs/dev/language/null-and-undefined.md` — Why Agency has exactly one nothing-value, `null`, and treats `undefined` as another spelling of it.
- `docs/dev/language/on-clause-handlers.md` — The `on`-clause handler alias (`with { on <effect>(param) { ... } }`) and expression-position `handle`, which desugar at parse time to the canonical handler so `agency fmt` normalizes them away.
- `docs/dev/language/parallel-blocks.md` — The shipped design for `parallel` and `seq` blocks: what they lower to and what they refuse.
- `docs/dev/language/parallel-blocks-v2-dataflow.md` — A spec for grouping parallel statements automatically by dataflow. Not implemented.
- `docs/dev/language/pkg-imports.md` — Importing Agency code from npm packages with the `pkg::` prefix.
- `docs/dev/language/reserved-names.md` — Names starting with `__` belong to the compiler: the one function that decides, the parser check and why it throws, the unchecked positions (object keys, properties, aliased imports), the fill check and the tree walk for code that is never parsed, and what to do when compiler-written Agency text trips the rule.
- `docs/dev/language/result-failures.md` — The `Result` failure: why every failure carries a string message, what the second type parameter means, and the arity padding codegen depends on.
- `docs/dev/language/splices.md` — Compile-time splices `$( ... )`, which run a generator during compilation and paste the code it returns into the file.
- `docs/dev/language/template-agency.md` — How templates work under the hood: holes, `fill`, and hygiene.
- `docs/dev/language/triple-quoted-string-escapes.md` — The two escapes a raw `"""` string honours, `\${` and `\"""`, and the three places (parser, generator, optimizer) that must agree on them.
- `docs/dev/language/type-casts.md` — `expr as Type` and `expr as Type!`: how a cast is told from an `as` block, the positions refused because Agency and TypeScript would group them differently, and why a checked cast is hoisted like a call.
- `docs/dev/language/effect-always-tag.md` — How `@always` / `@alwaysUnder` on an effect declaration reach the policy prompt: tag reading, typechecking, codegen registration, the runtime registry, and the IPC hand-off.
- `docs/dev/language/validation-annotations.md` — How `@validate` and `@jsonSchema` are compiled, how the runtime walks a validated value, where a `!` parameter is checked (step 0, so a resume skips it), why a resume's argument overrides are applied as given, and why a validator that pauses is not supported from a parameter check.
- `docs/dev/language/with-approve.md` — The `with approve/reject/propagate` shorthand for wrapping a single statement in a handler.
