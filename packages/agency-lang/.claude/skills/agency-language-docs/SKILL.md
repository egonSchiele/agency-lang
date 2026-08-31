---
name: agency-language-docs
description: Developer docs for Agency language semantics and syntax features: blocks and closures, match expressions, null handling, parallel and seq blocks, splices, templates, validation annotations, pkg imports, and the with-approve modifier. Use when changing or reasoning about what an Agency language feature means.
---

# Language developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/language/agency-function.md` — The wrapper codegen emits around every Agency `def`. Covers tool metadata, argument resolution, and block arguments.
- `docs/dev/language/closures-and-lambdas.md` — Why Agency has blocks and first-class functions but no lambdas, and what makes adding them hard.
- `docs/dev/language/effect-patterns.md` — Naming an interrupt effect in a `match` arm and destructuring its payload, how it lowers, and its limits.
- `docs/dev/language/lambda-sketch.md` — A design sketch for lambdas. Nothing here is implemented.
- `docs/dev/language/match-expression-positions.md` — Where a `match` may appear as a value, and why each such position has to be wired up by hand.
- `docs/dev/language/null-and-undefined.md` — Why Agency has exactly one nothing-value, `null`, and treats `undefined` as another spelling of it.
- `docs/dev/language/parallel-blocks.md` — The shipped design for `parallel` and `seq` blocks: what they lower to and what they refuse.
- `docs/dev/language/parallel-blocks-v2-dataflow.md` — A spec for grouping parallel statements automatically by dataflow. Not implemented.
- `docs/dev/language/pkg-imports.md` — Importing Agency code from npm packages with the `pkg::` prefix.
- `docs/dev/language/splices.md` — Compile-time splices `$( ... )`, which run a generator during compilation and paste the code it returns into the file.
- `docs/dev/language/template-agency.md` — How templates work under the hood: holes, `fill`, and hygiene.
- `docs/dev/language/triple-quoted-string-escapes.md` — The two escapes a raw `"""` string honours, `\${` and `\"""`, and the three places (parser, generator, optimizer) that must agree on them.
- `docs/dev/language/effect-always-tag.md` — How `@always` / `@alwaysUnder` on an effect declaration reach the policy prompt: tag reading, typechecking, codegen registration, the runtime registry, and the IPC hand-off.
- `docs/dev/language/validation-annotations.md` — How `@validate` and `@jsonSchema` are compiled, and how the runtime walks a validated value.
- `docs/dev/language/with-approve.md` — The `with approve/reject/propagate` shorthand for wrapping a single statement in a handler.
