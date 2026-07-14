---
name: "policy"
---

# policy

Decide whether to approve or reject the interrupts an agent raises,
  without prompting the user every time. A `Policy` is an ordered list of
  glob-pattern rules per interrupt effect, evaluated first-match-wins.

  `cliPolicyHandler` is the common entry point: it loads a policy file,
  prompts the user on each new interrupt, remembers "always" decisions, and
  replays matching rules so each pattern is only asked about once.

  ```ts
  import { cliPolicyHandler } from "std::policy"

  node main() {
    // Bind to a variable — the `with` clause only accepts an identifier.
    const handler = cliPolicyHandler(
      file: "${env("HOME")}/.myapp/policy.json",
      fields: { "std::read": [{ field: "dir", matchSubpaths: true }] },
    )
    handle {
      llm("hi", { tools: [...] })
    } with handler
  }
  ```

  For a different UI (a web prompt, a Slack bot, a non-interactive CI mode),
  build your own handler on the pure primitives: `checkPolicy`, `recordRule`,
  `recordScopedRule`, `parsePolicyFile`, `writePolicyFile`, `validatePolicy`,
  and `buildScopedMatch`.

## Types

### InterruptDataKey

Key of an interrupt's `data` object (e.g. `"dir"`, `"command"`).

```ts
/** Key of an interrupt's `data` object (e.g. `"dir"`, `"command"`). */
export type InterruptDataKey = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L55))

### InterruptDataVal

* Glob pattern used to match an interrupt-data value. Patterns are
 * picomatch globs. They support `*`, `**`, and brace-expansion like
 * `{a,b}` for unions. A literal string with no glob metacharacters
 * matches only that exact value.

```ts
/**
 * Glob pattern used to match an interrupt-data value. Patterns are
 * picomatch globs. They support `*`, `**`, and brace-expansion like
 * `{a,b}` for unions. A literal string with no glob metacharacters
 * matches only that exact value.
 */
export type InterruptDataVal = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L63))

### InterruptEffect

* Identifier for an interrupt's effect (e.g. `"std::read"`,
 * `"myapp::deploy"`).

```ts
/**
 * Identifier for an interrupt's effect (e.g. `"std::read"`,
 * `"myapp::deploy"`).
 */
export type InterruptEffect = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L69))

### PolicyRule

* One row of a `Policy`. A rule passes if every key in `match` is
 * present in the interrupt's `data` and its value matches the glob
 * pattern. Omit `match` (or set it to `{}`) for a catch-all that
 * applies to every interrupt of the parent effect.

```ts
/**
 * One row of a `Policy`. A rule passes if every key in `match` is
 * present in the interrupt's `data` and its value matches the glob
 * pattern. Omit `match` (or set it to `{}`) for a catch-all that
 * applies to every interrupt of the parent effect.
 */
export type PolicyRule = {
  match?: Record<InterruptDataKey, InterruptDataVal>;
  action: "approve" | "reject" | "propagate"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L77))

### Policy

* A policy: ordered rules per interrupt effect. `checkPolicy` walks
 * the array for `intr.effect` in order and returns on the first
 * matching rule. If no rule for the effect exists, evaluation falls
 * through to `propagate` (i.e. ask the next handler in the chain).

```ts
/**
 * A policy: ordered rules per interrupt effect. `checkPolicy` walks
 * the array for `intr.effect` in order and returns on the first
 * matching rule. If no rule for the effect exists, evaluation falls
 * through to `propagate` (i.e. ask the next handler in the chain).
 */
export type Policy = Record<InterruptEffect, PolicyRule[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L88))

### Decision

* The five answers `cliPolicyHandler`'s prompt accepts:
 * - `"approve"` / `"reject"` — one-off (a) / (r).
 * - `"approve-always"` / `"reject-always"` — (aa) / (rr). Records a
 *   catch-all rule for the effect, so future interrupts of this effect
 *   resolve without prompting.
 * - `"approve-always-here"` — (ap). Records a scoped rule pinned to
 *   whichever fields you listed in `ScopedRuleFields` for this effect.
 *   Only offered when the effect has an entry in the config.

```ts
/**
 * The five answers `cliPolicyHandler`'s prompt accepts:
 * - `"approve"` / `"reject"` — one-off (a) / (r).
 * - `"approve-always"` / `"reject-always"` — (aa) / (rr). Records a
 *   catch-all rule for the effect, so future interrupts of this effect
 *   resolve without prompting.
 * - `"approve-always-here"` — (ap). Records a scoped rule pinned to
 *   whichever fields you listed in `ScopedRuleFields` for this effect.
 *   Only offered when the effect has an entry in the config.
 */
