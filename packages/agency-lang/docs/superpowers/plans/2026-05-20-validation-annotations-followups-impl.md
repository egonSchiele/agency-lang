# Validation & JSON Schema Annotations — Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the deferred work from the `@validate` / `@jsonSchema` PR (PR #174). The core feature is shipped; this plan covers the user-facing guide page, parameterized validators, the missing-coverage agency tests (union members, generics, `Result` success type, recursive types), VitePress sidebar wiring, and the explicit "fast-follow" items deferred from the original spec.

**Architecture:** Each track is independent and can land as its own PR; nothing here changes the AST or the codegen contracts established in PR #174. The parameterized-validator track is the only one that touches the type system — it introduces a value-parameter form of `@validate(...)`.

**Tech Stack:** tarsec parsers, vitest, structural linter, Zod 4 `.meta()`, the existing `__validateChain` / `__validateChainRecursive` runtime helpers.

**Spec:** `docs/superpowers/specs/2026-05-19-type-validation-and-json-schema-annotations-design.md` (the original)
**Predecessor plan:** `docs/superpowers/plans/2026-05-19-type-validation-and-json-schema-annotations-impl.md`

---

## Key Risks and Gotchas

1. **`__agency_descriptor` is the only path from an alias's module-local validators to a downstream consumer.** Any new test fixture or feature that emits Zod schemas for `@validate`-tagged aliases must preserve the `(Alias as any).__agency_descriptor = ...` assignment. See [`docs/dev/validation-annotations.md`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/dev/validation-annotations.md) for the contract.

2. **`hasAnyValidateTag` is the codegen gate.** Adding new wrapper types (alongside `arrayType`, `objectType`, `unionType`, `nullable`) requires extending [`hasAnyValidateTag`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptGenerator/validationDescriptor.ts) or `@validate` will silently disappear at the new shape. The generics track in particular needs to verify that `genericType` already routes correctly.

3. **`.meta()` must be the last call in the Zod chain.** When the user-facing guide writes example code, it must NOT recommend chaining anything after a `.meta(...)`. The implementation already enforces this in [`appendMeta`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptGenerator/typeToZodSchema.ts).

4. **Parameterized validators change the tag-arg shape.** Today `@validate(isEmail)` accepts only identifiers and bare function references. Adding `@validate(maxLength(80))` keeps the existing parser (function calls are already in the restricted-expression subset), but the runtime must understand that `maxLength(80)` evaluates to a fresh validator function at module-load time. No new AST changes — `tagArgToTs` already prints the call form.

5. **Recursive validator descriptors hit the depth cap.** The default is 64. Tests for recursive types must either stay shallow or set `maxDepth` via the runtime opts. They must NOT assert "validation runs to completion on a 200-deep tree" without raising the cap.

6. **`Result<T>` success-type meta currently routes via `resultHandler`.** The validation-schema path returns the full `Result` shape; the LLM-structured-output path returns just `T`. `@jsonSchema` on a `Result<Foo>` only attaches to the success-type schema in the LLM path. Tests must use the LLM path or `Foo` directly to verify the metadata.

7. **VitePress sidebar config is `docs/site/.vitepress/config.mts`.** Adding the new guide page requires editing the `sidebar` array in that file.

8. **The "fast-follow #11" item from the spec discussion is `# description` removal.** The original plan called this out as a separate fast-follow PR. Re-evaluate before doing this: shipping the annotation system without removing `# description` is fine; mixing the two on a single property is already a documented error.

---

## File Structure

**New files:**

| File | Purpose |
|------|---------|
| `docs/site/guide/annotations.md` | User-facing guide for `@validate(...)` / `@jsonSchema(...)`, the stdlib modules, and best practices |
| `tests/agency/validation/validateOnUnionMembers.{agency,test.json}` | Validator on each member of a union type |
| `tests/agency/validation/validateOnGeneric.{agency,test.json}` | `@validate`-tagged alias used as a type argument to a generic |
| `tests/agency/validation/jsonSchemaOnResultSuccess.{agency,test.json}` | `@jsonSchema` on the success type of `Result<...>` |
| `tests/agency/validation/validateRecursiveTypeShallow.{agency,test.json}` | `@validate` on a small recursive type, exercising the descriptor walker without hitting the depth cap |
| `stdlib/validators.agency` (extended) | Add parameterized validators: `min`, `max`, `minLength`, `maxLength`, `matches` |
| `tests/agency/validation/validateParameterized.{agency,test.json}` | End-to-end test for parameterized validators |
| `lib/stdlib/validators.ts` (extended) | JS-backed implementations for the new parameterized validators |

**Files modified:**

