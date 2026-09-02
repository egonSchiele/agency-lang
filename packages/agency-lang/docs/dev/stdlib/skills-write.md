# The `std::skills` write half

`std::skills` started as a read-only module: `skillsDir` serves a directory
of markdown skills to an LLM. It now also has a write half:

- `writeSkill(dir, name, description, body)` saves one flat-layout skill
  file, behind a `std::skills::save` interrupt.
- `scanSkillsSubdirs(root, subdirs)` scans named subdirectories of one
  root — one subdirectory per agent — and returns
  `Result<Record<string, SkillGroup>>`, every requested name mapped to a
  group holding the scanned directory and its entries (empty when the
  subdirectory is empty or missing). The record is null-prototype, so
  names like `__proto__` are plain data keys.
- `skillsToolFromEntries(dir, entries, name)` is the pure build half of
  `buildSkillsTool`: no reads, no interrupts, so a caller holding entries
  can rebuild a skills tool without rescanning. Its `dir` must be the
  directory the entries were scanned from — for `scanSkillsSubdirs`
  output that is the group's own `dir`, never the root — which is why
  each group carries it.

## The save gate

Nothing is written without the responder seeing the complete file —
frontmatter and body — in the `std::skills::save` interrupt data; a
rejection fails the call. The interrupt deliberately has no answer
shape: any approval saves, and data carried on the approval is not
consulted. A draft-revise-accept loop belongs in a caller built on top
of `writeSkill`.

One save raises three interrupts: `std::skills::save`, then `std::mkdir`
and `std::write` for the directory and the file. The save approval does
not cover the other two, so a policy that auto-approves saves must also
cover `std::mkdir` and `std::write` under the same directory, or the
responder is asked again for each.

Duplicate names are refused twice. Before the interrupt, an `exists`
check fails a taken name without prompting anyone. The write itself
uses `create-only` mode — the `wx` open flag is the whole
implementation (`lib/stdlib/builtins.ts`), so an existing file or a
dangling symlink fails the open atomically — because the pre-interrupt
check is stale by save time: approval can take arbitrarily long, and a
file created in the meantime must never be overwritten.

The `dir` in the interrupt payload is absolutized (`~` expanded,
resolved against the process cwd), so relative and `~`-led spellings
produce the same payload and an always-scope rule saved from a save
approval names one directory regardless of how the caller spelled it.
One gap remains: the write that follows realpaths its directory
(`prepareContainedPath`), and the save payload cannot — the directory
may not exist until `mkdir` runs after approval. So a directory reached
through a symlinked ancestor still yields two spellings (on macOS,
`/tmp/skills` for the save and `/private/tmp/skills` for the write),
and one always-scope rule will not cover both interrupts there. An
empty `dir` is refused before any prompt.

## The trust argument for the subdir scan

`scanSkillsSubdirs` raises one `std::skills::skillsDir` interrupt for the
root, and that single approval covers the interrupt-free reads
(`_glob` / `_read`) of everything underneath — the same one-scan-interrupt
pattern `skillsDir` uses. Two checks keep the reads inside what was
approved:

1. Every subdirectory name must be a bare path segment (no separators,
   no `..`, not empty), checked before the interrupt is raised; one
   failure names every offending entry.
2. The scan passes the root as the glob's allowed path, which switches
   the glob into refuse-symlinks mode: a symlinked subdirectory fails
   the glob (even one whose target sits inside the root), and symlinked
   entries inside a real subdirectory are left out of the results. The
   file reads that follow go through a descriptor-validated read
   (`readContainedFile`): the open refuses a final-component symlink,
   and the opened descriptor itself is checked to sit inside the root —
   so a path swapped for a symlink after the listing is refused with no
   check-then-open window.

The interrupt payload's `dir` is absolutized, an empty root fails
before any prompt, and an empty subdirectory list returns an empty
record without raising the interrupt at all.

The refusal is deliberately about names the approver never saw: the
subdirectory names, the scanned directory's final component, and the
entries inside it. A symlink among the approved root's own ancestors
(`/tmp` on macOS, say) is just the caller's spelling resolving
normally — the approval names the directory that path reaches, and the
containment checks realpath through those ancestors consistently. An
attacker who can replace an ancestor of the approved root controls the
data's parent directory and is outside this (and every file effect's)
threat model.

## The frontmatter round-trip

The description is serialized with tarsec's `stringifyFrontmatter`
(tarsec 0.5.4), the encode half of the same parser `std::markdown`
wraps. Whatever it emits reads back verbatim on the next scan, so YAML
flow syntax, quotes, or backslashes in a description cannot silently
change the text a future session sees. A value the grammar cannot hold
at all fails the save cleanly instead of writing something wrong.

## Files and tests

- `stdlib/skills.agency` — the module; `lib/stdlib/skills.ts` re-exports
  the tarsec serializer as `_stringifyFrontmatter`.
- `tests/agency/skills-write.agency` — the gate, the validation, the
  overwrite race, and a serializer round-trip battery.
- `tests/agency/skills-subdirs.agency` — grouping, the one-interrupt
  property, the segment validation, and the symlink refusal, over
  `tests/agency/skills-subdirs-fixture/`.
- `lib/utils/alwaysTag.stdlib.test.ts` — `std::skills::save` is
  `@alwaysUnder(dir)` and has a row in the always-scope decision table.
