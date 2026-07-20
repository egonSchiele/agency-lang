# Coding Standards

Rules for writing code in the Agency codebase. Most are enforced by the structural linter (`pnpm run lint:structure`). The last two are conventions that are not mechanically enforced.

---

### Use `type`, not `interface`

```ts
// Bad
interface Foo { name: string }

// Good
type Foo = { name: string }
```

**Rationale:** Consistency. The codebase uses `type` everywhere; `interface` introduces a second way to do the same thing.

---

### Use plain objects instead of `Map`

```ts
// Bad
const lookup = new Map<string, number>();

// Good
const lookup: Record<string, number> = {};
```

**Rationale:** Plain objects are serializable (important for checkpointing/interrupts) and simpler to work with.

---

### No dynamic imports

```ts
// Bad
const module = await import("./foo.js");

// Good
import { foo } from "./foo.js";
```

**Rationale:** Dynamic imports break static analysis and make the dependency graph harder to reason about.

---

### Prefer `const` over `let`

```ts
// Bad
let name = "Alice";
// name is never reassigned

// Good
const name = "Alice";
```

**Rationale:** `const` signals that a value won't change, reducing cognitive load when reading code.

---

### Keep functions under 100 lines

If a function exceeds 100 lines, break it into smaller, focused functions. Blank lines and comments don't count toward the limit.

**Rationale:** Long functions are hard to understand, test, and modify. Smaller functions with clear names serve as documentation.

---

### Keep files under 1000 lines

If a file exceeds 1000 lines, consider splitting it into smaller modules. Blank lines and comments don't count toward the limit.

Some files are exempt from this rule (e.g., `typescriptBuilder.ts`, `parser.ts`) because they are inherently large due to the nature of their work. These are configured as exceptions in the ESLint config.

**Rationale:** Large files are hard to navigate and often indicate that a module has too many responsibilities.

---

### Keep nesting depth under 4 levels

```ts
// Bad
if (a) {
  for (x in items) {
    if (b) {
      for (y in things) {
        if (c) { // 5 levels deep
```

```ts
// Good — use early returns and extracted functions
if (!a) return;
for (x in items) {
  if (!b) continue;
  processThings(x);
}
```

**Rationale:** Deeply nested code is hard to follow. Extract inner logic into functions or use early returns to flatten the structure.

---

### Push functionality into runtime libs, not the builder

When adding new features, put as much logic as possible in `lib/runtime/` (where it's testable and type-safe). The builder should generate calls to runtime functions, not inline complex logic as code strings.

**Rationale:** Runtime code is easier to read, test, refactor, and debug than generated code. See anti-pattern #4 (logic in the wrong layer) in `docs/dev/anti-patterns.md`.

---

### Never force push or amend commits

Always create new commits. Never use `git push --force` or `git commit --amend`.

**Rationale:** Force-pushing and amending can destroy work and make history hard to follow.

---

### Route path arguments through `resolveDir` / `resolvePath`

Any new stdlib function in `lib/stdlib/` that takes a `dir`, `cwd`, `src`, `dest`, or `path` argument MUST resolve it via [`resolveDir`](../../lib/stdlib/resolveDir.ts) (for directories) or [`resolvePath`](../../lib/stdlib/resolvePath.ts) (for the dir-plus-filename case). Do NOT call `path.resolve(process.cwd(), …)` directly on user-supplied paths; sync-only code uses `resolveCwdPath` from the same module so the expand-then-resolve policy stays single-homed.

`resolveDir`/`resolvePath` delegate to [`expandPath`](../../lib/stdlib/expandPath.ts), which is the single owner of path-shorthand policy (today: leading `~`; later: env vars, normalization, etc.). Inlining `path.resolve` at a new call site encodes the policy locally, so any future expansion rule has to be added at every site — exactly the "inconsistent patterns" anti-pattern this module exists to prevent.

For options-only `allowedPaths` shapes, `assertContained` already runs each entry through `expandPath`, so a policy that says `allowedPaths: ["~/.agency"]` works for free.
