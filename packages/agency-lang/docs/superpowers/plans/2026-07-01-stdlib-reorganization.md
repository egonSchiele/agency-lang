# Standard Library Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the flat ~48-module Agency stdlib into capability-grouped, prefixed modules — merging coupled modules, folding the validation trio, and grouping generic-named modules under `ui/`, `auth/`, `messaging/`, and `web/` — via a hard cutover with no back-compat aliases.

**Architecture:** Agency resolves `std::X` to `<stdlib>/X.agency` (via `normalizeStdlibPath` + `path.join`) and emits `agency-lang/stdlib/X.js` for compiled TS. Both already handle `/` subpaths (`std::agency/eval` works today), the `./stdlib/*` package export is a wildcard that covers nested `.js`, and `agency compile stdlib/` + `agency doc` already recurse into subdirectories. So the reorg is mostly (a) moving `.agency` source files into subdirs, (b) rewriting every `std::` reference across source/tests/docs, and (c) one code fix to make stdlib *enumeration* (`getStdlibFiles`, used only by LSP) recursive and subpath-aware. The `.js` files are generated — we delete stale ones and regenerate with `make`.

**Tech Stack:** TypeScript (compiler/LSP in `lib/`), Agency source (`stdlib/*.agency`), Make build (`make`, `make stdlib`, `make doc`, `make fixtures`), Vitest, VitePress docs.

## Global Constraints

- **Hard cutover, NO deprecation/alias window.** Old `std::` paths must stop working; every reference is rewritten in the same change. (Retrofitting is impossible-without-breakage; a clean break was the explicit decision.)
- **`stdlib-lib/` TS backing does NOT move — but its embedded `std::` strings DO change.** Stdlib `.agency` files import their TS helpers via `agency-lang/stdlib-lib/<name>.js` (a *separate* namespace from `std::`); those files and directories (e.g. `lib/stdlib/layout/`) stay exactly where they are. However, many of them **embed the old `std::` path in user-facing content**: thrown error messages (e.g. `throw new Error("std::chart: bar …")`, `std::layout.table: cell must be …`) and comments (e.g. `// std::layout — table renderer`, `lib/stdlib/threads.ts` comments). The *path token* inside those strings must be updated to the new path (`std::chart`→`std::ui/chart`, `std::layout`→`std::ui/layout`, `std::layout.table`→`std::ui/layout.table`), even though the file does not move. **User-facing throw/label strings MUST update** (they surface to users and appear in tool descriptions); **incidental comments SHOULD update** for accuracy. There are ~44 such references under `lib/` (including `lib/**/*.test.ts`) — see Tasks 1–7.
- **Leftover greps include `lib`.** Every per-task and final leftover scan searches `stdlib lib tests docs` (not just `stdlib lib tests docs`), so `lib/` strings are caught by the task that owns them instead of piling up for Task 9. `lib/` source contains no `dist/`, so no extra filter is needed there.
- **Generated `.js` are never hand-edited.** After moving/merging `.agency` sources, run `make stdlib` (or `make`) to regenerate. Delete stale `.js` with `git rm`.
- **Always run `make` after changing stdlib files** (per CLAUDE.md).
- **Naming is singular case-by-case, not dogmatic.** `validators`→`validation`; but `capabilities` stays plural, `skills` stays plural, `wikipedia`/`weather` stay flat.
- **Never force-push or amend commits. Never use dynamic imports.**
- **Commit messages / PR bodies go in a file**, then `git commit -F <file>` (apostrophes on the CLI break).
- **Do not run the full agency test suite locally** (slow/expensive) — CI runs it. Run targeted tests and the build as gates. Save any test output to a file.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Authoritative path mapping (source of truth for every rewrite)

| Old `std::` path | New `std::` path | Operation |
|---|---|---|
| `std::threads` | `std::thread` | **merge** into thread (delete `threads.agency` + `threads.js`) |
| `std::types` | `std::validation` | **fold** |
| `std::schemas` | `std::validation` | **fold** |
| `std::validators` | `std::validation` | **fold** |
| `std::layout` | `std::ui/layout` | move |
| `std::table` | `std::ui/table` | move |
| `std::chart` | `std::ui/chart` | move |
| `std::cli` | `std::ui/cli` | move |
| `std::keyring` | `std::auth/keyring` | move |
| `std::oauth` | `std::auth/oauth` | move |
| `std::email` | `std::messaging/email` | move |
| `std::sms` | `std::messaging/sms` | move |
| `std::imessage` | `std::messaging/imessage` | move |
| `std::search` | `std::web/search` | move |
| `std::browser` | `std::web/browser` | move |

