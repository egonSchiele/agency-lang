# `agency effects`: where the data comes from

User-facing behavior is documented in `docs/site/cli/effects.md`. This
page covers the implementation choices a future change needs to know.

- Sets come from `builtinEffectSets()` (`lib/runtime/effectSets.ts`) —
  the parsed table over `stdlib/capabilities.agency` that flag expansion
  also uses, so the command and the flags cannot disagree. That file
  documents the doc-comment pairing and the once-per-process cache.
- Policies come from `BUILTIN_POLICIES` / `builtinPolicy`
  (`lib/runtime/builtinPolicies.ts`), the definitions every `--policy`
  flag resolves. The policy detail view resolves against the process
  cwd so dir-scoped rules print the paths they would really match.
- An unknown name errors here even though the flags fall back. The
  flags must keep an unmatched bare name working as a plain effect name
  (bare effect declarations are legal); a discovery command has no
  compatibility to preserve, so it can afford the typo error.
- Rendering is pure string-returning functions in `lib/cli/effects.ts`,
  unit-tested directly; `effects.spawn.test.ts` runs the built CLI.
  Colors use `ttyColor`, which noops when stdout is not a TTY, so both
  test layers assert plain strings.
- `effects` is in `AGENCY_SAFE_SUBCOMMANDS`
  (`lib/runtime/builtinPolicies.ts`), so the agent's exec-based
  `agencyCli` tool can run it under the default policies without
  prompting.
