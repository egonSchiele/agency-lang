# policy

## Types

### PolicyRule

```ts
export type PolicyRule = {
  match?: object;
  action: "approve" | "reject" | "propagate"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L7))

### Policy

```ts
export type Policy = object
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L13))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L15))

### validatePolicy

```ts
validatePolicy(policy: Record<string, any>)
```

Validate that a policy object is well-formed. Returns { success: true } if valid, or { success: false, error: "..." } with a description of the problem.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| policy | `Record<string, any>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L22))

### writePolicyFile

```ts
writePolicyFile(path: string, policy: Policy)
```

Validate and write a policy to a JSON file. Throws if the policy is invalid.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| policy | [Policy](#policy) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/policy.agency#L29))