**Unchanged** (stay flat / keep name): `std::index`, `std::thread` (merge target), `std::llm`, `std::memory`, `std::strategy`, `std::concurrency`, `std::agent`, `std::policy`, `std::capabilities`, `std::statelog`, `std::array`, `std::object`, `std::math`, `std::date`, `std::path`, `std::http`, `std::fs`, `std::shell`, `std::system`, `std::clipboard`, `std::calendar`, `std::speech`, `std::skills`, `std::markdown`, `std::syntax`, `std::wikipedia`, `std::weather`, `std::agency`, `std::agency/eval`, `std::agency/local`.

**Note on `std::ui`:** the file `stdlib/ui.agency` (interactive widgets, `std::ui`) coexists with the new directory `stdlib/ui/` (`std::ui/layout`, etc.), exactly like Go's `net` + `net/http`. `stdlib/ui.agency` stays put; only its cross-references to `layout`/`table` change.

**Rewrite covers BOTH forms:** real import strings (`from "std::table"`) *and* references inside doc-comment examples and prose (`` `std::table` ``, `import { ... } from "std::table"` inside `"""..."""` docstrings). Docstrings become generated docs and LLM tool descriptions, so they must be correct.

---

## Task 0: Make stdlib enumeration recursive and subpath-aware (tooling)

This is independent of any file move and must land first so LSP autocomplete/code-actions keep working (and start surfacing subdir modules) once files move. `getStdlibFiles()` currently does a non-recursive `readdirSync` and its two LSP callers derive module names as `"std::" + basename`, which is wrong for subdir modules.

**Files:**
- Modify: `lib/importPaths.ts` (`getStdlibFiles`, ~line 99)
- Modify: `lib/lsp/completion.ts:235`
- Modify: `lib/lsp/codeAction.ts:21`
- Test: `lib/importPaths.test.ts`

**Interfaces:**
- Produces: `getStdlibFiles(): string[]` — now returns absolute paths of **all** `.agency` files under the stdlib dir, recursively.
- Produces: helper `stdlibModuleName(absPath: string): string` in `lib/importPaths.ts` — maps an absolute stdlib file path to its `std::`-qualified module name using the path relative to the stdlib dir, POSIX-separated, sans `.agency` (e.g. `.../stdlib/ui/table.agency` → `"std::ui/table"`).

- [ ] **Step 1: Write the failing test**

Add to `lib/importPaths.test.ts`:

```ts
import { getStdlibFiles, stdlibModuleName, getStdlibDir } from "./importPaths.js";
import * as path from "path";

describe("getStdlibFiles recursion", () => {
  it("includes modules nested in subdirectories", () => {
    const files = getStdlibFiles();
    const rels = files.map((f) => path.relative(getStdlibDir(), f));
    expect(rels).toContain(path.join("agency", "eval.agency"));
    expect(rels).toContain("array.agency");
  });

  it("stdlibModuleName qualifies subdir paths with std:: and forward slashes", () => {
    const abs = path.join(getStdlibDir(), "agency", "eval.agency");
    expect(stdlibModuleName(abs)).toBe("std::agency/eval");
    expect(stdlibModuleName(path.join(getStdlibDir(), "array.agency"))).toBe("std::array");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/importPaths.test.ts -t "recursion" 2>&1 | tee /tmp/reorg-task0.log`
Expected: FAIL — `stdlibModuleName` is not exported / not defined, and (before the fix) `getStdlibFiles` omits `agency/eval.agency`.

- [ ] **Step 3: Implement recursive enumeration + `stdlibModuleName`**

In `lib/importPaths.ts`, replace the body of `getStdlibFiles` and add `stdlibModuleName`:

```ts
/**
 * Returns all .agency files in the stdlib directory (recursively) as
 * absolute paths.
 */
export function getStdlibFiles(): string[] {
  const dir = getStdlibDir();
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".agency")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Map an absolute stdlib .agency file path to its `std::`-qualified module
 * name (POSIX-separated, no extension). e.g. `<stdlib>/ui/table.agency`
 * -> `std::ui/table`.
 */
export function stdlibModuleName(absPath: string): string {
  const rel = path.relative(getStdlibDir(), absPath).replace(/\.agency$/, "");
  return "std::" + rel.split(path.sep).join("/");
}
```

- [ ] **Step 4: Update the two LSP callers to use `stdlibModuleName`**

In `lib/lsp/completion.ts`, change line ~235 from
`stdlibModules = getStdlibFiles().map((f) => "std::" + path.basename(f, ".agency"));`
to:

```ts
stdlibModules = getStdlibFiles().map((f) => stdlibModuleName(f));
```

and add `stdlibModuleName` to the existing `import { getStdlibFiles } from "../importPaths.js";`.

