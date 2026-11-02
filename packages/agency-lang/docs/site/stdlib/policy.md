---
name: "policy"
description: "Match interrupts against saved approval rules."
---

# policy

```ts
import { checkPolicy } from "std::policy"

const policy = {
  "std::read": [{ action: "approve" }],
  "std::write": [{ action: "reject", rejectMessage: "Leave files unchanged." }]
}

node main() {
  handle {
    return read("README.md")
  } with (intr) {
    return checkPolicy(policy, intr)
  }
}
```

Rules match an effect and optional glob patterns over its data. The first
matching rule decides. If no effect-specific rule matches, `checkPolicy`
tries the `"*"` rules, then returns `propagate()` to request a user decision.
Other handlers can still reject an approved interrupt.

Use `cliPolicyHandler` for a terminal prompt that remembers "always"
answers in a JSON policy file. Use the rule-building functions below when
your application provides its own approval UI.

## Types

### InterruptDataKey

Key of an interrupt's `data` object (e.g. `"dir"`, `"command"`).

```ts
/** Key of an interrupt's `data` object (e.g. `"dir"`, `"command"`). */
export type InterruptDataKey = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L63))

### InterruptDataVal

Glob pattern used to match an interrupt-data value. Patterns are
 picomatch globs. They support `*`, `**`, and brace-expansion like
 `{a,b}` for unions. A literal string with no glob metacharacters
 matches only that exact value.

```ts
/**
 Glob pattern used to match an interrupt-data value. Patterns are
 picomatch globs. They support `*`, `**`, and brace-expansion like
 `{a,b}` for unions. A literal string with no glob metacharacters
 matches only that exact value.
 */
export type InterruptDataVal = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L71))

### InterruptEffect

Identifier for an interrupt's effect (e.g. `"std::read"`,
 `"myapp::deploy"`).

```ts
/**
 Identifier for an interrupt's effect (e.g. `"std::read"`,
 `"myapp::deploy"`).
 */
export type InterruptEffect = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L77))

### PolicyRule

One row of a `Policy`. A rule passes if every key in `match` is
 present in the interrupt's `data` and its value matches the glob
 pattern. Omit `match` (or set it to `{}`) for a catch-all that
 applies to every interrupt of the parent effect.

 A reject rule may carry a `rejectMessage`: the message the rejection
 hands back to whoever raised the interrupt. For a rejected tool call
 this is what the model reads, so it can steer the next attempt — for
 example, a rule rejecting `std::bash` with
 `rejectMessage: "Use safeBash instead"`.

```ts
/**
 One row of a `Policy`. A rule passes if every key in `match` is
 present in the interrupt's `data` and its value matches the glob
 pattern. Omit `match` (or set it to `{}`) for a catch-all that
 applies to every interrupt of the parent effect.

 A reject rule may carry a `rejectMessage`: the message the rejection
 hands back to whoever raised the interrupt. For a rejected tool call
 this is what the model reads, so it can steer the next attempt — for
 example, a rule rejecting `std::bash` with
 `rejectMessage: "Use safeBash instead"`.
 */
export type PolicyRule = {
  match?: Record<InterruptDataKey, InterruptDataVal>;
  action: "approve" | "reject" | "propagate";
  rejectMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L91))

### Policy

Ordered rules per effect, with optional `"*"` fallback rules.
`checkPolicy` returns the first matching decision, or `propagate()`
when no rule matches. Propagation requests a user decision unless a
handler rejects the interrupt.

```ts
/**
 Ordered rules per effect, with optional `"*"` fallback rules.
`checkPolicy` returns the first matching decision, or `propagate()`
when no rule matches. Propagation requests a user decision unless a
handler rejects the interrupt.
 */
export type Policy = Record<InterruptEffect, PolicyRule[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L103))

### Decision

CLI approval choices. "Always" choices save an effect-wide rule;
"approve-always-here" saves a rule scoped to selected interrupt data.
Questions that need a value offer one-time choices only.

```ts
/**
CLI approval choices. "Always" choices save an effect-wide rule;
"approve-always-here" saves a rule scoped to selected interrupt data.
Questions that need a value offer one-time choices only.
*/
export type Decision =
  | "approve"
  | "reject"
  | "approve-always"
  | "approve-always-here"
  | "reject-always"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L142))

