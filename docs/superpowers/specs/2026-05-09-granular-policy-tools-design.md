# Granular Policy Tools

## Problem

The current `agencySetPolicy` tool replaces the entire policy object in one call. This has two issues:

1. The MCP client (LLM) must construct a correctly-shaped JSON object, which is error-prone
2. Setting a new policy overwrites any previously set rules, risking accidental data loss

## Design

Replace `agencySetPolicy` with two granular tools: `agencyAddRule` and `agencyRemoveRule`. Together with the existing `agencyGetPolicy` and `agencyClearPolicy`, this gives the MCP client a complete CRUD surface for policy management without needing to construct or replace entire policy objects.

### Tools

**`agencyGetPolicy`** — Returns the current policy as JSON. Unchanged from current implementation.

**`agencyAddRule(kind, action, match?)`** — Appends a single rule to the policy for the given interrupt kind. Creates the kind entry if it doesn't exist.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "kind": { "type": "string", "description": "The interrupt kind to add a rule for (e.g. 'email::send')" },
    "action": { "type": "string", "enum": ["approve", "reject"], "description": "What to do when this rule matches" },
    "match": { "type": "object", "description": "Optional. Keys are interrupt data field names, values are glob patterns. If omitted, the rule is a catch-all." }
  },
  "required": ["kind", "action"]
}
```

**`agencyRemoveRule(kind, ruleIndex)`** — Removes a rule by index from the given interrupt kind. Returns an error if the kind doesn't exist or the index is out of bounds.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "kind": { "type": "string", "description": "The interrupt kind to remove a rule from" },
    "ruleIndex": { "type": "number", "description": "Zero-based index of the rule to remove" }
  },
  "required": ["kind", "ruleIndex"]
}
```

**`agencyClearPolicy`** — Resets the policy to empty (reject-all). Unchanged from current implementation.

### Implementation

**`lib/serve/policyStore.ts`** — Add two methods:

```typescript
addRule(kind: string, rule: PolicyRule): void {
  if (!this.policy[kind]) this.policy[kind] = [];
  this.policy[kind].push(rule);
  this.save();
}

removeRule(kind: string, index: number): void {
  const rules = this.policy[kind];
  if (!rules || index < 0 || index >= rules.length) {
    throw new Error(`No rule at index ${index} for kind '${kind}'`);
  }
  rules.splice(index, 1);
  if (rules.length === 0) delete this.policy[kind];
  this.save();
}
```

**`lib/serve/mcp/adapter.ts`** — Replace `agencySetPolicy` in `POLICY_TOOL_NAMES`, `POLICY_TOOL_DEFINITIONS`, and `handlePolicyTool` with `agencyAddRule` and `agencyRemoveRule`.

**Tests** — Update `policyStore.test.ts` with tests for `addRule` and `removeRule`. Update `adapter.test.ts` to test the new tools instead of `agencySetPolicy`.