In `lib/lsp/codeAction.ts` (~line 21), the loop `for (const filePath of getStdlibFiles())` derives a module name to insert into an import — replace its `"std::" + path.basename(filePath, ".agency")` construction with `stdlibModuleName(filePath)` (import the helper). Read the surrounding block first and preserve the rest of the logic.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run lib/importPaths.test.ts 2>&1 | tee /tmp/reorg-task0.log`
Expected: PASS. Also run `pnpm exec vitest run lib/lsp/ 2>&1 | tee -a /tmp/reorg-task0.log` — expect no regressions.

- [ ] **Step 6: Commit**

```bash
git add lib/importPaths.ts lib/importPaths.test.ts lib/lsp/completion.ts lib/lsp/codeAction.ts
git commit -F /tmp/reorg-commit0.txt
```
(`/tmp/reorg-commit0.txt` = `feat(stdlib): recursive, subpath-aware stdlib enumeration for LSP` + trailer.)

---

## Task 1: Merge `std::threads` into `std::thread`

**Files:**
- Modify: `stdlib/thread.agency` (absorb threads' content)
- Delete: `stdlib/threads.agency`, `stdlib/threads.js`
- Rewrite refs: any `std::threads` → `std::thread`

**Interfaces:**
- Produces: `std::thread` now additionally exports `ThreadMessage`, `ThreadInfo`, `listThreads`, `currentThreadId`, `getThread` (plus the pre-existing `systemMessage`, `userMessage`, `assistantMessage`, `getCost`, `getTokens`, `ModelCost`, `getModelCosts`, `GuardFailureData`, `guard`).

- [ ] **Step 1: Read both files**

Read `stdlib/thread.agency` and `stdlib/threads.agency` in full so the merge preserves every declaration and doc comment verbatim.

- [ ] **Step 2: Merge threads → thread**

In `stdlib/thread.agency`:
1. Prepend/merge the `threads.agency` `@module` doc comment (cross-thread registry) into `thread.agency`'s header so the combined module documents both current-thread and cross-thread behavior.
2. Add threads' node-import block verbatim (the `import { ... } from "agency-lang/stdlib-lib/threads.js"` at `threads.agency:36-41`) — a single `.agency` file may import from multiple `stdlib-lib` backings.
3. Append threads' exported declarations verbatim: `type ThreadMessage`, `type ThreadInfo`, `def listThreads`, `def currentThreadId`, `def getThread`, and any internal `summarize`/`summaryFor` helpers.
4. Inside any moved docstring example that reads `import { listThreads, getThread } from "std::threads"`, change it to `from "std::thread"`.

- [ ] **Step 3: Delete the old files**

```bash
git rm stdlib/threads.agency stdlib/threads.js
```

- [ ] **Step 4: Rewrite remaining `std::threads` references repo-wide**

```bash
grep -rn '"std::threads"\|`std::threads`\|std::threads\b' stdlib lib tests docs --include=*.agency --include=*.ts --include=*.md
```
Replace every hit (import strings, docstrings, prose) `std::threads` → `std::thread`. **`lib/` hits to update in place** (file stays, content changes): `lib/stdlib/threads.ts:20` and `:103` — comments referencing `std::threads`. Do NOT rename the `lib/stdlib/threads.ts` backing file itself.

- [ ] **Step 5: Rebuild and verify**

Run: `make stdlib 2>&1 | tee /tmp/reorg-task1.log`
Expected: builds clean; `stdlib/thread.js` regenerated; no `stdlib/threads.js`. Then:
```bash
grep -rn "std::threads" stdlib lib tests docs && echo "LEFTOVERS FOUND" || echo "clean"
```
Expected: `clean`.

If there is a targeted thread test (`ls tests/agency/**/thread*`), run it and save output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -F /tmp/reorg-commit1.txt
```
(`refactor(stdlib): merge std::threads into std::thread` + trailer.)

---

## Task 2: Fold `std::types` + `std::schemas` + `std::validators` into `std::validation`

**Files:**
- Create: `stdlib/validation.agency`
- Delete: `stdlib/types.agency`, `stdlib/schemas.agency`, `stdlib/validators.agency` and their `.js`
- Rewrite refs: `std::types` / `std::schemas` / `std::validators` → `std::validation`

**Interfaces:**
- Produces: `std::validation` exports — validators `isEmail`, `isUrl`, `isUuid`, `isInt`, `isPositive`, `isNegative`, `min`, `max`, `minLength`, `maxLength`, `matches`; schema fragments `emailFormat`, `urlFormat`, `uuidFormat`, `dateTimeFormat`, `dateFormat`, `ipv4Format`, `ipv6Format`; type aliases `Email`, `URLString`, `UUIDString`, `NumberInRange`, `StringWithLength`, `MatchesPattern`, `BoundedArray`.

- [ ] **Step 1: Read all three files**

Read `stdlib/validators.agency`, `stdlib/schemas.agency`, `stdlib/types.agency` in full.

- [ ] **Step 2: Compose `stdlib/validation.agency`**