### ScopedField

One column in a `ScopedRuleFields` entry — names an interrupt-data
 field that the "approve-always-here" rule should pin.

 - `field` — the key in `intr.data` to pin (e.g. `"dir"`).
 - `matchSubpaths` — when `true`, brace-expand the value so the
   rule matches both the exact value AND any nested path under it.
   Pass `true` for directory-like fields (so approving `/tmp/x`
   also approves `/tmp/x/sub/file.txt`). Pass `false` for opaque
   identifiers (commands, IDs, env names) that shouldn't fan out.

```ts
/**
 One column in a `ScopedRuleFields` entry — names an interrupt-data
 field that the "approve-always-here" rule should pin.

 - `field` — the key in `intr.data` to pin (e.g. `"dir"`).
 - `matchSubpaths` — when `true`, brace-expand the value so the
   rule matches both the exact value AND any nested path under it.
   Pass `true` for directory-like fields (so approving `/tmp/x`
   also approves `/tmp/x/sub/file.txt`). Pass `false` for opaque
   identifiers (commands, IDs, env names) that shouldn't fan out.
 */
export type ScopedField = {
  field: string;
  matchSubpaths: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L160))

### ScopedRuleFields

Per-effect override consumed by `buildScopedMatch` and the
 `cliPolicyHandler`. Maps an interrupt effect to the fields its
 "approve-always-here" rule should pin. Effects not present in this
 map fall back to the scope their `effect` declaration carries
 (`@always` / `@alwaysUnder`); an empty list turns the (ap) option
 off for that effect, so the user falls back to (a) / (r) / (aa) / (rr).

 Example:
 ```ts
 const FIELDS: ScopedRuleFields = {
   "std::read":  [{ field: "dir", matchSubpaths: true }],
   "std::exec":  [
     { field: "command",    matchSubpaths: false },
     { field: "subcommand", matchSubpaths: false },
   ],
 }
 ```

````ts
/**
 Per-effect override consumed by `buildScopedMatch` and the
 `cliPolicyHandler`. Maps an interrupt effect to the fields its
 "approve-always-here" rule should pin. Effects not present in this
 map fall back to the scope their `effect` declaration carries
 (`@always` / `@alwaysUnder`); an empty list turns the (ap) option
 off for that effect, so the user falls back to (a) / (r) / (aa) / (rr).

 Example:
 ```ts
 const FIELDS: ScopedRuleFields = {
   "std::read":  [{ field: "dir", matchSubpaths: true }],
   "std::exec":  [
     { field: "command",    matchSubpaths: false },
     { field: "subcommand", matchSubpaths: false },
   ],
 }
 ```
 */
export type ScopedRuleFields = Record<InterruptEffect, ScopedField[]>
````

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L184))

### ParsePolicyFailureStatus

```ts
export type ParsePolicyFailureStatus =
  | "doesnt-exist"
  | "read-error"
  | "malformed-json"
  | "policy-not-valid"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L378))

### ParsePolicyFailure

```ts
export type ParsePolicyFailure = {
  status: ParsePolicyFailureStatus
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L384))

## Constants

### minimalAutoApprovePolicy

```ts
export static const minimalAutoApprovePolicy = _minimalAutoApprovePolicy
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L106))

### recommendedAutoApprovePolicy

```ts
export static const recommendedAutoApprovePolicy = _recommendedAutoApprovePolicy
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L108))

### approveAllPolicy

```ts
export static const approveAllPolicy = _approveAllPolicy
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L110))

### BUILTIN_POLICIES

```ts
export static const BUILTIN_POLICIES = _BUILTIN_POLICIES
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L112))

## Functions

### withWritesPolicy

```ts
withWritesPolicy(baseDir: string)
```

Return the recommended policy with file and Git writes scoped to a directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseDir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L114))

### builtinPolicy

```ts
builtinPolicy(name: string, baseDir: string): Policy | null
```

Resolve a built-in policy name, or return null for an unknown name.

  @param baseDir - Directory scope for the with-writes policy.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| baseDir | `string` |  |

**Returns:** `Policy | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L121))

