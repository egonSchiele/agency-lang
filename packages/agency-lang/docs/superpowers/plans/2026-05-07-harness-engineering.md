# Harness Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a development harness (ESLint linter, doc restructuring, anti-pattern catalog, self-review command, CI) to mechanically enforce coding standards and reduce human review burden.

**Architecture:** Six independent components built in dependency order: doc audit first (so docs are accurate), then anti-pattern catalog and coding standards docs, then CLAUDE.md restructuring (which points to those docs), then ESLint structural linter, then CI workflow, then self-review slash command.

**Tech Stack:** ESLint 9 (flat config), @typescript-eslint/parser, GitHub Actions, Claude Code custom commands (.claude/commands/)

**Spec:** `packages/agency-lang/docs/superpowers/specs/2026-05-06-harness-engineering-design.md`

---

### Task 1: Doc Audit — High Priority Docs

Audit the high-priority docs that CLAUDE.md will point to. This is a shallow pass: verify file paths and function/class names still exist, check that overall structure matches reality. Do NOT deep-verify behavioral claims.

**Files:**
- Audit: `packages/agency-lang/docs/TESTING.md`
- Audit: `packages/agency-lang/docs/dev/typescript-ir.md`
- Audit: `packages/agency-lang/docs/dev/typechecker.md`
- Audit: `packages/agency-lang/docs/dev/interrupts.md`
- Audit: `packages/agency-lang/docs/dev/simplemachine.md`

- [ ] **Step 1: Audit `docs/TESTING.md`**

Read the file. For each file path, function name, and command mentioned, verify it exists in the current codebase using Glob/Grep. Classify as Accurate, Needs Update, or Obsolete.

- [ ] **Step 2: Audit `docs/dev/typescript-ir.md`**

Same process. Check that TsNode types, builder functions, and file paths mentioned still exist in `lib/ir/`.

- [ ] **Step 3: Audit `docs/dev/typechecker.md`**

Same process. Check that the type checker API, file paths, and function names mentioned still exist in `lib/typeChecker/`.

- [ ] **Step 4: Audit `docs/dev/interrupts.md`**

Same process. Check that interrupt-related types, functions, and file paths mentioned still exist in `lib/runtime/`.

- [ ] **Step 5: Audit `docs/dev/simplemachine.md`**

Same process. Check that SimpleMachine types, functions, and file paths mentioned still exist in `lib/simplemachine/`.

- [ ] **Step 6: Fix stale docs**

For any file classified as Needs Update, make the necessary changes. For any classified as Obsolete, flag it for removal or rewrite. Update file paths, function names, and structural descriptions to match current code.

- [ ] **Step 7: Commit**

```bash
git add docs/TESTING.md docs/dev/typescript-ir.md docs/dev/typechecker.md docs/dev/interrupts.md docs/dev/simplemachine.md
git commit -m "docs: audit and update high-priority dev docs"
```

---

### Task 2: Doc Audit — Medium and Low Priority Docs

Audit the remaining docs. Same shallow process.

**Files:**
- Audit: all remaining files in `packages/agency-lang/docs/dev/`
- Audit: `packages/agency-lang/docs/INTERRUPT_TESTING.md`, `docs/config.md`, `docs/typeChecker.md`, `docs/lifecycleHooks.md`, `docs/stateStack.md`, `docs/envFiles.md`

- [ ] **Step 1: Audit remaining `docs/dev/` files**

Read each file in `docs/dev/` not already audited in Task 1. For each, verify file paths and function/class names mentioned still exist. Classify each as Accurate, Needs Update, or Obsolete. Files: `async-info-for-claude.md`, `async.md`, `binop-parser.md`, `checkpointing.md`, `concurrent-interrupts.md`, `config.md`, `debugger.md`, `globalstore.md`, `init.md`, `locations.md`, `message-thread-tests.md`, `pkg-imports.md`, `smoltalk.md`, `statelog.md`, `threads.md`, `trace.md`.

- [ ] **Step 2: Audit top-level docs**

Same process for: `docs/INTERRUPT_TESTING.md`, `docs/config.md`, `docs/typeChecker.md`, `docs/lifecycleHooks.md`, `docs/stateStack.md`, `docs/envFiles.md`.