Create `stdlib/validation.agency` with this structure (bodies copied verbatim from the sources):
1. A `@module` doc comment describing the combined validation surface (validators + schema fragments + opaque validated types).
2. The validators node-import verbatim: `import { _isEmail, _isUrl, _isUuid, _isInt, _isPositive, _isNegative, _min, _max, _minLength, _maxLength, _matches } from "agency-lang/stdlib-lib/validators.js"`.
3. All `export safe def` validator functions from `validators.agency` (verbatim).
4. All schema-fragment `export const` values from `schemas.agency` (verbatim). `schemas.agency` has no imports.
5. All `export type` aliases from `types.agency` (verbatim). **Remove** its two top-of-file imports (`from "std::validators"` and `from "std::schemas"`) — those symbols are now defined in the same file.
6. Update any docstring examples inside these declarations that referenced `std::types`/`std::schemas`/`std::validators` to `std::validation`.

- [ ] **Step 3: Delete the old files**

```bash
git rm stdlib/types.agency stdlib/types.js stdlib/schemas.agency stdlib/schemas.js stdlib/validators.agency stdlib/validators.js
```

- [ ] **Step 4: Rewrite references repo-wide**

```bash
grep -rn 'std::types\b\|std::schemas\b\|std::validators\b' stdlib lib tests docs --include=*.agency --include=*.ts --include=*.md
```
Replace all three old paths → `std::validation` in import strings, docstrings, and prose. **`lib/` hits to update** (real import strings inside `lib/`-local test files that a `tests/`-only sweep would miss): `lib/backends/typescriptBuilder.integration.test.ts:320,345,361,377` (`from "std::validators"`) and `lib/cli/doc.test.ts:440` (`from "std::validators"`). These are snapshot/fixture expectations — update them to `std::validation` and re-run those tests in Step 5.

- [ ] **Step 5: Rebuild and verify**

Run: `make stdlib 2>&1 | tee /tmp/reorg-task2.log`
Expected: clean build; `stdlib/validation.js` exists; the three old `.js` gone.
```bash
grep -rn "std::types\b\|std::schemas\b\|std::validators\b" stdlib lib tests docs && echo "LEFTOVERS" || echo "clean"
```
Expected: `clean`. Run any `tests/**/validat*` or `types*` targeted test and save output.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -F /tmp/reorg-commit2.txt
```
(`refactor(stdlib): fold types+schemas+validators into std::validation` + trailer.)

---

## Task 3: Group UI modules under `std::ui/`

Move `layout`, `table`, `chart`, `cli` into `stdlib/ui/`. `stdlib/ui.agency` (`std::ui` root) stays.

**Files:**
- Move: `stdlib/layout.agency`→`stdlib/ui/layout.agency`; `table.agency`→`ui/table.agency`; `chart.agency`→`ui/chart.agency`; `cli.agency`→`ui/cli.agency`
- Delete stale: `stdlib/layout.js`, `stdlib/table.js`, `stdlib/chart.js`, `stdlib/cli.js`
- Rewrite refs per mapping table.

- [ ] **Step 1: Move source files**

```bash
mkdir -p stdlib/ui
git mv stdlib/layout.agency stdlib/ui/layout.agency
git mv stdlib/table.agency  stdlib/ui/table.agency
git mv stdlib/chart.agency  stdlib/ui/chart.agency
git mv stdlib/cli.agency    stdlib/ui/cli.agency
git rm stdlib/layout.js stdlib/table.js stdlib/chart.js stdlib/cli.js
```

- [ ] **Step 2: Rewrite references repo-wide**

```bash
grep -rn 'std::layout\b\|std::table\b\|std::chart\b\|std::cli\b' stdlib lib tests docs --include=*.agency --include=*.ts --include=*.md
```
Apply, in import strings + docstrings + prose:
- `std::layout` → `std::ui/layout`
- `std::table` → `std::ui/table`
- `std::chart` → `std::ui/chart`
- `std::cli` → `std::ui/cli`

Known in-stdlib hits to confirm updated: `stdlib/ui/chart.agency` (`from "std::layout"`, self `std::chart`), `stdlib/ui/table.agency` (`from "std::layout"`, self `std::table`), `stdlib/policy.agency` (`from "std::layout"`, `from "std::table"`), `stdlib/ui.agency` (docstring `std::ui`/`std::policy` unaffected; verify no `std::layout`), `stdlib/ui/cli.agency` (`from "std::ui"` re-export stays; self `std::cli`→`std::ui/cli`).

**`lib/` hits to update in place** (these `stdlib-lib` TS files and the `lib/stdlib/layout/` directory do NOT move — only the `std::` token inside their strings changes):
- **User-facing throw/label strings (MUST update):** `lib/stdlib/layout/table.ts` (`std::layout.table:` in cell/header/row/column error messages at lines 37,58,89,95,101,113,120,132,139, and `std::layout:` at 307), `lib/stdlib/layout/barchart.ts` (`std::chart:` errors at 95,100,108,225), `lib/stdlib/layout/nodes.ts` (`std::layout:` at 61,123,131,142), `lib/stdlib/layout/render.ts:32` (`std::layout:`), `lib/stdlib/layout/sizing.ts:39` (`std::layout:`), `lib/stdlib/layout/border.ts:48` (`std::layout:`). Rewrite `std::layout`→`std::ui/layout`, `std::layout.table`→`std::ui/layout.table`, `std::chart`→`std::ui/chart`, preserving the rest of each message.
- **Comments (SHOULD update):** the `// std::layout —` header comments across `lib/stdlib/layout/*.ts` (layout.ts, nodes.ts, block.ts, barchart.ts, render.ts, box.ts, sizing.ts, table.ts, axis.ts, border.ts, ansi.ts), `lib/stdlib/cli.ts:21,31` (`std::cli`→`std::ui/cli`), and `lib/utils/termcolors.ts:205` — this last one mentions **both** `std::layout::render` (→ `std::ui/layout::render`) **and** `std::syntax::diff` (**leave unchanged** — syntax stays flat).