### builtinPolicyNames

```ts
builtinPolicyNames(): string[]
```

List the policy names accepted by builtinPolicy and the CLI.

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L130))

### checkPolicy

```ts
checkPolicy(policy: Record<string, any>, interrupt: Record<string, any>)
```

Find the first matching approval rule for an interrupt.
  Return approve, reject, or propagate when no rule matches.

```ts
handle {
  return read("README.md")
} with (intr) {
  return checkPolicy(policy, intr)
}
```

Return this decision directly from a custom handler. A rejection includes
the rule's `rejectMessage`. No matching rule returns `propagate()`, which
requests a user decision even if another handler approves.
Use `cliPolicyHandler` when you also want terminal prompts and saved rules.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |
| interrupt | `Record<string, any>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L228))

### validatePolicy

```ts
validatePolicy(policy: Record<string, any>): Result<void>
```

Validate a policy object, returning a failure that describes invalid rules.

Check user-supplied or hand-edited policy data before using it.
`setPolicy` and `addPolicyRules` also validate before saving.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |

**Returns:** `Result<void>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L243))

### alwaysScopeFor

```ts
alwaysScopeFor(effect: string): ScopedField[]
```

List the fields declared by an effect's @always and @alwaysUnder tags.
  Return an empty list when the effect declares no scope.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| effect | `string` |  |

**Returns:** `ScopedField[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L250))

### defaultScopedFields

```ts
defaultScopedFields(): ScopedRuleFields
```

Return the declared approval scopes for all effects, keyed by effect name.

**Returns:** [ScopedRuleFields](#scopedrulefields)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L258))

### buildScopedMatch

```ts
buildScopedMatch(
  intr: Record<string, any>,
  fields: ScopedRuleFields = {},
): Record<string, string>
```

Build glob patterns that pin an interrupt's scoped field values.
  Return {} if there is no scope or a scoped value is missing.

  @param fields - Per-effect scope overrides, with unlisted effects using their declared scopes.

Use this to preview a scoped rule in a custom approval UI:

```ts
const match = buildScopedMatch(intr)
```

Directory fields can match the selected directory and its subpaths; other
fields match their escaped literal values. Overrides in `fields` replace
declared scopes.

An absent scope or missing scoped value returns `{}`. Check for an empty
result before making a rule: an empty `match` applies to every interrupt
of the effect. `recordScopedRule` performs that check for you.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `Record<string, any>` |  |
| fields | [ScopedRuleFields](#scopedrulefields) | {} |

**Returns:** `Record<string, string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L291))

### recordRule

```ts
recordRule(
  policy: Policy,
  effect: InterruptEffect,
  action: "approve" | "reject",
): Policy
```

Append an effect-wide approval or rejection rule and return a new policy.

```ts
let policy = recordRule({}, "std::read", "reject")
policy = recordRule(policy, "std::read", "approve")
```

The first rule still rejects: evaluation uses the first match, and this
function appends rules. Replace or clear an existing rule when changing
a previous decision. The input policy remains unchanged.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| effect | [InterruptEffect](#interrupteffect) |  |
| action | `"approve" \| "reject"` |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L328))

### recordScopedRule

```ts
recordScopedRule(
  policy: Policy,
  intr: Record<string, any>,
  fields: ScopedRuleFields = {},
): Policy
```

Prepend an approval rule scoped to an interrupt's field values.
  Return the policy unchanged when there is no scope to pin.

  @param fields - Per-effect scope overrides, with unlisted effects using their declared scopes.

