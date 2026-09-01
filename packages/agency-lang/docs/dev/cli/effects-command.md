# `agency effects`: discovering the approval-flag vocabulary

`agency effects` answers "what names can I put in `--approve`,
`--reject`, and `--policy`?". It is a read-only command over data that
already exists; it compiles nothing and needs no project context.

## What it shows

- `agency effects` — the built-in capability sets (name and the first
  sentence of each doc comment), then the built-in policies (the same
  name-and-description pairs `agency agent --policy` prints), then flag
  usage.
- `agency effects FileRead` — one set in full: the whole doc comment,
  the composition when the set is declared from other sets
  (`FileSystem = FileRead + FileWrite`), and the flat member list —
  which is exactly what a flag grants.
- `agency effects std::write` — the reverse question: which sets
  include this effect. An effect no set includes can still be named
  directly in the flags.
- `agency effects with-writes` — a built-in policy's description and
  its resolved JSON (`builtinPolicy(name, cwd)`), so dir-scoped rules
  show the paths they would really match at this launch directory.
- An unknown name errors with a near-miss hint. This differs from the
  flags on purpose: an unmatched bare name in `--approve` must fall
  back to a plain effect name for compatibility, but a discovery
  command has no compatibility to preserve.

## Where the data comes from

- Sets: `builtinEffectSets()` (`lib/runtime/effectSets.ts`), the parsed
  table over `stdlib/capabilities.agency` that flag expansion also uses.
  One loader, one definition; see the notes in that file for the doc
  comment pairing and the once-per-process cache.
- Policies: `BUILTIN_POLICIES` / `builtinPolicy` from
  `lib/runtime/builtinPolicies.ts`, the same definitions every
  `--policy` flag resolves.

The rendering lives in `lib/cli/effects.ts` as pure string-returning
functions (`renderEffectsList`, `renderSetDetail`, ...) unit-tested in
`effects.test.ts`; `effects.spawn.test.ts` runs the built CLI end to
end.