- [ ] **Step 3: Rebuild and verify**

Run: `make stdlib 2>&1 | tee /tmp/reorg-task3.log`
Expected: clean; `stdlib/ui/{layout,table,chart,cli}.js` generated.
```bash
grep -rn 'std::layout\b\|std::table\b\|std::chart\b\|std::cli\b' stdlib lib tests docs && echo "LEFTOVERS" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -F /tmp/reorg-commit3.txt
```
(`refactor(stdlib): group layout/table/chart/cli under std::ui/` + trailer.)

---

## Task 4: Group auth modules under `std::auth/`

**Files:**
- Move: `keyring.agency`→`auth/keyring.agency`; `oauth.agency`→`auth/oauth.agency`
- Delete stale: `stdlib/keyring.js`, `stdlib/oauth.js`

- [ ] **Step 1: Move**

```bash
mkdir -p stdlib/auth
git mv stdlib/keyring.agency stdlib/auth/keyring.agency
git mv stdlib/oauth.agency   stdlib/auth/oauth.agency
git rm stdlib/keyring.js stdlib/oauth.js
```

- [ ] **Step 2: Rewrite references**

```bash
grep -rn 'std::keyring\b\|std::oauth\b' stdlib lib tests docs --include=*.agency --include=*.ts --include=*.md
```
Apply `std::keyring` → `std::auth/keyring`, `std::oauth` → `std::auth/oauth`. Confirm `stdlib/calendar.agency` (`from "std::oauth"`) and the self-doc examples in the two moved files are updated.

- [ ] **Step 3: Rebuild and verify**

Run: `make stdlib 2>&1 | tee /tmp/reorg-task4.log`
```bash
grep -rn 'std::keyring\b\|std::oauth\b' stdlib lib tests docs && echo "LEFTOVERS" || echo "clean"
```
Expected: clean build, `clean` grep.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -F /tmp/reorg-commit4.txt
```
(`refactor(stdlib): group keyring/oauth under std::auth/` + trailer.)

---

## Task 5: Group messaging modules under `std::messaging/`

**Files:**
- Move: `email.agency`→`messaging/email.agency`; `sms.agency`→`messaging/sms.agency`; `imessage.agency`→`messaging/imessage.agency`
- Delete stale: `stdlib/email.js`, `stdlib/sms.js`, `stdlib/imessage.js`

- [ ] **Step 1: Move**

```bash
mkdir -p stdlib/messaging
git mv stdlib/email.agency    stdlib/messaging/email.agency
git mv stdlib/sms.agency      stdlib/messaging/sms.agency
git mv stdlib/imessage.agency stdlib/messaging/imessage.agency
git rm stdlib/email.js stdlib/sms.js stdlib/imessage.js
```

- [ ] **Step 2: Rewrite references**

```bash
grep -rn 'std::email\b\|std::sms\b\|std::imessage\b' stdlib lib tests docs --include=*.agency --include=*.ts --include=*.md
```
Apply `std::email`→`std::messaging/email`, `std::sms`→`std::messaging/sms`, `std::imessage`→`std::messaging/imessage`. (The `lib/stdlib/messaging.js`, `email.js`, `sms.js`, `imessage.js` backing files are `stdlib-lib` — do NOT move.)

- [ ] **Step 3: Rebuild and verify**

Run: `make stdlib 2>&1 | tee /tmp/reorg-task5.log`
```bash
grep -rn 'std::email\b\|std::sms\b\|std::imessage\b' stdlib lib tests docs && echo "LEFTOVERS" || echo "clean"
```
Expected: clean build, `clean` grep.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -F /tmp/reorg-commit5.txt
```
(`refactor(stdlib): group email/sms/imessage under std::messaging/` + trailer.)

---

## Task 6: Group web batteries under `std::web/`

