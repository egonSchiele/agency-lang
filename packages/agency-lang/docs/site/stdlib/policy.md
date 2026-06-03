# policy

## Types

### InterruptDataKey

Key of an interrupt's `data` object (e.g. `"dir"`, `"command"`).

```ts
/** Key of an interrupt's `data` object (e.g. `"dir"`, `"command"`). */
export type InterruptDataKey = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L131))

### InterruptDataVal

* Glob pattern used to match an interrupt-data value. Patterns are
 * picomatch globs — supports `*`, `**`, and brace-expansion like
 * `{a,b}` for unions. A literal string with no glob metacharacters
 * matches only that exact value.

```ts
/**
 * Glob pattern used to match an interrupt-data value. Patterns are
 * picomatch globs — supports `*`, `**`, and brace-expansion like
 * `{a,b}` for unions. A literal string with no glob metacharacters
 * matches only that exact value.
 */
export type InterruptDataVal = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L139))

### InterruptKind

* Identifier for an interrupt's kind (e.g. `"std::read"`,
 * `"myapp::deploy"`).

```ts
/**
 * Identifier for an interrupt's kind (e.g. `"std::read"`,
 * `"myapp::deploy"`).
 */
export type InterruptKind = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L145))

### PolicyRule

* One row of a `Policy`. A rule passes if every key in `match` is
 * present in the interrupt's `data` and its value matches the glob
 * pattern. Omit `match` (or set it to `{}`) for a catch-all that
 * applies to every interrupt of the parent kind.

```ts
/**
 * One row of a `Policy`. A rule passes if every key in `match` is
 * present in the interrupt's `data` and its value matches the glob
 * pattern. Omit `match` (or set it to `{}`) for a catch-all that
 * applies to every interrupt of the parent kind.
 */
export type PolicyRule = {
  match?: Record<InterruptDataKey, InterruptDataVal>;
  action: "approve" | "reject" | "propagate"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L153))

### Policy

* A policy: ordered rules per interrupt kind. `checkPolicy` walks
 * the array for `intr.kind` in order and returns on the first
 * matching rule. If no rule for the kind exists, evaluation falls
 * through to `propagate` (i.e. ask the next handler in the chain).

```ts
/**
 * A policy: ordered rules per interrupt kind. `checkPolicy` walks
 * the array for `intr.kind` in order and returns on the first
 * matching rule. If no rule for the kind exists, evaluation falls
 * through to `propagate` (i.e. ask the next handler in the chain).
 */
export type Policy = Record<InterruptKind, PolicyRule[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L164))

### Decision

* The five answers `cliPolicyHandler`'s prompt accepts:
 * - `"approve"` / `"reject"` — one-off (a) / (r).
 * - `"approve-always"` / `"reject-always"` — (aa) / (rr); records a
 *   catch-all rule for the kind so future interrupts of this kind
 *   resolve without prompting.
 * - `"approve-always-here"` — (ap); records a scoped rule pinned to
 *   whichever fields you listed in `ScopedRuleFields` for this kind.
 *   Only offered when the kind has an entry in the config.

```ts
/**
 * The five answers `cliPolicyHandler`'s prompt accepts:
 * - `"approve"` / `"reject"` — one-off (a) / (r).
 * - `"approve-always"` / `"reject-always"` — (aa) / (rr); records a
 *   catch-all rule for the kind so future interrupts of this kind
 *   resolve without prompting.
 * - `"approve-always-here"` — (ap); records a scoped rule pinned to
 *   whichever fields you listed in `ScopedRuleFields` for this kind.
 *   Only offered when the kind has an entry in the config.
 */
export type Decision =
  | "approve"
  | "reject"
  | "approve-always"
  | "approve-always-here"
  | "reject-always"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L176))

### ScopedField

