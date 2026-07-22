---
title: Linting
description: Documents the `agency lint` command for reporting style and hygiene findings such as unused imports, including its exit-code policy and what the editor does with the same findings.
---

# Linting

To lint one or more Agency files:

```
agency lint foo.agency
agency lint src/
```

Arguments may be files, directories (scanned recursively for `.agency` files), or a mix of both. If no input is given, the linter reads from stdin.

Findings are printed per file, with a 1-indexed line and column and a stable `AL####` code:

```
main.agency
  1:10  AL0001  'now' is imported but never used.

Run `agency explain <code>` for details.
```

Every code has a long-form explanation: run `agency explain AL0001`, or see the [diagnostics reference](/diagnostics/lint).

## Lint findings are not errors

The linter reports style and hygiene notices — things worth cleaning up, not things that are wrong. A file with lint findings still compiles and runs. This is the same split every mature ecosystem draws: the type checker (`agency tc`) answers "is this program correct?", the linter answers "is this program tidy?".

Because of that, `agency lint` **exits 0 on hint-level findings**, so putting it in CI reports findings without failing the build. If a future rule ships at `warning` severity or above, findings at that level will fail the run.

## What the rules skip

- **Auto-imported prelude names.** Every Agency file gets the `std::index` prelude (`print`, `map`, `range`, …) without importing it, so `std::index` imports are never reported.
- **Test-only imports.** `import test { … }` exists for the test harness; its names are expected to look unused in a normal compile.

## The same findings in your editor

The [language server](/cli/editor-integration) surfaces the same findings: unused imports render grayed out, and the lightbulb menu offers "Remove unused import" per name plus a "Remove all unused imports" batch action. See [editor integration](/cli/editor-integration#remove-unused-imports-on-save) for removing them automatically on save.
