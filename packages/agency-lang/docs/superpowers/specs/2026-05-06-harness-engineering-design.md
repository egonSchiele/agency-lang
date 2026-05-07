# Harness Engineering Design Spec

## Problem

Claude currently writes code that frequently requires manual review for:
- **Structural violations**: using `interface` instead of `type`, `new Map()`/`new Set()` instead of objects/arrays, dynamic imports
- **Over-engineering**: unnecessary abstractions, wrapper classes, premature generalization, helpers for one-time operations

These rules exist as prose in CLAUDE.md (at the monorepo root: `/agency-lang/CLAUDE.md`) but are not mechanically enforced. The result is that every PR needs careful human review, which is slow and tedious.

Note: There is no existing ESLint configuration in this project. This spec introduces ESLint fresh.

## Goal

Build a harness — a set of mechanical checks, documentation, and feedback loops — that catches common violations automatically, reducing the amount of human review needed.

## Components

The harness consists of 6 components:

1. Structural linter (ESLint custom rules)
2. CLAUDE.md restructuring (progressive disclosure)
3. Anti-pattern catalog (seeded from past feedback)
4. Self-review skill (`/review-changes`)
5. CI (GitHub Actions)
6. Doc audit (verify `docs/dev/` accuracy)

---

## 1. Structural Linter

### Overview

An ESLint setup with `@typescript-eslint/parser` using built-in rules and `no-restricted-syntax` for Agency-specific checks. No custom rule files needed. Run via `pnpm run lint:structure`.

### Setup