* One column in a `ScopedRuleFields` entry — names an interrupt-data
 * field that the "approve-always-here" rule should pin.
 *
 * - `field` — the key in `intr.data` to pin (e.g. `"dir"`).
 * - `matchSubpaths` — when `true`, brace-expand the value so the
 *   rule matches both the exact value AND any nested path under it.
 *   Pass `true` for directory-like fields (so approving `/tmp/x`
 *   also approves `/tmp/x/sub/file.txt`); pass `false` for opaque
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
 *   also approves `/tmp/x/sub/file.txt`); pass `false` for opaque
 *   identifiers (commands, IDs, env names) that shouldn't fan out.
 */
export type ScopedField = {
  field: string;
  matchSubpaths: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L194))

### ScopedRuleFields

* Per-kind configuration consumed by `buildScopedMatch` and the
 * `cliPolicyHandler`. Maps each interrupt kind to the fields its
 * "approve-always-here" rule should pin. Kinds not present in this
 * map don't offer the (ap) prompt option — the user falls back to
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
 * Per-kind configuration consumed by `buildScopedMatch` and the
 * `cliPolicyHandler`. Maps each interrupt kind to the fields its
 * "approve-always-here" rule should pin. Kinds not present in this
 * map don't offer the (ap) prompt option — the user falls back to
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
export type ScopedRuleFields = Record<InterruptKind, ScopedField[]>
````

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L217))

### AskUserResult

* Result returned by `askUser`. When the user picks a known key,
 * `action` is the corresponding `Decision` and `reason` is null.
 * When `allowFreeText` lets the user type a free-form rejection
 * reason, `action` is `"reject"` and `reason` is the typed text —
 * the handler uses it as the reject reason directly, skipping the
 * follow-up "Why are you rejecting?" prompt.

```ts
/**
 * Result returned by `askUser`. When the user picks a known key,
 * `action` is the corresponding `Decision` and `reason` is null.
 * When `allowFreeText` lets the user type a free-form rejection
 * reason, `action` is `"reject"` and `reason` is the typed text —
 * the handler uses it as the reject reason directly, skipping the
 * follow-up "Why are you rejecting?" prompt.
 */
type AskUserResult = {
  action: Decision;
  reason: string | null
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L537))

## Functions

### checkPolicy

```ts
checkPolicy(policy: Record<string, any>, interrupt: Record<string, any>)
```

Evaluate a policy against an interrupt. Returns approve(), reject(), or propagate() based on the first matching rule. Policy is a JSON object keyed by interrupt kind, where each kind maps to an ordered array of rules with optional match fields (glob patterns) and an action.

* Evaluate a policy against a single interrupt. Returns the result
 * of `approve()`, `reject()`, or `propagate()` corresponding to the
 * first matching rule for `interrupt.kind`. If no rule matches
 * (no rules for the kind, or every rule's `match` failed), returns
 * `propagate()` so the next handler in the chain runs.
 *
 * Designed for use inside a custom handler. The CLI sugar
 * (`cliPolicyHandler`) calls this for you.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |
| interrupt | `Record<string, any>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L239))

### validatePolicy

```ts
validatePolicy(policy: Record<string, any>)
```

Validate that a policy object is well-formed. Returns { success: true } if valid, or { success: false, error: "..." } with a description of the problem.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L258))

### buildScopedMatch

```ts
buildScopedMatch(intr: Record<string, any>, fields: ScopedRuleFields): Record<string, string>
```

Given the per-kind ScopedField[] config, build a match object pinned
  to the meaningful fields of this interrupt. Returns {} when the kind
  isn't in the fields map. Pure.

* Build the `match` map for a scoped rule by reading the configured
 * fields out of `intr.data`. The returned object is shaped to plug
 * straight into a `PolicyRule.match`:
 *
 * ```ts
 * const match = buildScopedMatch(intr, fields)
 * const rule: PolicyRule = { match: match, action: "approve" }
 * ```
 *
 * For each `ScopedField` configured for `intr.kind`:
 * - The field's value is read from `intr.data`.
 * - If `matchSubpaths: true`, the value is wrapped as
 *   `"{value,value/**}"` so the resulting glob matches both the
 *   exact value and any subpath under it.
 * - If `matchSubpaths: false`, the value is used as-is (literal
 *   match).
 *
 * Fields that are absent from `intr.data` (`null` / `undefined`)
 * are skipped silently. Kinds not present in `fields` return `{}`.
 *
 * Most callers should use `recordScopedRule` instead, which calls
 * this internally; `buildScopedMatch` is exposed for callers
 * assembling rules by hand or implementing a custom UI that needs
 * to preview the match before recording.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `Record<string, any>` |  |