Move `search`, `browser` only. `wikipedia` and `weather` stay flat (distinctive names).

**Files:**
- Move: `search.agency`→`web/search.agency`; `browser.agency`→`web/browser.agency`
- Delete stale: `stdlib/search.js`, `stdlib/browser.js`

- [ ] **Step 1: Move**

```bash
mkdir -p stdlib/web
git mv stdlib/search.agency  stdlib/web/search.agency
git mv stdlib/browser.agency stdlib/web/browser.agency
git rm stdlib/search.js stdlib/browser.js
```

- [ ] **Step 2: Rewrite references**

```bash
grep -rn 'std::search\b\|std::browser\b' stdlib lib tests docs --include=*.agency --include=*.ts --include=*.md
```
Apply `std::search`→`std::web/search`, `std::browser`→`std::web/browser`. Leave every `std::wikipedia` and `std::weather` untouched.

- [ ] **Step 3: Rebuild and verify**

Run: `make stdlib 2>&1 | tee /tmp/reorg-task6.log`
```bash
grep -rn 'std::search\b\|std::browser\b' stdlib lib tests docs && echo "LEFTOVERS" || echo "clean"
```
Expected: clean build, `clean` grep.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -F /tmp/reorg-commit6.txt
```
(`refactor(stdlib): group search/browser under std::web/` + trailer.)

---

## Task 7: Repo-wide reference sweep + fixture regeneration

Catch every remaining reference outside `stdlib/` (guide docs, examples, test fixtures, appendix) and regenerate integration fixtures whose compiled output embeds `agency-lang/stdlib/<old>.js` paths.

**Files:**
- Rewrite: `tests/**`, `docs/site/guide/**`, `docs/site/**`, `examples/**` (if present), any `.agency`/`.ts`/`.md` with old paths.
- Regenerate: integration fixtures via `make fixtures`.

> **CRITICAL EXCEPTION discovered in Task 6 — `std::search` is also an effect identifier.** `std::search` is used in two different namespaces: (a) the module import path (`from "std::search"`), which MUST become `std::web/search`; and (b) an **effect/interrupt identifier** — `interrupt std::search(...)`, the `effectSet Network = <… std::search …>` member in `stdlib/capabilities.agency`, and the policy key `"std::search":` in `lib/agents/agency-agent/lib/defaultPolicy.agency`. The effect grammar (`namespaceIdentifier` in `lib/parsers/parsers.ts`) forbids `/`, and renaming the policy key would **silently break policy matching** (`lib/runtime/policy.ts` matches `policy[interrupt.effect]`). So the effect-identifier `std::search` occurrences are CORRECT and must stay. Therefore `search` is excluded from the bare-token assertions below and checked only in import-path form. (The other 14 retired module names have no effect collision — notably `browser`'s effect is `std::browserUse`, which `\bstd::browser\b` does not match.)

- [ ] **Step 1: Global leftover scan (14 module-only names + search import-path form)**

```bash
# (a) The 14 names with no effect collision — bare-token grep MUST be empty:
grep -rnE 'std::(threads|types|schemas|validators|layout|table|chart|cli|keyring|oauth|email|sms|imessage|browser)\b' \
  --include=*.agency --include=*.ts --include=*.md . \
  | grep -v node_modules | grep -v '/dist/' | tee /tmp/reorg-leftovers.log
# (b) search as a MODULE IMPORT PATH — must be empty (effect usages excluded):
grep -rnE 'from "std::search"|`std::search`|"std::search"[^:]' \
  --include=*.agency --include=*.ts --include=*.md . \
  | grep -v node_modules | grep -v '/dist/' | tee -a /tmp/reorg-leftovers.log
```
Expected after fixing: both empty. This whole-repo (`.`) scan is the **backstop for `lib/`** — the Tasks 1–6 greps now include `lib` and should have already handled per-module strings, so anything surfacing here is a straggler (often a `lib/`-local test file or a cross-cutting comment). Rewrite each hit per the mapping table, applying the **user-facing-vs-comment rule** (throw/label strings and imports MUST update; comments SHOULD update; leave `std::syntax`, `std::wikipedia`, `std::weather`, `std::math` untouched). Watch for compiled-path forms in fixtures: `agency-lang/stdlib/table.js` → `agency-lang/stdlib/ui/table.js`, etc. — but prefer regenerating fixtures (next step) over hand-editing them.

To confirm the remaining bare `std::search` tokens are ALL legitimate effect usages (not missed module paths), eyeball them:
```bash
grep -rnE '\bstd::search\b' stdlib lib tests --include=*.agency --include=*.ts | grep -v node_modules
```
Expected: only effect-context lines — the `capabilities.agency` `Network` effectSet, `interrupt std::search(...)` in `web/search.agency`, the `defaultPolicy.agency` policy key, and generated `.js` interrupt strings. No `import`/`from` lines.

Also run a `lib/`-focused view to eyeball the string-vs-comment split explicitly:
```bash
grep -rnE 'std::(threads|types|schemas|validators|layout|table|chart|cli|keyring|oauth|email|sms|imessage|browser)\b' lib --include=*.ts | grep -v '/dist/'
```
Expected after Tasks 1–6: empty.

- [ ] **Step 2: Regenerate fixtures**

Run: `make fixtures 2>&1 | tee /tmp/reorg-task7-fixtures.log`
Expected: fixtures rebuild; `git diff --stat` shows only expected path changes in generated fixture outputs.

- [ ] **Step 3: Re-scan compiled forms in fixtures**

```bash
grep -rnE 'stdlib/(threads|types|schemas|validators|layout|table|chart|cli|keyring|oauth|email|sms|imessage|search|browser)\.js' \
  tests --include=*.ts --include=*.agency | grep -v node_modules | tee -a /tmp/reorg-leftovers.log
```
Expected: empty (all now point at the grouped/merged paths).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -F /tmp/reorg-commit7.txt
```
(`refactor(stdlib): update all references and regenerate fixtures for reorg` + trailer.)

---

## Task 8: Regenerate stdlib docs + update VitePress sidebar

**Files:**
- Regenerate: `docs/site/stdlib/**` (via `make doc`)
- Modify: `docs/site/.vitepress/config.mts` (the `"/stdlib/":` sidebar array, ~line 204+) to reflect merges/moves.

- [ ] **Step 1: Regenerate docs**

Run: `make doc 2>&1 | tee /tmp/reorg-task8.log`
Expected: `docs/site/stdlib/` rebuilt; new pages `docs/site/stdlib/ui/{layout,table,chart,cli}.md`, `auth/{keyring,oauth}.md`, `messaging/{email,sms,imessage}.md`, `web/{search,browser}.md`, `validation.md`; removed pages for `threads`, `types`, `schemas`, `validators`, and the moved flat names.

- [ ] **Step 2: Update the sidebar config**

In `docs/site/.vitepress/config.mts`, edit the `"/stdlib/"` sidebar group:
- Remove entries: `threads`, `types`, `schemas`, `validators`, `layout`, `table`, `chart`, `cli`, `keyring`, `oauth`, `email`, `sms`, `imessage`, `search`, `browser`.
- Add flat entry: `{ text: "validation", link: "/stdlib/validation" }`.
- Add grouped sub-items (collapsible groups mirroring the existing `agency` nesting), e.g.:

```ts
{ text: "ui", collapsed: true, items: [
  { text: "ui (interactive)", link: "/stdlib/ui" },
  { text: "ui/layout", link: "/stdlib/ui/layout" },
  { text: "ui/table",  link: "/stdlib/ui/table" },
  { text: "ui/chart",  link: "/stdlib/ui/chart" },
  { text: "ui/cli",    link: "/stdlib/ui/cli" },
]},
{ text: "auth", collapsed: true, items: [
  { text: "auth/keyring", link: "/stdlib/auth/keyring" },
  { text: "auth/oauth",   link: "/stdlib/auth/oauth" },
]},
{ text: "messaging", collapsed: true, items: [
  { text: "messaging/email",    link: "/stdlib/messaging/email" },
  { text: "messaging/sms",      link: "/stdlib/messaging/sms" },
  { text: "messaging/imessage", link: "/stdlib/messaging/imessage" },
]},
{ text: "web", collapsed: true, items: [
  { text: "web/search",  link: "/stdlib/web/search" },
  { text: "web/browser", link: "/stdlib/web/browser" },
]},
```
Keep `wikipedia`, `weather`, `thread`, and all unchanged modules as their existing flat entries (remove the now-defunct `threads` entry; `thread` stays).

- [ ] **Step 3: Verify docs build**

Run: `pnpm run docs:build 2>&1 | tee -a /tmp/reorg-task8.log` (or the repo's VitePress build script; check `package.json` scripts if the name differs).
Expected: builds with no dead-link errors for stdlib pages.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -F /tmp/reorg-commit8.txt
```
(`docs(stdlib): regenerate stdlib docs and regroup sidebar for reorg` + trailer.)

---

## Task 9: Full build + targeted verification

- [ ] **Step 1: Full build**

Run: `make 2>&1 | tee /tmp/reorg-final-build.log`
Expected: `templates` → `build` → `stdlib` → `agents` → `doc` all succeed.

- [ ] **Step 2: Global leftover assertion (must be empty)**

`search` is excluded from the bare-token assertion because `std::search` is a legitimate effect identifier (see the Task 7 CRITICAL EXCEPTION note); it is asserted in import-path form instead.

```bash
# 14 module-only names — must be empty:
grep -rnE 'std::(threads|types|schemas|validators|layout|table|chart|cli|keyring|oauth|email|sms|imessage|browser)\b' \
  --include=*.agency --include=*.ts --include=*.md . | grep -v node_modules | grep -v '/dist/'
# search as a module import path — must be empty (effect usages allowed to remain):
grep -rnE 'from "std::search"|`std::search`|"std::search"[^:]' \
  --include=*.agency --include=*.ts --include=*.md . | grep -v node_modules | grep -v '/dist/'
```
Expected: no output from either. (Bare `std::search` effect tokens in `capabilities.agency`, `web/search.agency`, `defaultPolicy.agency`, and generated `.js` remain — that is correct.)

- [ ] **Step 3: Smoke-compile a program using the new paths**

Create `/tmp/reorg-smoke.agency`:
```
import { table } from "std::ui/table"
import { isEmail } from "std::validation"
import { listThreads } from "std::thread"
import { setSecret } from "std::auth/keyring"
import { sendSms } from "std::messaging/sms"
import { search } from "std::web/search"

node main() {
  print("ok")
}
```
Run: `pnpm run compile /tmp/reorg-smoke.agency 2>&1 | tee /tmp/reorg-smoke.log`
Expected: compiles with no unresolved-import errors. (Cannot live in `/tmp` for *running* — compile-only is fine there; if resolution needs node_modules, place it under the package dir instead, e.g. `./tmp-smoke.agency`, and delete after.)

- [ ] **Step 4: Run unit + LSP tests**

Run: `pnpm exec vitest run lib/importPaths.test.ts lib/lsp/ lib/symbolTable.test.ts 2>&1 | tee /tmp/reorg-final-unit.log`
Expected: PASS.

- [ ] **Step 5: Run targeted stdlib-touching agency tests (no full suite)**

Identify tests that import the moved/merged modules and run them individually, saving output:
```bash
grep -rlE 'std::(ui/|validation|thread|auth/|messaging/|web/)' tests/agency tests/agency-js --include=*.agency
```
For each relevant file run `pnpm run agency test <file> 2>&1 | tee -a /tmp/reorg-final-agency.log`. Do NOT run the whole suite — CI covers it.

- [ ] **Step 6: Final commit (if any regen churn remains)**

```bash
git add -A && git commit -F /tmp/reorg-commit9.txt
```
(`chore(stdlib): finalize reorg build artifacts` + trailer — only if `git status` is non-empty.)

- [ ] **Step 7: Open the PR**

Write the PR body to a file (apostrophe rule), summarizing: the new grouping (`ui/`, `auth/`, `messaging/`, `web/`), the `thread` merge, the `validation` fold, the recursive-enumeration fix, and the hard-cutover (no aliases). Then `gh pr create -F <file>`.

---

## Self-Review

**Spec coverage:**
- Merge `threads`→`thread` ✓ Task 1. Fold validation trio ✓ Task 2. Group `ui/` ✓ Task 3, `auth/` ✓ Task 4, `messaging/` ✓ Task 5, `web/` (search+browser only) ✓ Task 6. `wikipedia`/`weather`/`markdown`/`syntax`/`math` stay flat ✓ (excluded from all move tasks; math untouched). `capabilities` stays plural ✓ (unchanged list). Recursive enumeration/LSP ✓ Task 0. Docs + sidebar ✓ Task 8. Hard cutover, no aliases ✓ (Global Constraints + leftover assertions in Tasks 1–9). `stdlib-lib` backing untouched ✓ (Global Constraints + explicit notes in Tasks 1/5).
- Regeneration of `.js`, fixtures, docs ✓ Tasks 3–8. Reference sweep across stdlib/lib/tests/docs/examples ✓ Tasks 1–6 (per-module, `lib` in scope) + Task 7 (whole-repo backstop). `lib/` embedded `std::` strings — user-facing throw/label strings and `lib/`-local test imports (MUST update) vs comments (SHOULD update) — explicitly enumerated in Tasks 1 (threads comments), 2 (validators test imports), 3 (layout/chart/table/cli strings + termcolors) and backstopped in Task 7. The `stdlib-lib` TS files/directories do not move; only their string contents change.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Merge tasks (1,2) instruct verbatim copy of read-in source with exact symbol lists rather than reproducing multi-KB bodies — deliberate for a move-of-existing-code, with exact export names and import lines given.

**Type/name consistency:** `stdlibModuleName` defined in Task 0 and used in Task 0 Steps 4. Merge-target export lists in Tasks 1–2 match the symbols gathered from source. Mapping table is the single source of truth referenced by every rewrite step; `std::thread` (target) and `std::ui` (root) are consistently kept, `std::threads`/`std::cli`-as-flat consistently removed.

**Open confirmations for the implementer (verify at execution, non-blocking):**
1. `docs:build` script name in `package.json` (Task 8 Step 3) — use the actual VitePress build script if named differently.
2. Whether any `examples/` dir exists at repo root (Task 7) — the glob covers it if present; harmless if absent.
