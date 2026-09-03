---
name: agency-stdlib-docs
description: Developer docs for the Agency standard library: how to add a stdlib module, writing a data connector, the S3 support, and std::agency test and testFile. Use when adding to or changing anything under stdlib/.
---

# Stdlib developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md` — The pattern for adding a stdlib module, including where files go and how docs are generated.
- `docs/dev/stdlib/data-connectors.md` — Writing a `std::data` connector that reads a public data source, and the conventions they all follow.
- `docs/dev/stdlib/aws.md` — S3 support with no AWS SDK, including the request signer and the safety contracts around it.
- `docs/dev/stdlib/grep-flags.md` — `std::grep`: why it is an in-process regex walk and not the `grep` program, the flag rule table that turns grep habits into regex flags or named parameters, and the messages a rejected flag sends back to the model.
- `docs/dev/stdlib/grep-gitignore.md` — `std::grep` skips what `.gitignore` ignores: the trace that motivated it, what the matcher covers, and why the agent toolkits lock the setting with partial application.
- `docs/dev/stdlib/github.md` — `std::github`: why it speaks REST directly, the three-source credential chain, why the token never becomes an Agency value, and the deliberate departures in its effect vocabulary.
- `docs/dev/stdlib/skills-write.md` — The `std::skills` write half: writeSkill's save gate, designSkill's review-and-redraft loop over it, the subdir scan's path-segment validation, and the frontmatter round-trip contract.
- `docs/dev/stdlib/std-agency-test.md` — `test()` and `testFile()` from `std::agency`, and the sandbox rules that are easy to get wrong.
- `docs/dev/stdlib/toolbox.md` — `std::toolbox`: tools an agent writes and keeps; the tool template, the designTool pipeline and the plain writeTool, the save gate both publish through, and runTool.
