---
name: agency-compiler-docs
description: Developer docs for the Agency compiler and type checker: the parser, the TypeScript IR and codegen, source locations, the formatter's comment handling, import rewriting, init ordering, incremental builds, effect propagation, type checking, and narrowing. Use when changing anything between parsing an .agency file and emitting TypeScript.
---

# Compiler developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/compiler/typescript-ir.md` — The `TsNode` tree that generated TypeScript is built from, instead of concatenating strings.
- `docs/dev/compiler/ts-ir-readability-backlog.md` — A backlog of pain points in the TypeScript builder. Nothing here is actioned yet.
- `docs/dev/compiler/binop-parser.md` — How binary expressions parse, including the operator precedence and associativity table.
- `docs/dev/compiler/locations.md` — How source positions flow through the parser, and what to check when a reported location is wrong.
- `docs/dev/compiler/trailing-comments.md` — How `agency fmt` keeps an end-of-line `//` comment where the author wrote it.
- `docs/dev/compiler/rewriting-imports.md` — How imports in generated output are rewritten, and why compile mode and run mode differ.
- `docs/dev/compiler/codegen-als-accessors.md` — How generated code reads runtime values out of the active async-context frame.
- `docs/dev/compiler/hoist-calls.md` — Why helper calls are hoisted into their own statements, so resuming never re-runs a call that already finished.
- `docs/dev/compiler/init.md` — Design history for running a file's top-level code before any node executes.
- `docs/dev/compiler/init-topsort.md` — The dependency graph and ordering that decide which module's top-level code runs first.
- `docs/dev/compiler/incremental-builds.md` — The build manifest that lets the compiler skip files whose inputs have not changed.
- `docs/dev/compiler/effect-propagation.md` — How the interrupt effects a function carries are computed and propagated through calls.
- `docs/dev/compiler/interrupts-command.md` — `agency interrupts`, which statically prints which handlers could enclose each interrupt.
- `docs/dev/compiler/undefined-function-diagnostic.md` — The diagnostic for calling a function that does not exist, and how real JS interop avoids false positives.
- `docs/dev/compiler/typechecker/README.md` — How bidirectional type checking works: the phases, the scopes, and the diagnostic registry.
- `docs/dev/compiler/typechecker/narrowing/README.md` — Flow-sensitive narrowing and exhaustiveness checking.
- `docs/dev/compiler/typechecker/definite-returns-remaining-work.md` — What shipped for definite-return checking and which parts are still open.