Use this for an "approve always here" choice. It prepends an approval,
so a matching scoped rule takes precedence over existing catch-all rules.
The input policy remains unchanged. If no scope can be built, it returns
the input policy without adding a rule.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| intr | `Record<string, any>` |  |
| fields | [ScopedRuleFields](#scopedrulefields) | {} |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L352))

### parsePolicyFile

```ts
parsePolicyFile(path: string): Result<Policy, ParsePolicyFailure>
```

Read a JSON policy file and validate its rules, returning a failure on error.

Use the failure's `data.status` to distinguish a missing file, a failed
read, malformed JSON, and an invalid policy. The function prints no warnings.
Its inner read uses `with approve`; an outer handler can still reject it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<Policy, ParsePolicyFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L393))

### setPolicy

```ts
setPolicy(path: string, policy: Policy): Result raises <std::write>
```

Save a policy file and install it for the CLI approval handler.

Save a policy to `path`, then make it the CLI handler's active policy.
The save raises `std::write`, so the caller's handlers decide whether it
happens. If the save fails or is rejected, the active policy is unchanged.
Later saves of "always" answers still go to the file passed to
`cliPolicyHandler`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| policy | [Policy](#policy) |  |

**Returns:** `Result`

**Throws:** `std::write`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L433))

### missingPolicyRules

```ts
missingPolicyRules(base: Policy): Policy
```

Find rules in a base policy that the CLI handler's active policy lacks.

  @param base - Policy to compare against, such as recommendedAutoApprovePolicy.

Use this to offer updates when a saved policy lacks rules added to a newer
built-in policy. Effects already covered by a catch-all are left out.
Pass accepted additions to `addPolicyRules`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| base | [Policy](#policy) |  |

**Returns:** [Policy](#policy)

**Throws:** `std::read`

**Needs:** `fileRead`, `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L567))

### addPolicyRules

```ts
addPolicyRules(additions: Policy) raises <std::read, std::write>
```

Append rules to the CLI handler's active policy and save it immediately.

  @param additions - Rules to add, such as the result of missingPolicyRules.

Append accepted additions without overriding earlier decisions. If saving
fails, the active policy stays unchanged.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| additions | [Policy](#policy) |  |

**Throws:** `std::write`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L582))

### flushPolicy

```ts
flushPolicy() raises <std::write>
```

Write any pending always-rule additions to the policy file now.

Call between user turns or before process exit to persist the last "always"
decision. Automatic flushing happens at the next interrupt, so the final
decision can otherwise remain unsaved. Does nothing without pending changes.
If a handler refuses the save, the answers stay pending and a warning prints.

**Throws:** `std::write`

**Needs:** `fileRead`, `fileWrite`, `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L607))

### cliPolicyHandler

```ts
cliPolicyHandler(
  file: string,
  fields: ScopedRuleFields = {},
  policy: Policy | null = null,
  interactive: boolean = true,
): any
```

Build a CLI approval handler that remembers decisions in a policy file.
  Call once per program and bind the result before installing it.

  @param file - Policy file path whose parent directory already exists.
  @param fields - Per-effect scope overrides, with [] disabling scoped approval for an effect.
  @param policy - Initial rules to use instead of reading the file, or null to load it.
  @param interactive - Prompt for unresolved interrupts when true, or reject them when false.

```ts
const handler = cliPolicyHandler(file: "/home/me/.myapp/policy.json")
handle {
  return read("README.md")
} with handler
```

Bind the returned function before using it in a `with` clause. Call once
per program: the handler shares module-level policy state, and another call
replaces its options and active policy.

It loads the file on the first interrupt unless you supply `policy`.
A missing file starts with an empty policy. Other load errors also start
empty and print a warning. Rules approve or reject matching interrupts;
questions that need a value still require an answer. Unresolved interrupts
prompt when interactive and fail when noninteractive.

"Always" decisions persist at the next interrupt. Call `flushPolicy` before
exiting to save the final decision. Supplying `policy` skips the initial
read; later decisions still save to `file`. The file's parent directory
must already exist.

"Approve always here" uses scopes from effect declarations unless `fields`
overrides them. An empty override disables that choice for the effect.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| file | `string` |  |
| fields | [ScopedRuleFields](#scopedrulefields) | {} |
| policy | `Policy \| null` | null |
| interactive | `boolean` | true |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/policy.agency#L1269))
