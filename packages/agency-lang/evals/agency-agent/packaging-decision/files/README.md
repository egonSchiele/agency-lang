# Waypoint

Waypoint is a small language for building automations. This package is the
whole toolchain: the compiler, the runtime, the standard library, the
`waypoint` CLI, and the built-in agent that users start with `waypoint agent`.

- `src/compiler/` — parser, type checker, code generator
- `src/runtime/` — what compiled programs import at execution time
- `src/stdlib/` — the standard library
- `src/cli/` — the `waypoint` binary and its subcommands
- `src/agent/` — the built-in agent
- `docs/dev/` — developer notes
