# policy

## Types

### InterruptDataKey

```ts
export type InterruptDataKey = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L9))

### InterruptDataVal

```ts
export type InterruptDataVal = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L11))

### InterruptKind

```ts
export type InterruptKind = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L13))

### PolicyRule

```ts
export type PolicyRule = {
  match?: Record<InterruptDataKey, InterruptDataVal>;
  action: "approve" | "reject" | "propagate"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L15))

### Policy

```ts
export type Policy = Record<InterruptKind, PolicyRule[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L20))

### Decision

```ts
export type Decision =
  | "approve"
  | "reject"
  | "approve-always"
  | "approve-always-here"
  | "reject-always"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L22))

### FieldSpec

```ts
export type FieldSpec = {
  field: string;
  wildcardSubpaths: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L29))

### AlwaysFields

```ts
export type AlwaysFields = Record<InterruptKind, FieldSpec[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L34))

## Functions

### checkPolicy

```ts
checkPolicy(policy: Record<string, any>, interrupt: Record<string, any>)
```

Evaluate a policy against an interrupt. Returns approve(), reject(), or propagate() based on the first matching rule. Policy is a JSON object keyed by interrupt kind, where each kind maps to an ordered array of rules with optional match fields (glob patterns) and an action.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |
| interrupt | `Record<string, any>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L43))

### validatePolicy

```ts
validatePolicy(policy: Record<string, any>)
```

Validate that a policy object is well-formed. Returns { success: true } if valid, or { success: false, error: "..." } with a description of the problem.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L53))

### buildScopedMatch

```ts
buildScopedMatch(intr: Record<string, any>, fields: AlwaysFields): Record<string, string>
```

Given the per-kind FieldSpec[] config, build a match object pinned
  to the meaningful fields of this interrupt. Returns {} when the kind
  isn't in the fields map. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `Record<string, any>` |  |
| fields | [AlwaysFields](#alwaysfields) |  |

**Returns:** `Record<string, string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L60))

### recordRule

```ts
recordRule(policy: Policy, kind: InterruptKind, action: "approve" | "reject"): Policy
```

Return a new policy with a catch-all rule for `kind` appended.
  First-match-wins inside `checkPolicy`, so a single bare rule covers
  every future interrupt of that kind. Pure — no I/O.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| kind | [InterruptKind](#interruptkind) |  |
| action | `"approve" \| "reject"` |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L84))

### recordScopedRule

```ts
recordScopedRule(policy: Policy, intr: Record<string, any>, fields: AlwaysFields): Policy
```

Return a new policy with a scoped approve rule prepended for the
  interrupt's kind. Prepended (not appended) so the more-specific
  rule wins over any later catch-all in first-match-wins order. Pure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | [Policy](#policy) |  |
| intr | `Record<string, any>` |  |
| fields | [AlwaysFields](#alwaysfields) |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L102))

### parsePolicyFile

```ts
parsePolicyFile(path: string): Policy
```

Read + parse + validate a policy file from disk. Returns {} on any
  failure (missing, unreadable, malformed JSON, invalid schema) with a
  warning to the user. Raises std::read.

  @param path - The policy file path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** [Policy](#policy)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L121))

### writePolicyFile

```ts
writePolicyFile(path: string, policy: Policy, allowedPaths: string[])
```

Validate and write a policy to a JSON file. Throws if the policy is invalid. Set allowedPaths to restrict where the policy file may be written.

  @param path - The destination file path
  @param policy - The policy to write
  @param allowedPaths - Only allow writing under these path prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| policy | [Policy](#policy) |  |
| allowedPaths | `string[]` | [] |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L150))

### maybeLoad

```ts
maybeLoad()
```

Lazy-load the on-disk policy on first handler invocation. Uses
  flip-flag-first so the std::read interrupt's chain re-entry sees
  `_loaded == true` and returns without recursing. See
  docs/site/guide/handlers.md §"Fixing it".

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L161))

### maybeFlush

```ts
maybeFlush()
```

Persist any pending policy changes. Same flip-flag-first pattern
  as `maybeLoad`. Runs at the top of every handler invocation so a
  decision recorded on turn N is on disk before turn N+1's first
  interrupt fires. Decisions on the FINAL interrupt of a session
  may not flush — acceptable per spec.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L174))

### flushPolicy

```ts
flushPolicy()
```

Force a write of the in-memory policy to disk. Use between user
  turns if you want the FINAL decision of a session persisted (the
  handler's own auto-flush only fires on the NEXT interrupt).

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L188))

### describeScopedMatch

```ts
describeScopedMatch(intr: any): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L200))

### askUser

```ts
askUser(intr: any): Decision
```

Present the (a)/(r)/(aa)/(ap)/(rr) menu for a single interrupt.
  `(ap)` is offered only when `_opts.fields` has an entry for
  `intr.kind`. Loops until the user enters a valid response.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `any` |  |

**Returns:** [Decision](#decision)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L209))

### _handler

```ts
_handler(intr: any): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L247))

### cliPolicyHandler

```ts
cliPolicyHandler(opts: { file: string; fields: AlwaysFields }): any
```

CLI sugar for an interactive policy handler. Owns load + save +
  prompt + record + return approve/reject. Install on the outermost
  `handle`. Call exactly ONCE per program — internal state is module-
  level (see spec §1.3 "Library-state-is-singleton contract").

  Users of this helper should bind the returned handler to a variable
  before using it with `handle ... with`, e.g.:

      const handler = cliPolicyHandler({ file: ..., fields: ... })
      handle { ... } with handler

  This pattern also bypasses the typechecker's handler-interrupt rule
  (which only resolves direct functionRef names). Runtime safety is
  guaranteed by the flip-flag-first pattern inside the handler body.

  @param opts.file - Path to the on-disk policy file
  @param opts.fields - Per-kind config controlling the "approve-always-here" option

**Parameters:**

| Name | Type | Default |
|---|---|---|
| opts | `{ file: string; fields: AlwaysFields }` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L280))
