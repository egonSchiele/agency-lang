# Coding Standards

Rules for writing code in the Agency codebase. Some are enforced by the structural linter (`pnpm run lint:structure`, which runs ESLint over `lib/` using `eslint.config.js`). The rest are conventions we follow by hand. Each rule below says which it is.

---

### Use `type`, not `interface`

```ts
// Bad
interface Foo { name: string }

// Good
type Foo = { name: string }
```

**Rationale:** Consistency. The codebase uses `type` everywhere, and `interface` introduces a second way to do the same thing.

**Enforcement:** convention only. The `consistent-type-definitions` rule sits commented out in `eslint.config.js`, waiting on a cleanup pass over the existing `interface` declarations.

---

### Use plain objects instead of `Map`

```ts
// Bad
const lookup = new Map<string, number>();

// Good
const lookup: Record<string, number> = {};
```

**Rationale:** Plain objects serialize cleanly, which matters for checkpointing and interrupts, and they are simpler to work with.

**Enforcement:** convention only. The linter has no rule for `Map`.

---

### No dynamic imports

```ts
// Bad
const module = await import("./foo.js");

// Good
import { foo } from "./foo.js";
```

**Rationale:** Dynamic imports break static analysis and make the dependency graph harder to reason about.

**Enforcement:** linted. `no-restricted-syntax` bans `ImportExpression`.

---

### Prefer `const` over `let`

```ts
// Bad
let name = "Alice";
// name is never reassigned

// Good
const name = "Alice";
```

**Rationale:** `const` signals that a value will not change, so there is less to track while reading.

**Enforcement:** linted, via `prefer-const`.

---

### Keep functions short

The linter caps a function at 150 lines, but aim well below that. If a function is getting long, break it into smaller, focused functions. Blank lines and comments don't count toward the limit.

**Rationale:** Long functions are hard to understand, test, and modify. Smaller functions with clear names serve as documentation.

**Enforcement:** linted, via `max-lines-per-function`. Test files are exempt.

---

### Keep files short

The linter caps a file at 1250 lines. If a file is approaching that, split it into smaller modules. Blank lines and comments don't count toward the limit.

`lib/backends/agencyGenerator.ts` is exempt, and so are test files. Both exemptions live in `eslint.config.js`.

**Rationale:** Large files are hard to navigate and often indicate that a module has too many responsibilities.

**Enforcement:** linted, via `max-lines`.

---

### Keep nesting shallow

```ts
// Bad
if (a) {
  for (x in items) {
    if (b) {
      for (y in things) {
        if (c) {
          while (d) { // 6 levels deep, over the limit
```

```ts
// Good: use early returns and extracted functions
if (!a) return;
for (x in items) {
  if (!b) continue;
  processThings(x);
}
```

**Rationale:** Deeply nested code is hard to follow. Extract inner logic into functions or use early returns to flatten the structure.

**Enforcement:** linted. `max-depth` allows 5 levels. Test files are exempt.

---

### Push functionality into runtime libs, not the builder

When adding new features, put as much logic as possible in `lib/runtime/`, where it is testable and type-safe. The builder should generate calls to runtime functions rather than inline complex logic as code strings.

**Rationale:** Runtime code is easier to read, test, refactor, and debug than generated code. See [anti-patterns.md](anti-patterns.md).

**Enforcement:** convention only.

---

### Never force push or amend commits

Always create new commits. Never use `git push --force` or `git commit --amend`.

**Rationale:** Force-pushing and amending can destroy work and make history hard to follow.

**Enforcement:** convention only.

---

### Route path arguments through `resolveDir` / `resolvePath`

Any new stdlib function in `lib/stdlib/` that takes a `dir`, `cwd`, `src`, `dest`, or `path` argument MUST resolve it via [`resolveDir`](../../../lib/stdlib/resolveDir.ts) for directories, or [`resolvePath`](../../../lib/stdlib/resolvePath.ts) for the dir-plus-filename case. Do NOT call `path.resolve(process.cwd(), …)` directly on user-supplied paths. Sync-only code uses `resolveCwdPath` from `resolveDir.ts`, so the expand-then-resolve policy stays in one place.

`resolveDir` and `resolvePath` delegate to [`expandPath`](../../../lib/stdlib/expandPath.ts), the single owner of path-shorthand policy. Today it expands a leading `~`, and later it may handle env vars and normalization. Inlining `path.resolve` at a new call site encodes the policy locally, so any future expansion rule has to be added at every site. That is exactly the "inconsistent patterns" anti-pattern this module exists to prevent.

For options-only `allowedPaths` shapes, `assertContained` in `lib/stdlib/assertContained.ts` already runs each entry through `expandPath`, so a policy that says `allowedPaths: ["~/.agency"]` works for free.

**Enforcement:** convention only.