- Add `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, and `typescript-eslint` as dev dependencies
- ESLint config at `packages/agency-lang/eslint.config.js` (flat config format)
- Add `"lint:structure": "eslint lib/"` to `package.json` scripts

### Rules

All rules use built-in ESLint or @typescript-eslint rules. No custom rule files.

| Rule | ESLint Rule | Auto-fixable? |
|------|-------------|---------------|
| No interfaces | `@typescript-eslint/consistent-type-definitions: ["error", "type"]` | Yes |
| No `new Map()`/`new Set()` | `no-restricted-syntax` with AST selectors | No |
| No dynamic imports | `no-restricted-syntax` with `ImportExpression` selector | No |
| Max nesting depth (4) | `max-depth: ["error", { max: 4 }]` | No |
| Max function lines (100) | `max-lines-per-function: ["error", { max: 100 }]` | No |
| Prefer const | `prefer-const: "error"` | Yes |
| Max file lines (600) | `max-lines: ["error", { max: 600 }]` | No |

Per-file overrides in the ESLint config allow legitimately large files (e.g., `typescriptBuilder.ts`, `parser.ts`) to exceed the line limits.

### Excluded from linting

- `dist/`
- `node_modules/`
- `tests/`
- `templates/**/*.ts` (generated from Mustache)
- `stdlib/**/*.js` (compiled output)

---

## 2. CLAUDE.md Restructuring

### Overview

Restructure the monorepo-root CLAUDE.md (`/agency-lang/CLAUDE.md`) to be significantly shorter, focusing it as a map that points to deeper docs. Target: remove all content that is better served by a pointer to a dedicated doc. The goal is progressive disclosure, not a specific line count.

### What stays in CLAUDE.md

- Project overview (one paragraph)
- Key commands (build, test, run)
- Pipeline overview (one-liner)
- Pointers to deeper docs (see below)
- Critical invariants that must always be in context:
  - Handlers are safety infrastructure
  - Agency syntax rules (the "correct syntax" / "common mistakes" section)
- General code guidelines (one-liners: no dynamic imports, types not interfaces, etc.)
- Commit message guidance (use files, no apostrophes on CLI)

### What moves out

| Content | Moves to |
|---------|----------|
| Detailed pipeline section | Already exists in `docs/dev/` files |
| "Common Tasks" (adding AST nodes, CLI commands) | `docs/dev/adding-features.md` |
| "Things that often confuse you" | `docs/dev/anti-patterns.md` |
| Detailed component descriptions (parsers, templates, runtime, etc.) | Already covered by existing `docs/dev/*.md` |

### New docs created

| File | Content |
|------|---------|
| `docs/dev/coding-standards.md` | Banned patterns, style rules (the mechanical rules also enforced by the linter) |
| `docs/dev/adding-features.md` | Step-by-step for common tasks: adding a new AST node type, adding a CLI command |
| `docs/dev/anti-patterns.md` | See Component 3 below |

### CLAUDE.md pointer format

Each pointer in CLAUDE.md should be a brief description of what the doc covers and when to read it. Example:

```
- `docs/dev/coding-standards.md` — Banned patterns and style rules. Read before writing any new code.
- `docs/dev/anti-patterns.md` — Common mistakes with before/after examples. Read before starting a task.
- `docs/dev/adding-features.md` — Step-by-step guides for adding AST nodes, CLI commands, etc. Read when doing these tasks.
```

---

## 3. Anti-Pattern Catalog

### Overview

A new file at `docs/dev/anti-patterns.md` documenting specific mistakes Claude makes, with concrete before/after examples. Seeded from past conversation history and memory files.

### Format

Each entry follows this structure:

```markdown
### [Name]

**What it looks like:** [Description of the mistake]

**Bad:**
```ts
// concrete bad example
```

**Good:**
```ts
// concrete good example
```

**Why:** [One or two sentences on why the good version is better]
```

### Initial entries

#### 1. Unnecessary wrapper classes
Creating a class to wrap simple data or a thin layer over an existing API when a plain object or direct usage would suffice.

#### 2. Premature abstraction
Extracting a helper, utility, or shared function for something that is only used once. Three similar lines of code is better than a premature abstraction.

#### 3. Over-engineered configuration
Adding options, flags, or configurability for things that only have one use case. Build for the current need, not hypothetical future requirements.

#### 4. Logic in the wrong layer
Putting functionality in the builder/codegen that should live in the runtime (where it is testable, type-safe, and reusable). The builder should generate code that calls runtime functions, not inline complex logic.

#### 5. Duplicating existing code
Reimplementing something that already exists in the codebase instead of finding and reusing it. Always search for existing implementations before writing new code.

#### 6. Unnecessary error handling
Validating things that cannot happen, adding fallbacks for impossible states, wrapping in try-catch internally when the framework already handles it. Trust internal code and framework guarantees.

#### 7. Imperative code where declarative would work
Writing long sequences of imperative steps when the intent could be expressed declaratively. Imperative code should be encapsulated and hidden behind a clean declarative interface. The caller should be able to say *what* they want, not *how* to do it.

#### 8. Order-dependent mutable state
Code where multiple variables must be set in a specific sequence to work correctly. This is fragile — reordering lines breaks things silently. Prefer designs where each piece of state is self-contained, or where the dependency is made explicit through function parameters or return values.

#### 9. Leaky abstractions
Code where understanding one piece requires reading many other pieces because they are all connected. Good abstractions have clear boundaries — you can understand what a unit does without reading its internals, and you can change the internals without breaking consumers.

### Seeding from conversation history

During implementation, review the conversation memory files at `~/.claude/projects/-Users-adityabhargava-agency-lang/memory/` and past review feedback to find concrete code examples for each anti-pattern. Where real examples from the codebase can be found, use them. Where they cannot, write realistic synthetic examples in the style of the Agency codebase — these can be replaced with real ones as they are encountered in future reviews.

### Maintenance

This is a living document. When a new anti-pattern is caught in review, add an entry. If an anti-pattern can be mechanically checked, promote it to an ESLint rule.

---

## 4. Self-Review Skill

### Overview

A new skill (slash command) `/review-changes` that reviews the current diff against the anti-patterns catalog and coding standards.

### Location

Project-local Claude Code command at `.claude/commands/review-changes.md`. Claude Code supports custom slash commands via markdown files in this directory — the filename becomes the command name, and the file content becomes the prompt.

### Behavior

When invoked, the skill:

1. Gets the current diff against `main` (staged + unstaged changes)
2. Reads `docs/dev/anti-patterns.md`
3. Reads `docs/dev/coding-standards.md`
4. Reviews the diff against both documents
5. Reports any violations found:
   - Which anti-pattern was triggered
   - Where in the diff (file and line)
   - Suggested fix
6. If no violations found, reports that the changes look clean

### Prompt template

The skill prompt should instruct Claude to:
- Focus only on the patterns documented in the anti-patterns and coding standards files
- Not invent new rules beyond what is documented
- Be specific about locations and fixes
- Not flag things that are clearly intentional or necessary

---

## 5. CI (GitHub Actions)

### Overview

A GitHub Actions workflow that runs the structural linter on every PR to `main`.

### Workflow file

`.github/workflows/lint.yml` (at the monorepo root: `agency-lang/.github/workflows/lint.yml`)

### Configuration

```yaml
name: Structural Lint

on:
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint:structure
        working-directory: packages/agency-lang
```

### Behavior

- Runs on every PR to `main`
- Runs only the mechanical ESLint checks
- Fails the PR if any violations are found
- No Claude-based review in CI (that is handled locally via `/review-changes`)

---

## 6. Doc Audit

### Overview

Before restructuring CLAUDE.md, audit all existing files in `docs/dev/` for staleness. Many were written at various points during development and may no longer reflect the actual code.

### Process

The audit is a shallow pass, not a deep verification of every behavioral claim. For each file:

1. Verify that file paths and function/class names mentioned still exist
2. Check that the overall structure described still matches reality
3. Do NOT deep-verify behavioral claims or re-test examples

Classify each file as:
- **Accurate** — no changes needed
- **Needs update** — file paths, function names, or structure is stale
- **Obsolete** — content no longer reflects reality, remove or rewrite

Fix stale docs, then proceed with CLAUDE.md restructuring.

### Priority

Audit in priority order. The docs that CLAUDE.md will point to are highest priority:
1. **High** (CLAUDE.md will point to these): `docs/TESTING.md`, `docs/dev/typescript-ir.md`, `docs/dev/typechecker.md`, `docs/dev/interrupts.md`, `docs/dev/simplemachine.md`
2. **Medium** (referenced from other docs): remaining `docs/dev/` files
3. **Low** (rarely referenced): `docs/dev/init.md`, `docs/dev/locations.md`, `docs/dev/message-thread-tests.md`

If time is limited, complete only the High priority tier before proceeding with CLAUDE.md restructuring. Medium and Low can be done incrementally.

### Files to audit

All files in `docs/dev/`:
- `async-info-for-claude.md`
- `async.md`
- `binop-parser.md`
- `checkpointing.md`
- `concurrent-interrupts.md`
- `config.md`
- `debugger.md`
- `globalstore.md`
- `init.md`
- `interrupts.md`
- `locations.md`
- `message-thread-tests.md`
- `pkg-imports.md`
- `simplemachine.md`
- `smoltalk.md`
- `statelog.md`
- `threads.md`
- `trace.md`
- `typechecker.md`
- `typescript-ir.md`

Also audit top-level docs:
- `docs/TESTING.md`
- `docs/INTERRUPT_TESTING.md`
- `docs/config.md`
- `docs/typeChecker.md`
- `docs/lifecycleHooks.md`
- `docs/stateStack.md`
- `docs/envFiles.md`

---

## Implementation Order

1. **Doc audit** — Must happen first so the docs we point to are accurate
2. **Anti-pattern catalog** — Create `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`
3. **CLAUDE.md restructuring** — Slim down CLAUDE.md, point to the new docs
4. **Structural linter** — Set up ESLint, implement custom rules
5. **CI** — Add GitHub Actions workflow
6. **Self-review skill** — Create `/review-changes`

Rationale: Docs first because everything else depends on them being accurate. Linter before CI because we need to verify rules work locally before enforcing in CI. Self-review skill last because it depends on the anti-patterns and coding standards docs existing.

---

## Existing Violations Strategy

When the linter is first enabled, there will likely be existing violations in the codebase. Strategy:

1. Run `pnpm run lint:structure` on the current codebase
2. Fix all violations that are straightforward (e.g., `interface` → `type`)
3. For legitimate exceptions (files that must exceed the line limit), add per-file ESLint config overrides
4. The linter must pass cleanly before the CI workflow is enabled — no baseline file or grandfathered violations

---

## Success Criteria

- `pnpm run lint:structure` passes cleanly on the current codebase with clear remediation messages for any new violations
- CLAUDE.md is shorter and points to accurate, up-to-date docs via progressive disclosure
- Anti-pattern catalog has concrete before/after examples for each entry
- `/review-changes` produces actionable output when run against a diff
- CI blocks PRs with structural violations
- Human review time per PR is meaningfully reduced