- [ ] **Step 3: Fix stale docs**

Update all files classified as Needs Update. Flag any Obsolete files.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: audit and update remaining dev docs"
```

---

### Task 3: Create Anti-Pattern Catalog

Create `docs/dev/anti-patterns.md` with 9 entries, each with concrete before/after code examples.

**Files:**
- Create: `packages/agency-lang/docs/dev/anti-patterns.md`

**Reference:** Review memory files at `~/.claude/projects/-Users-adityabhargava-agency-lang/memory/` for past feedback. Search the codebase for real examples where possible. Where real examples are not available, write realistic synthetic examples in the style of Agency codebase code.

- [ ] **Step 1: Write the anti-pattern catalog**

Create `docs/dev/anti-patterns.md` with all 9 entries. Each entry must follow this format:

```markdown
### [Name]

**What it looks like:** [Description]

**Bad:**
\`\`\`ts
// concrete example
\`\`\`

**Good:**
\`\`\`ts
// concrete example
\`\`\`

**Why:** [1-2 sentences]
```

The 9 entries are:
1. Unnecessary wrapper classes
2. Premature abstraction
3. Over-engineered configuration
4. Logic in the wrong layer
5. Duplicating existing code
6. Unnecessary error handling
7. Imperative code where declarative would work
8. Order-dependent mutable state
9. Leaky abstractions

- [ ] **Step 2: Review the catalog**

Read through the completed catalog. Check that each example is realistic and the before/after clearly demonstrates the problem and solution.

- [ ] **Step 3: Commit**

```bash
git add docs/dev/anti-patterns.md
git commit -m "docs: add anti-pattern catalog with 9 entries"
```

---

### Task 4: Create Coding Standards Doc

Create `docs/dev/coding-standards.md` documenting the mechanical rules that the linter will also enforce.

**Files:**
- Create: `packages/agency-lang/docs/dev/coding-standards.md`

- [ ] **Step 1: Write the coding standards doc**

Create `docs/dev/coding-standards.md`. Include:
- Use `type`, not `interface`
- Use plain objects instead of `Map`, plain arrays instead of `Set`
- No dynamic imports (`import(...)`)
- Prefer `const` over `let` when the variable is never reassigned
- Keep functions under 100 lines
- Keep files under 600 lines (with noted exceptions for large files like `typescriptBuilder.ts`)
- Keep nesting depth under 4 levels
- Push functionality into runtime libs, not the builder
- No force push or amend commits
- Use types, not interfaces

For each rule, include a one-sentence rationale.

- [ ] **Step 2: Commit**

```bash
git add docs/dev/coding-standards.md
git commit -m "docs: add coding standards reference"
```

---

### Task 5: Create Adding Features Doc

Move the "Common Tasks" section from CLAUDE.md into a dedicated doc.

**Files:**
- Create: `packages/agency-lang/docs/dev/adding-features.md`
- Reference: `CLAUDE.md` lines 129-142 (the "Common Tasks" section)

- [ ] **Step 1: Write the adding features doc**

Create `docs/dev/adding-features.md`. Copy the "Adding a new AST node type" and "Adding a CLI command" sections from CLAUDE.md. Keep them as-is — they are already well-written step-by-step guides.

- [ ] **Step 2: Commit**

```bash
git add docs/dev/adding-features.md
git commit -m "docs: add adding-features guide"
```

---

### Task 6: Restructure CLAUDE.md

Slim down the monorepo-root CLAUDE.md to be a map that points to deeper docs.

**Files:**
- Modify: `CLAUDE.md` (at monorepo root: `/Users/adityabhargava/agency-lang/CLAUDE.md`)

- [ ] **Step 1: Read the current CLAUDE.md**

Read the full file to understand what is there.

- [ ] **Step 2: Rewrite CLAUDE.md**

Keep:
- Project overview (first paragraph)
- Key commands section
- Pipeline overview (the one-liner: `parse -> SymbolTable.build -> ...`)
- Pointers to deeper docs (new section replacing the detailed descriptions)
- "CRITICAL: Handlers are safety infrastructure" section (verbatim)
- "VERY IMPORTANT: Agency syntax rules" section (verbatim)
- "General code Guidelines" section (verbatim)
- "Guidance on writing commit messages" section (verbatim)
- The note about file paths being relative to packages/agency-lang
- Testing section (keep the short version: pointer to docs/TESTING.md + the key notes about LLM calls and saving output)
- "Things that often confuse you" (keep this — it is short and important)