| fields | [ScopedRuleFields](#scopedrulefields) |  |

**Returns:** `Record<string, string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L291))

### recordRule

```ts
recordRule(policy: Policy, kind: InterruptKind, action: "approve" | "reject"): Policy
```

Return a new policy with a catch-all rule for `kind` appended.
  First-match-wins inside `checkPolicy`, so a single bare rule covers
  every future interrupt of that kind. Pure — no I/O.

  WARNING: append order matters. A second call for the same kind with
  a different action is dead — the earlier rule wins. Reset the kind's
  rules first if you want to flip a previous decision.

* Return a new policy with a catch-all rule (`{ action }` with no
 * `match`) for `kind` appended. Pure — does not mutate the input.
 *
 * ## Precedence trap
 *
 * Evaluation is first-match-wins, so **append order matters**. A
 * second call for the same kind with a different action is dead
 * code:
 *
 * ```ts
 * let p = recordRule({}, "std::read", "reject")
 * p = recordRule(p, "std::read", "approve")  // never reached
 * ```
 *
 * If you're flipping a previously-recorded decision, decide
 * explicitly: either reset the kind's rules first
 * (`{ ...policy, "std::read": [] }` and re-record), or hand-edit
 * `policy[kind]` to replace the offending rule. This function does
 * not try to detect or warn about shadowing on your behalf.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| kind | [InterruptKind](#interruptkind) |  |
| action | `"approve" \| "reject"` |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L340))

### recordScopedRule

```ts
recordScopedRule(policy: Policy, intr: Record<string, any>, fields: ScopedRuleFields): Policy
```

Return a new policy with a scoped approve rule prepended for the
  interrupt's kind. Prepended (not appended) so the more-specific
  rule wins over any later catch-all in first-match-wins order. Pure.

* Return a new policy with a scoped approve rule prepended for
 * `intr.kind`. The rule's `match` is built by `buildScopedMatch`,
 * so it pins whichever fields are configured for the kind. Pure.
 *
 * Prepended (not appended) so the new, more-specific rule wins
 * over any pre-existing catch-all in first-match-wins order. This
 * makes scoped rules safe to add even if the kind already has a
 * broader rejection: the scoped approval applies first when it
 * matches, otherwise the catch-all takes over.
 *
 * The action is always `"approve"` — the (ap) UI affordance only
 * makes sense in the affirmative direction. Build a scoped reject
 * by hand if you need one.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| intr | `Record<string, any>` |  |
| fields | [ScopedRuleFields](#scopedrulefields) |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L379))

### parsePolicyFile

```ts
parsePolicyFile(path: string): Policy
```

Read + parse + validate a policy file from disk. Returns {} on any
  failure (missing, unreadable, malformed JSON, invalid schema) with a
  warning to the user. Raises std::read.

  @param path - The policy file path

* Read + JSON-parse + validate a policy file from disk. Returns `{}`
 * (an empty policy) on any failure — missing file, unreadable
 * permissions, malformed JSON, or schema-validation error — after
 * printing a warning so the user knows their saved decisions did
 * not carry over.
 *
 * Raises `std::read` (so the caller's handler chain controls
 * whether the read is approved); the CLI handler auto-approves
 * this via `with approve`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L412))

### writePolicyFile

```ts
writePolicyFile(path: string, policy: Policy, allowedPaths: string[])
```

Validate and write a policy to a JSON file. Throws if the policy is invalid. Set allowedPaths to restrict where the policy file may be written.

  @param path - The destination file path
  @param policy - The policy to write
  @param allowedPaths - Only allow writing under these path prefixes

* Validate a `Policy` and write it as JSON to `path`. Throws (returns
 * `Failure`) if validation fails — invalid policies are never
 * persisted.
 *
 * `allowedPaths` is a defense-in-depth allow-list passed straight
 * through to the underlying `write`. Pass `[]` (the default) only
 * when the path is trusted; otherwise restrict it to a known
 * directory like `["${env("HOME")}/.myapp"]`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| policy | [Policy](#policy) |  |
| allowedPaths | `string[]` | [] |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L455))

### maybeLoad

```ts
maybeLoad()
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L474))

