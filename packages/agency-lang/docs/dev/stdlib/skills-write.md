# The `std::skills` write half

`std::skills` started as a read-only module: `skillsDir` serves a directory
of markdown skills to an LLM. It now also has a write half, added as the
first piece of the agency agent's learned-skills feature:

- `writeSkill(dir, name, description, body)` saves one flat-layout skill
  file, behind a `std::skills::save` interrupt.
- `scanSkillsSubdirs(root, subdirs)` scans named subdirectories of one
  root — the learned-skills layout is one subdirectory per agent — and
  returns the entries grouped by subdirectory name.
- `skillsToolFromEntries(dir, entries, name)` is the pure build half of
  `buildSkillsTool`: no reads, no interrupts, so a caller holding entries
  can rebuild a skills tool without rescanning. `skillsDir` itself now
  goes through the same `scanEntries` pipeline, so the scanning and the
  tool-building halves cannot drift apart.

## The save gate

Nothing is written without the responder seeing the complete file —
frontmatter and body — in the interrupt data. An approval writes the
file; a rejection fails the call. The interrupt deliberately has no
answer shape: any approval saves, and data carried on the approval is
not consulted. `writeSkill` is the plain primitive for saving a skill
that is already final; the interactive draft-revise-accept loop is a
separate function (`designSkill`, planned), which will call `writeSkill`
so the save stays gated even at the end of a design session.

The duplicate check runs twice, in two different forms. Before the
interrupt, an `exists` check refuses a taken name without prompting
anyone. At the save point, the write itself uses `create-only` mode,
because the pre-interrupt check is stale by then — approval can take
arbitrarily long, and a file created in the meantime must never be
overwritten.

## The trust argument for the subdir scan

`scanSkillsSubdirs` raises one `std::skills::skillsDir` interrupt for the
root, and that single approval covers the interrupt-free reads
(`_glob` / `_read`) of everything underneath — the same one-scan-interrupt
pattern `skillsDir` uses. That is exactly why every subdirectory name is
validated before the interrupt is raised: a name must be a bare path
segment (no separators, no `..`, not empty), or the approval the user
gave for `root` would be carried somewhere else. `__proto__`,
`constructor`, and `prototype` are also refused — they would be
inherited-property keys on the result record, not data.

## The frontmatter round-trip

The description is serialized with tarsec's `stringifyFrontmatter`
(tarsec 0.5.4), the encode half of the same parser `std::markdown`
wraps. Whatever it emits reads back verbatim on the next scan, so YAML
flow syntax, quotes, or backslashes in a description cannot silently
corrupt the file or change the text a future session sees. A value the
grammar cannot hold at all fails the save cleanly instead of writing
something wrong.

## Files and tests

- `stdlib/skills.agency` — the module; `lib/stdlib/skills.ts` re-exports
  the tarsec serializer as `_stringifyFrontmatter`.
- `tests/agency/skills-write.agency` — the gate, the validation, the
  overwrite race, and a serializer round-trip battery.
- `tests/agency/skills-subdirs.agency` — grouping, the one-interrupt
  property, and the segment validation, over
  `tests/agency/skills-subdirs-fixture/`.
- `lib/utils/alwaysTag.stdlib.test.ts` — `std::skills::save` is
  `@alwaysUnder(dir)` and has a row in the always-scope decision table.