Remove (replaced by pointers):
- Detailed pipeline subsections (Parse, SymbolTable.build, buildCompilationUnit, preprocessor, build, Generate TypeScript code) — these are well-covered by docs/dev/ files
- "Code generation and backends" section — this guidance moves to anti-patterns (#4: logic in the wrong layer)
- "How to debug parser errors" section — keep a one-line pointer
- "Parsers" section — keep a one-line pointer
- "Typechecker" section — keep a one-line pointer to docs
- "TypeScript IR" section — keep a one-line pointer to docs
- "Templates (typestache)" section — keep a one-line pointer
- "Runtime" section with component list — keep a one-line pointer
- "Common Tasks" section — now in `docs/dev/adding-features.md`
- "Other miscellaneous things to know about" section — keep one-line pointers
- "Other docs and resources" section — fold into the new pointers section
- "docs/dev/ reference" section — fold into the new pointers section

Add a new "Deeper docs" section with pointers in this format:
```
- `docs/dev/coding-standards.md` — Banned patterns and style rules. Read before writing any new code.
- `docs/dev/anti-patterns.md` — Common mistakes with before/after examples. Read before starting a task.
- `docs/dev/adding-features.md` — Step-by-step guides for adding AST nodes, CLI commands, etc.
```

Also include pointers to the existing docs/dev/ files and top-level docs that were previously listed in the "Other docs and resources" and "docs/dev/ reference" sections.

- [ ] **Step 3: Verify nothing critical was lost**

Read the new CLAUDE.md. Check that all critical invariants (handlers, syntax rules, general guidelines) are still present. Check that every topic that was removed has a pointer to where it now lives.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: restructure CLAUDE.md as progressive disclosure map"
```

---

### Task 7: Set Up ESLint with All Rules

Install ESLint and configure all rules using built-in ESLint and @typescript-eslint rules. No custom rule files needed.

**Files:**
- Create: `packages/agency-lang/eslint.config.js`
- Modify: `packages/agency-lang/package.json` (add devDependencies and script)

- [ ] **Step 1: Install ESLint dependencies**

```bash
cd packages/agency-lang && pnpm add -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin typescript-eslint
```

- [ ] **Step 2: Create ESLint flat config with all rules**

Create `packages/agency-lang/eslint.config.js`:

```js
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "tests/**",
      "templates/**/*.ts",
      "stdlib/**/*.js",
      "node_modules/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["lib/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // Disable rules from recommended that are too noisy for this codebase
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",

      // --- Agency structural rules ---

      // Use type, not interface
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // Prefer const over let when never reassigned
      "prefer-const": "error",

      // No dynamic imports
      "no-restricted-syntax": ["error",
        {
          selector: "ImportExpression",
          message: "Dynamic imports are not allowed. Use static import statements.",
        },
        {
          selector: "NewExpression[callee.name='Map']",
          message: "Use a plain object instead of Map.",
        },
        {
          selector: "NewExpression[callee.name='Set']",
          message: "Use a plain array instead of Set.",
        },
      ],

      // Max nesting depth
      "max-depth": ["error", { max: 4 }],

      // Max function length
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],

      // Max file length
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
    },
  },
  // Per-file overrides for legitimately large files
  {
    files: [
      "lib/backends/typescriptBuilder.ts",
      "lib/parser.ts",
      // Add other legitimately large files here after running the linter
    ],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
    },
  },
];
```

- [ ] **Step 3: Add lint:structure script to package.json**

Add to the `"scripts"` section of `packages/agency-lang/package.json`:

```json
"lint:structure": "eslint lib/"
```

- [ ] **Step 4: Run the linter and review output**

```bash
cd packages/agency-lang && pnpm run lint:structure 2>&1 | head -200 > /tmp/claude/lint-output.txt
```

Review the output. Expect violations in several categories:
- `prefer-const` and `consistent-type-definitions` are auto-fixable
- `max-lines`, `max-lines-per-function`, `max-depth` are not

- [ ] **Step 5: Auto-fix what can be auto-fixed**

```bash
cd packages/agency-lang && pnpm run lint:structure --fix
```

This will fix `prefer-const` (let -> const) and `consistent-type-definitions` (interface -> type).

- [ ] **Step 6: Handle remaining violations**

Run the linter again to see what remains:

```bash
cd packages/agency-lang && pnpm run lint:structure 2>&1 > /tmp/claude/lint-output.txt
```

For each remaining violation:
- Files over 600 lines: add to the per-file overrides list in `eslint.config.js`
- Functions over 100 lines: add to per-file overrides if the file has many legitimately large functions, or add `// eslint-disable-next-line max-lines-per-function` for individual cases
- Nesting depth over 4: add `// eslint-disable-next-line max-depth` for legitimate cases
- `new Map()`/`new Set()` violations: fix manually (replace with objects/arrays)
- Dynamic imports: fix manually (replace with static imports)