| File | Purpose in this plan |
|------|----------------------|
| `docs/site/.vitepress/config.mts` | Register the new annotations guide page in the sidebar; add a link to `docs/dev/validation-annotations.md` if the site exposes dev docs |
| `stdlib/validators.agency` | New `min(n) / max(n) / minLength(n) / maxLength(n) / matches(re)` validator factories |
| `lib/stdlib/validators.ts` | Plain-JS implementations of the same factories returning validator closures |
| `docs/dev/validation-annotations.md` | Update the "user-facing material" pointer once `annotations.md` exists; mention parameterized validators in "Validator dispatch" |
| `stdlib/validators.agency` module doc | Replace the temporary `schemas.md` link with the new `annotations.md` once written |

---

## Track A — User-facing guide page

### A1. Write `docs/site/guide/annotations.md`

- [ ] Draft a guide page covering:
  - What `@validate(...)` and `@jsonSchema(...)` do, with a side-by-side example.
  - When validators run (only at `!` sites — link to `schemas.md`).
  - The "tags propagate through alias references" rule, with a 5-line example.
  - The merge rules for alias-then-use-site combinations.
  - Cross-link to `std::validators`, `std::schemas`, `std::types` (with import examples).
  - A "writing your own validator" section that shows both an Agency `def` validator and a plain JS validator (with `success` / `failure` imported from `agency-lang/runtime`). Reference [`tests/agency/validation/validatePlainJsFunction.agency`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/tests/agency/validation/validatePlainJsFunction.agency) as the canonical example.
  - A "writing your own JSON Schema fragment" section that shows the `export static const fooFormat = { format: "foo" }` + `@jsonSchema({ ...fooFormat })` pattern.
  - A short paragraph on what `@jsonSchema` does for structured-output LLM calls.
- [ ] Verify every code example compiles by copy-pasting into a scratch `.agency` file and running `pnpm run agency compile`.

### A2. Register the page in VitePress

- [ ] Edit `docs/site/.vitepress/config.mts` to add `annotations.md` to the sidebar under the section that contains `schemas.md` (probably "Types & Validation" or similar).
- [ ] Run `pnpm --filter @agency-lang/docs run docs:build` (or whatever the docs build command is — check `package.json`) and verify the page renders without broken links.

### A3. Replace the temporary `schemas.md` pointer

- [ ] In [`stdlib/validators.agency`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/stdlib/validators.agency) module doc, swap the `../guide/schemas.md` link for `../guide/annotations.md`.
- [ ] In [`docs/dev/validation-annotations.md`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/dev/validation-annotations.md) update the "user-facing material" pointer (intro paragraph) to reference `annotations.md` as the primary.
- [ ] Re-run `make` so the regenerated stdlib docs in `docs/site/stdlib/validators.md` pick up the new link.

---

## Track B — Missing-coverage agency tests

Each test follows the existing pattern: `.agency` + `.test.json` in `tests/agency/validation/`. The `.test.json` uses `expectedOutput` with `"evaluationCriteria": [{ "type": "exact" }]`.

### B1. `validateOnUnionMembers`

- [ ] Write the agency file:
  ```agency
  @validate(isEmail)
  type Email = string

  @validate(isUrl)
  type URL = string

  type Contact = Email | URL

  node main() {
    const e: Contact! = "user@example.com"
    const u: Contact! = "https://example.com"
    const bad: Contact! = "neither"
    // assert success(e), success(u), failure(bad)
  }
  ```
- [ ] Confirm the descriptor's `union` branch dispatches to the matching member's validators.
- [ ] Run: `pnpm run agency test tests/agency/validation/validateOnUnionMembers.agency -p 1`.

### B2. `validateOnGeneric`

- [ ] Write a small generic alias whose type argument carries `@validate`:
  ```agency
  @validate(isEven)
  type Even = number

  type Box<T> = { item: T }

  node main() {
    const ok: Box<Even>! = { item: 4 }
    const bad: Box<Even>! = { item: 3 }
  }
  ```
- [ ] Verify the validator runs on `item`. If it does NOT run, suspect `resolveTypeDeep` is dropping tags on the substituted type argument — extend `hasAnyValidateTag`'s `genericType` branch and the descriptor walker accordingly.
- [ ] Add the test under `tests/agency/validation/`.

### B3. `jsonSchemaOnResultSuccess`

- [ ] Write a test that builds the JSON Schema of a `Result<Email>` and asserts the success-type metadata propagates:
  ```agency
  @jsonSchema({ format: "email" })
  type Email = string

  type LookupResult = Result<Email>

  node main() {
    const s = schema(Email)   // simpler — direct alias
    const js = s.toJSONSchema()
    return js.format
  }
  ```