export type Decision =
  | "approve"
  | "reject"
  | "approve-always"
  | "approve-always-here"
  | "reject-always"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L129))

### ScopedField

* One column in a `ScopedRuleFields` entry — names an interrupt-data
 * field that the "approve-always-here" rule should pin.
 *
 * - `field` — the key in `intr.data` to pin (e.g. `"dir"`).
 * - `matchSubpaths` — when `true`, brace-expand the value so the
 *   rule matches both the exact value AND any nested path under it.
 *   Pass `true` for directory-like fields (so approving `/tmp/x`
 *   also approves `/tmp/x/sub/file.txt`). Pass `false` for opaque
 *   identifiers (commands, IDs, env names) that shouldn't fan out.

```ts
/**
 * One column in a `ScopedRuleFields` entry — names an interrupt-data
 * field that the "approve-always-here" rule should pin.
 *
 * - `field` — the key in `intr.data` to pin (e.g. `"dir"`).
 * - `matchSubpaths` — when `true`, brace-expand the value so the
 *   rule matches both the exact value AND any nested path under it.
 *   Pass `true` for directory-like fields (so approving `/tmp/x`
 *   also approves `/tmp/x/sub/file.txt`). Pass `false` for opaque
 *   identifiers (commands, IDs, env names) that shouldn't fan out.
 */
export type ScopedField = {
  field: string;
  matchSubpaths: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L147))

### ScopedRuleFields

* Per-effect configuration consumed by `buildScopedMatch` and the
 * `cliPolicyHandler`. Maps each interrupt effect to the fields its
 * "approve-always-here" rule should pin. Effects not present in this
 * map don't offer the (ap) prompt option. The user falls back to
 * (a) / (r) / (aa) / (rr).
 *
 * Example:
 * ```ts
 * const FIELDS: ScopedRuleFields = {
 *   "std::read":  [{ field: "dir", matchSubpaths: true }],
 *   "std::exec":  [
 *     { field: "command",    matchSubpaths: false },
 *     { field: "subcommand", matchSubpaths: false },
 *   ],
 * }
 * ```

````ts
/**
 * Per-effect configuration consumed by `buildScopedMatch` and the
 * `cliPolicyHandler`. Maps each interrupt effect to the fields its
 * "approve-always-here" rule should pin. Effects not present in this
 * map don't offer the (ap) prompt option. The user falls back to
 * (a) / (r) / (aa) / (rr).
 *
 * Example:
 * ```ts
 * const FIELDS: ScopedRuleFields = {
 *   "std::read":  [{ field: "dir", matchSubpaths: true }],
 *   "std::exec":  [
 *     { field: "command",    matchSubpaths: false },
 *     { field: "subcommand", matchSubpaths: false },
 *   ],
 * }
 * ```
 */
export type ScopedRuleFields = Record<InterruptEffect, ScopedField[]>
````

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L170))

### ParsePolicyFailureStatus

```ts
export type ParsePolicyFailureStatus =
  | "doesnt-exist"
  | "read-error"
  | "malformed-json"
  | "policy-not-valid"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L373))

### ParsePolicyFailure

```ts
export type ParsePolicyFailure = {
  status: ParsePolicyFailureStatus;
  error?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L379))

## Constants

### minimalAutoApprovePolicy

```ts
export static const minimalAutoApprovePolicy = _minimalAutoApprovePolicy
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L102))