### maybeFlush

```ts
maybeFlush()
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L487))

### flushPolicy

```ts
flushPolicy()
```

* Force-write the `cliPolicyHandler`'s in-memory policy to disk
 * now. Use between user turns when you want the **last** decision
 * of a session persisted: the handler's own auto-flush runs at the
 * top of the next interrupt, so a decision recorded on the final
 * interrupt of a turn won't survive a crash unless you call this.
 *
 * No-op when there are no pending changes. Auto-approves its own
 * `std::write` via `with approve` (you opted in by installing the
 * handler).

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L506))

### describeScopedMatch

```ts
describeScopedMatch(intr: any): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L516))

### askUser

```ts
askUser(intr: any): AskUserResult
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `any` |  |

**Returns:** [AskUserResult](#askuserresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L551))

### _handler

```ts
_handler(intr: any): any
```

* Internal — the actual handler function returned by
 * `cliPolicyHandler`. Exported so module-level codegen can resolve
 * the function reference when you write `handle ... with handler`.
 * Do not call directly; use `cliPolicyHandler` to construct one.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L625))

### cliPolicyHandler

```ts
cliPolicyHandler(opts: { file: string; fields: ScopedRuleFields }): any
```

CLI sugar for an interactive policy handler. Owns load + save +
  prompt + record + return approve/reject. Install on the outermost
  `handle`. Call exactly ONCE per program — internal state is module-
  level.

  Users of this helper should bind the returned handler to a variable
  before using it with `handle ... with`, e.g.:

  const handler = cliPolicyHandler({ file: ..., fields: ... })
  handle { ... } with handler

  @param opts.file - Path to the on-disk policy file
  @param opts.fields - Per-kind config controlling the "approve-always-here" option

* Drop-in policy handler for interactive CLI agents. Returns a
 * function ref you bind to a local variable and install on a `handle`
 * block:
 *
 * ```ts
 * const handler = cliPolicyHandler({
 *   file: "${env("HOME")}/.myapp/policy.json",
 *   fields: { "std::read": [{ field: "dir", matchSubpaths: true }] },
 * })
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
 *    `fields` has an entry for the interrupt's kind.
 * 4. **Records "always" decisions** in memory and flushes them to
 *    disk at the top of the next interrupt. Use `flushPolicy()` if
 *    you need the final decision of a session persisted before
 *    process exit.
 *
 * ## Singleton state
 *
 * Internal state (loaded policy, pending-save flag, options) is
 * module-level. Calling `cliPolicyHandler` more than once in the
 * same program silently overwrites the previous options — only the
 * last `file` / `fields` win. For multi-policy agents, fork the
 * module or use the pure primitives directly.
 *
 * ## Bind-to-variable requirement
 *
 * The `with` clause only accepts an identifier (not a call
 * expression), so you MUST bind the return value to a `const`
 * before using it. This also bypasses the typechecker's
 * handler-raises-interrupt rule, which only resolves direct
 * functionRef names — runtime safety is provided by the
 * flip-flag-first pattern inside the handler.
 *
 * @param opts.file - Path to the on-disk policy file. Created on
 *   first save; the containing directory must already exist.
 * @param opts.fields - Per-kind config controlling the (ap) prompt
 *   option. Kinds not present here don't offer (ap).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| opts | `{ file: string; fields: ScopedRuleFields }` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L724))