- [ ] If the user wants the *Result-shaped* path verified, route through the LLM structured-output schema map (see `mapTypeToZodSchema`'s `resultHandler`). That's likely a separate test using a contrived smoltalk call shim.

### B4. `validateRecursiveTypeShallow`

- [ ] Write a small recursive type that validates two levels deep:
  ```agency
  @validate(nonEmpty)
  type Node = {
    name: string,
    children: Node[]
  }
  ```
- [ ] Use `maxDepth` if the default 64 is uncomfortably close to the data shape, but for this test, a 3-deep value is fine.
- [ ] Assert success / failure based on `children` shape.

### B5. Run the full validation suite

- [ ] `pnpm run agency test tests/agency/validation -p 12` should report 55+/55+ passing.
- [ ] If any test fails, do not weaken the assertion — debug per the systematic-debugging skill.

---

## Track C — Parameterized validators

This adds factory-style validators to `std::validators` so users can write `@validate(maxLength(80))` instead of inventing a new alias for every threshold.

### C1. Add factory validators to `lib/stdlib/validators.ts`

- [ ] Implement these as factory functions that return a validator closure:
  ```ts
  export function _min(n: number) {
    return (value: number): ResultValue =>
      value >= n ? success(value) : failure(`expected >= ${n}, got ${value}`);
  }
  export function _max(n: number) { /* ... */ }
  export function _minLength(n: number) { /* ... */ }
  export function _maxLength(n: number) { /* ... */ }
  export function _matches(pattern: string | RegExp) { /* ... */ }
  ```
- [ ] Each factory returns a function matching the `AgencyValidator` plain-function contract (`(value) => Result`).
- [ ] Add unit tests in `lib/stdlib/__tests__/validators.test.ts` (create if it doesn't exist).

### C2. Expose them from `stdlib/validators.agency`

- [ ] Add the corresponding agency-level wrappers:
  ```agency
  export def min(n: number): (any) => Result {
    return _min(n)
  }
  // ... etc
  ```
- [ ] Run `make` to regenerate `stdlib/validators.js`.

### C3. End-to-end test

- [ ] Write `tests/agency/validation/validateParameterized.agency`:
  ```agency
  import { maxLength } from "std::validators"

  @validate(maxLength(5))
  type ShortName = string

  node main() {
    const ok: ShortName! = "abc"
    const bad: ShortName! = "abcdefghij"
    // success(ok), failure(bad)
  }
  ```
- [ ] **Verify codegen** — `pnpm run compile tests/agency/validation/validateParameterized.agency` and inspect the emitted `__agency_descriptor` to confirm `maxLength(5)` is called once at module load (not on every validation).

### C4. Update guide

- [ ] Add a "Parameterized validators" section to `docs/site/guide/annotations.md` with the call-site example and a note that factories run once at module load.

---

## Track D — VitePress sidebar wiring

### D1. Sidebar entry for the new dev doc

- [ ] If `docs/site/.vitepress/config.mts` exposes dev docs in any sidebar, add an entry for `docs/dev/validation-annotations.md`. Otherwise this is a no-op (dev docs are reached via the repo, not the published site).

### D2. Sidebar entry for the new guide

- [ ] (Covered in A2.)

---

## Track E — Fast-follow #11 from the spec

The deferred item was the removal of the legacy property-level `# description` syntax in favor of `@jsonSchema({ description: ... })`. This is its own PR. The plan:

### E1. Decide

- [ ] Confirm with the owner whether `# description` should be removed at all. The annotation system co-exists with it today and the `.meta` / `.describe` ordering bug is already fixed. Removal is purely a consolidation play.

### E2. If go: codemod

- [ ] Write a small node script that walks every `.agency` file under `stdlib/`, `tests/`, `examples/` and converts `prop: T # desc` into `@jsonSchema({ description: "desc" }) prop: T`.
- [ ] Remove the `# description` branch from the parser ([`parsers.ts:884-920`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L884-L920) area).
- [ ] Remove the `.describe(...)` emission from [`typeToZodSchema.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptGenerator/typeToZodSchema.ts) (since metadata now flows via `.meta`).
- [ ] Update the agency generator's property emitter so it does NOT round-trip the description as `# ...` (already covered by the AST change, but verify).

### E3. If no-go

- [ ] Add a section to `docs/site/guide/annotations.md` explaining that `# desc` is still supported on properties but `@jsonSchema({ description: ... })` is preferred for richer metadata.

---

## Validation checklist for each track

Run after **each** track lands:

- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm run lint:structure`
- [ ] `pnpm test:run`
- [ ] `pnpm run agency test tests/agency/validation -p 12`
- [ ] (if stdlib changed) `make`
- [ ] (if docs changed) regenerate `docs/site/stdlib/` via `make` and verify no dead links

---

## Suggested PR ordering

1. **Track A** (user-facing guide) — small, no code risk. Lands first to unblock the link in `stdlib/validators.agency`.
2. **Track B** (coverage tests) — pure additions; safe to land alone.
3. **Track C** (parameterized validators) — feature work, depends on Track A's guide format being settled.
4. **Track D** — fold into A.
5. **Track E** — separate PR after the owner decides go / no-go.

---

## Out of scope

- Anything that requires AST changes beyond what shipped in PR #174.
- New validation kinds (e.g. `@validate(...)` on a free-standing `const`, on a function parameter type without `!`).
- Editor / LSP improvements for annotation hover / autocomplete.
- Migrating downstream consumers off `__agency_descriptor` to a more structured channel — the current side-channel is documented and stable.
