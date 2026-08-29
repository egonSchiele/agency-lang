---
name: agency-stdlib-docs
description: Developer docs for the Agency standard library: how to add a stdlib module, writing a data connector, the S3 support, and std::agency test and testFile. Use when adding to or changing anything under stdlib/.
---

# Stdlib developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md` — The pattern for adding a stdlib module, including where files go and how docs are generated.
- `docs/dev/stdlib/data-connectors.md` — Writing a `std::data` connector that reads a public data source, and the conventions they all follow.
- `docs/dev/stdlib/aws.md` — S3 support with no AWS SDK, including the request signer and the safety contracts around it.
- `docs/dev/stdlib/std-agency-test.md` — `test()` and `testFile()` from `std::agency`, and the sandbox rules that are easy to get wrong.
- `docs/dev/stdlib/toolbox.md` — `std::toolbox`: tools an agent writes and keeps; the tool template, the writeTool pipeline, the review interrupt, and runTool.