### recommendedAutoApprovePolicy

```ts
export static const recommendedAutoApprovePolicy = _recommendedAutoApprovePolicy
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L103))

### approveAllPolicy

```ts
export static const approveAllPolicy = _approveAllPolicy
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L104))

### BUILTIN_POLICIES

```ts
export static const BUILTIN_POLICIES = _BUILTIN_POLICIES
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L105))

## Functions

### withWritesPolicy

```ts
withWritesPolicy(baseDir: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseDir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L107))

### builtinPolicy

```ts
builtinPolicy(name: string, baseDir: string): Policy | null
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| baseDir | `string` |  |

**Returns:** `Policy | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L111))

### builtinPolicyNames

```ts
builtinPolicyNames(): string[]
```

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L115))

### checkPolicy

```ts
checkPolicy(policy: Record<string, any>, interrupt: Record<string, any>)
```

Evaluate a policy against an interrupt. Returns approve(), reject(), or propagate() based on the first matching rule.

  @param policy - Ordered rules keyed by interrupt effect; each rule has optional glob-pattern match fields and an action.
  @param interrupt - The interrupt to evaluate.

* Evaluate a policy against a single interrupt. Returns the result
 * of `approve()`, `reject()`, or `propagate()` corresponding to the
 * first matching rule for `interrupt.effect`. If no rule matches
 * (no rules for the effect, or every rule's `match` failed), returns
 * `propagate()` so the next handler in the chain runs.
 *
 * Designed for use inside a custom handler. The CLI sugar
 * (`cliPolicyHandler`) calls this for you.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |
| interrupt | `Record<string, any>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L205))

### validatePolicy

```ts
validatePolicy(policy: Record<string, any>): Result<void>
```

Validate that a policy object is well-formed. Returns { success: true } if valid, or { success: false, error } describing the problem.

  @param policy - The policy object to validate.

* Check that a `Policy` is structurally valid (every entry is an
 * array of `PolicyRule` with a recognised `action`, every `match`
 * is a flat string→string map, etc.). Returns
 * `{ success: true }` or `{ success: false, error: string }`.
 *
 * Call before persisting user-supplied or hand-edited policy data;
 * `writePolicyFile` calls this internally before writing.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |

**Returns:** `Result<void>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L227))

### buildScopedMatch

```ts
buildScopedMatch(
  intr: Record<string, any>,
  fields: ScopedRuleFields,
): Record<string, string>
```

Build a match object for an interrupt, pinned to the configured fields. Returns {} when the effect has no configured fields.

  @param intr - The interrupt whose data fields to pin.
  @param fields - Per-effect config naming which data fields to pin.

* Build the `match` map for a scoped rule by reading the configured
 * fields out of `intr.data`. The returned object is shaped to plug
 * straight into a `PolicyRule.match`:
 *
 * ```ts
 * const match = buildScopedMatch(intr, fields)
 * const rule: PolicyRule = { match: match, action: "approve" }
 * ```
 *
 * For each `ScopedField` configured for `intr.effect`:
 * - The field's value is read from `intr.data`.
 * - If `matchSubpaths: true`, the value is wrapped as
 *   `"{value,value/**}"` so the resulting glob matches both the
 *   exact value and any subpath under it.
 * - If `matchSubpaths: false`, the value is used as-is (literal
 *   match).
 *
 * Fields that are absent from `intr.data` (`null` / `undefined`)
 * are skipped silently. Effects not present in `fields` return `{}`.
 *
 * Most callers should use `recordScopedRule` instead, which calls
 * this internally. `buildScopedMatch` is exposed for callers
 * assembling rules by hand or implementing a custom UI that needs
 * to preview the match before recording.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `Record<string, any>` |  |