- [ ] **Step 7: Verify linter passes cleanly**

```bash
cd packages/agency-lang && pnpm run lint:structure
```

Expected: 0 errors.

- [ ] **Step 8: Run existing tests to make sure fixes did not break anything**

```bash
cd packages/agency-lang && pnpm test:run 2>&1 > /tmp/claude/test-output.txt
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/agency-lang/eslint.config.js packages/agency-lang/package.json packages/agency-lang/pnpm-lock.yaml
git commit -m "feat: add ESLint structural linter with all rules"
```

If there were auto-fixed or manually fixed files:

```bash
git add -u packages/agency-lang/lib/
git commit -m "fix: resolve all structural lint violations"
```

---

### Task 8: Add GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/lint.yml` (at monorepo root)

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/lint.yml`:

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

- [ ] **Step 2: Verify the linter still passes locally**

```bash
cd packages/agency-lang && pnpm run lint:structure
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/lint.yml
git commit -m "ci: add structural lint workflow for PRs"
```

---

### Task 9: Create `/review-changes` Command

**Files:**
- Create: `.claude/commands/review-changes.md` (at monorepo root, alongside existing commands)

- [ ] **Step 1: Create the command file**

Create `.claude/commands/review-changes.md`:

```markdown
Review the current changes in this branch for violations of the project's coding standards and anti-patterns.

1. Run `git diff main` to get the full diff of changes in this branch.
2. Read `packages/agency-lang/docs/dev/anti-patterns.md` — the anti-pattern catalog.
3. Read `packages/agency-lang/docs/dev/coding-standards.md` — the coding standards.
4. Review the diff against both documents. For each violation found, report:
   - Which anti-pattern or coding standard was violated
   - The file and approximate line number
   - A specific suggested fix
5. Focus ONLY on patterns documented in those two files. Do not invent new rules.
6. Do not flag things that are clearly intentional or necessary for the context.
7. If no violations are found, report that the changes look clean.
```

- [ ] **Step 2: Test the command**

Make a small intentional violation (e.g., add a `let` that should be `const`) and run:

```
/review-changes
```

Verify it catches the violation and reports it clearly. Then revert the test change.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/review-changes.md
git commit -m "feat: add /review-changes slash command"
```

---

### Task 10: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full linter**

```bash
cd packages/agency-lang && pnpm run lint:structure
```

Expected: passes cleanly with 0 errors.

- [ ] **Step 2: Run the full test suite**

```bash
cd packages/agency-lang && pnpm test:run 2>&1 > /tmp/claude/test-output.txt
```

Expected: all existing tests pass.

- [ ] **Step 3: Verify CLAUDE.md is shorter and complete**

Read `CLAUDE.md`. Verify:
- It is significantly shorter than the original
- All critical invariants are present (handlers, syntax rules, general guidelines)
- Every removed section has a pointer to where it now lives
- Pointers to `docs/dev/anti-patterns.md`, `docs/dev/coding-standards.md`, and `docs/dev/adding-features.md` are present

- [ ] **Step 4: Verify anti-pattern catalog is complete**

Read `docs/dev/anti-patterns.md`. Verify all 9 entries have concrete before/after examples.

- [ ] **Step 5: Verify /review-changes works**

Run `/review-changes` and verify it produces coherent output.