| fields | [ScopedRuleFields](#scopedrulefields) |  |

**Returns:** `Record<string, string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L262))

### recordRule

```ts
recordRule(
  policy: Policy,
  effect: InterruptEffect,
  action: "approve" | "reject",
): Policy
```

Return a new policy with a catch-all rule for an effect appended. A single bare rule covers every future interrupt of that effect.

  @param policy - The policy to extend (not mutated).
  @param effect - The interrupt effect the rule applies to.
  @param action - Whether to approve or reject matching interrupts.

* Return a new policy with a catch-all rule (`{ action }` with no
 * `match`) for `effect` appended. Pure — does not mutate the input.
 *
 * ## Precedence trap
 *
 * Evaluation is first-match-wins, so **append order matters**. A
 * second call for the same effect with a different action is dead
 * code:
 *
 * ```ts
 * let p = recordRule({}, "std::read", "reject")
 * p = recordRule(p, "std::read", "approve")  // never reached
 * ```
 *
 * If you're flipping a previously-recorded decision, decide
 * explicitly: either reset the effect's rules first
 * (`{ ...policy, "std::read": [] }` and re-record), or hand-edit
 * `policy[effect]` to replace the offending rule. This function does
 * not try to detect or warn about shadowing on your behalf.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| effect | [InterruptEffect](#interrupteffect) |  |
| action | `"approve" \| "reject"` |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L312))

### recordScopedRule

```ts
recordScopedRule(
  policy: Policy,
  intr: Record<string, any>,
  fields: ScopedRuleFields,
): Policy
```

Return a new policy with a scoped approve rule prepended for the interrupt's effect. The rule pins the configured fields, so it approves only future interrupts matching this one's field values.

  @param policy - The policy to extend (not mutated).
  @param intr - The interrupt whose field values to pin.
  @param fields - Per-effect config naming which data fields to pin.

* Return a new policy with a scoped approve rule prepended for
 * `intr.effect`. The rule's `match` is built by `buildScopedMatch`,
 * so it pins whichever fields are configured for the effect. Pure.
 *
 * Prepended (not appended) so the new, more-specific rule wins
 * over any pre-existing catch-all in first-match-wins order. This
 * makes scoped rules safe to add even if the effect already has a
 * broader rejection: the scoped approval applies first when it
 * matches, otherwise the catch-all takes over.
 *
 * The action is always `"approve"`, because the (ap) UI affordance
 * only makes sense in the affirmative direction. Build a scoped
 * reject by hand if you need one.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| intr | `Record<string, any>` |  |
| fields | [ScopedRuleFields](#scopedrulefields) |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L349))

### parsePolicyFile

```ts
parsePolicyFile(path: string): Result<Policy, ParsePolicyFailure>
```

Read + parse + validate a policy file from disk. Returns {} on any
  failure (missing, unreadable, malformed JSON, invalid schema) with a
  warning to the user.

  @param path - The policy file path

* Read + JSON-parse + validate a policy file from disk. Returns `{}`
 * (an empty policy) on any failure: a missing file, unreadable
 * permissions, malformed JSON, or a schema-validation error. It also
 * prints a warning so the user knows their saved decisions did not
 * carry over.
 *
 * Raises `std::read` (so the caller's handler chain controls
 * whether the read is approved). The CLI handler auto-approves
 * this via `with approve`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<Policy, ParsePolicyFailure>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L395))

### setPolicy

```ts
setPolicy(path: string, policy: Policy)
```

* Set the policy to be used with the CLI handler
  * returned by `cliPolicyHandler`. The handler's internal state
  * is module-level, so this sets the policy for the handler
  * to consult on every interrupt. Call this after loading a policy
  * with `parsePolicyFile` or constructing one by hand.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| policy | [Policy](#policy) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L440))

### writePolicyFile

```ts
writePolicyFile(path: string, policy: Policy, allowedPaths: string[] = [])
```

Validate and write a policy to a JSON file. Throws if the policy is invalid.

  @param path - The destination file path.
  @param policy - The policy to write.
  @param allowedPaths - Restrict writes to these path prefixes; empty allows any path.

* Validate a `Policy` and write it as JSON to `path`. Throws (returns
 * `Failure`) if validation fails. Invalid policies are never
 * persisted.
 *
 * `allowedPaths` is a defense-in-depth allow-list passed straight
 * through to the underlying `write`. Pass `[]` (the default) only
 * when the path is trusted. Otherwise restrict it to a known
 * directory like `["${env("HOME")}/.myapp"]`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| policy | [Policy](#policy) |  |
| allowedPaths | `string[]` | [] |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L456))

### flushPolicy

```ts
flushPolicy()
```

* Force-write the `cliPolicyHandler`'s in-memory policy to disk
 * now. Use between user turns when you want the **last** decision
 * of a session persisted. The handler's own auto-flush runs at the
 * top of the next interrupt, so a decision recorded on the final
 * interrupt of a turn won't survive a crash unless you call this.
 *
 * No-op when there are no pending changes. Auto-approves its own
 * `std::write` via `with approve` (you opted in by installing the
 * handler).

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L521))

### cliPolicyHandler

```ts
cliPolicyHandler(
  file: string,
  fields: ScopedRuleFields,
  policy: Policy | null = null,
): any
```

CLI sugar for an interactive policy handler. Loads and saves the policy file, prompts the user on new interrupts, records "always" decisions, and returns approve/reject. Install on the outermost `handle`. Call exactly once per program — internal state is module-level.

  @param file - Path to the on-disk policy file.
  @param fields - Per-effect config controlling the "approve-always-here" prompt option.
  @param policy - Optional in-memory policy to use directly instead of loading `file` on startup.

* Drop-in policy handler for interactive CLI agents. Returns a
 * function ref you bind to a local variable and install on a `handle`
 * block:
 *
 * ```ts
 * const handler = cliPolicyHandler(
 *   file: "${env("HOME")}/.myapp/policy.json",
 *   fields: { "std::read": [{ field: "dir", matchSubpaths: true }] },
 * )
 * handle {
 *   // every interrupt raised here is filtered through the handler
 * } with handler
 * ```
 *
 * What the handler does:
 *
 * 1. **Loads** the policy file on first invocation. Missing /
 *    malformed files are treated as `{}` with a warning.
 * 2. **Consults the loaded policy** via `checkPolicy`. If a rule
 *    matches, approves or rejects without prompting.
 * 3. **Prompts the user** when no rule applies, showing
 *    (a)/(r)/(aa)/(ap)/(rr). The (ap) option appears only when
 *    `fields` has an entry for the interrupt's effect.
 * 4. **Records "always" decisions** in memory and flushes them to
 *    disk at the top of the next interrupt. Use `flushPolicy()` if
 *    you need the final decision of a session persisted before
 *    process exit.
 *
 * ## Singleton state
 *
 * Internal state (loaded policy, pending-save flag, options) is
 * module-level. Calling `cliPolicyHandler` more than once in the
 * same program silently overwrites the previous options. Only the
 * last `file` / `fields` win. For multi-policy agents, fork the
 * module or use the pure primitives directly.
 *
 * ## Bind-to-variable requirement
 *
 * The `with` clause only accepts an identifier (not a call
 * expression), so you MUST bind the return value to a `const`
 * before using it. This also bypasses the typechecker's
 * handler-raises-interrupt rule, which only resolves direct
 * functionRef names. The flip-flag-first pattern inside the handler
 * provides runtime safety.
 *
 * @param file - Path to the on-disk policy file. Created on first
 *   save. The containing directory must already exist.
 * @param fields - Per-effect config controlling the (ap) prompt
 *   option. Effects not present here don't offer (ap).
 * @param policy - Optional in-memory policy to start from. When
 *   provided, the handler uses it directly and does NOT read `file` on
 *   startup (so there is no load-time `std::read` and no dependency on
 *   `file` existing). New "always" decisions still persist to `file`.
 *   Use for a per-run override that must not be seeded from — or written
 *   over — a saved policy on disk. Omit (null) for the normal
 *   load-from-`file` behavior.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| file | `string` |  |
| fields | [ScopedRuleFields](#scopedrulefields) |  |
| policy | `Policy \| null` | null |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L876))
