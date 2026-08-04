# Review: Per-Model Cost Breakdown for the Serve Cost Seam

## Verdict

The design puts the feature in the correct layer. Extending the existing `InvocationUsageDelta → recordPaidUsageAt → InvocationUsageMeter → IPC` path keeps accounting topology-independent. It also keeps imperative bucketing inside the meter, behind the existing declarative accounting boundary.

I would not implement the spec unchanged. Two claims that the design treats as invariants are not true: a parenthesized string can collide with a real model name, and independently accumulated JavaScript numbers do not always reconcile with `===`. The public compatibility and version-skew contracts also need explicit decisions.

## Blocking issues

### 1. `"(unattributed)"` is not a collision-free reserved key

The spec says that parentheses prevent a real provider model name from colliding with `"(unattributed)"`. Agency supports custom and local providers, and model identifiers are arbitrary strings. A provider can legally report that exact string.

A collision would merge real model spend with model-less spend. The host would then filter out real spend when it hides the synthetic row. The null-prototype map prevents prototype pollution, but it does not prevent semantic key collisions.

Do not encode attribution kind in a magic model name. Give unattributed usage its own structural field:

```ts
export type InvocationUsage = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  pricingComplete: boolean;
  models: Record<string, ModelUsageRow>;
  unattributed: ModelUsageRow;
};
```

The meter can still accept `model?: string` internally. A missing model updates `unattributed`; a present model updates `models[model]`. This gives the host a declarative interface and removes its need to know or filter a reserved implementation key.

If an empty unattributed row is undesirable on the wire, make `unattributed` optional and define absence as zero. Do not replace it with another reserved string.

### 2. Exact reconciliation with `===` is not preserved by floating-point arithmetic

The spec repeatedly promises:

```ts
sum(models[*].pricedCost) === pricedCost
```

The meter accumulates the flat total in call order while each model row accumulates a different grouping of the same values. Floating-point addition is not associative. Summing the completed rows can differ from the flat total by an ulp even when every delta was recorded correctly.

For example, a sequence of charges split across two models can produce:

```text
flat total: 2.4925859280026548
row sum:    2.492585928002655
```

Choose and document one of these contracts before implementation:

1. **Approximate reconciliation:** require equality within a named tolerance and use the same helper in runtime tests and host validation.
2. **Exact decimal accounting:** store costs in an integer unit or a decimal representation at the accounting boundary. This is a larger change and needs a rounding policy.
3. **One source of truth:** derive the exposed flat total from the exposed breakdown in a deterministic order. This changes the existing total's accumulation order and still requires a stable summation rule.

The smallest safe v1 is approximate reconciliation. Replace every “exactly” and every `===` assertion in the spec with a named tolerance contract. Add a test whose interleaved model charges demonstrate the floating-point ordering difference.

## Important contract gaps

### 3. Adding required `models` changes a public structural type

`InvocationUsage` is exported through the runtime surface. Adding a required field is source-breaking for TypeScript consumers that construct an `InvocationUsage`, even though existing readers continue to work.

The spec calls the feature additive but does not state its compatibility policy. Choose one:

- make the new breakdown optional in the public type for a backward-compatible release while guaranteeing that the current runtime emits it;
- introduce a new versioned usage type; or
- treat this as a major-version change.

The consumer handoff must also say how statelog handles an absent breakdown during rollout. “Absent” should not silently mean “zero spend.”

### 4. A legacy IPC message reconciles but does not provide a truthful model breakdown

The spec maps a child message without `model` to unattributed usage and calls this version-skew safe. That preserves the total, but it loses model attribution. The host would report actual LLM spend as model-less runtime spend.

This conflicts with the stated goal that the breakdown includes subprocess-relayed model spend. The existing `pricingComplete` and `usageComplete` flags do not describe this condition:

- pricing can be complete;
- telemetry delivery can be complete;
- model attribution can still be incomplete.

Either prove that served invocations cannot run a version-skewed child and remove the legacy claim, or add a separate `modelAttributionComplete` signal. A parent that receives a measurable legacy delta without a model should set that signal to `false`. The host can then distinguish a complete unattributed row from a degraded breakdown.

This same signal would support future paid integrations that lose attribution without losing their price.

### 5. The model identity policy needs to be explicit

The proposed call site uses:

```ts
const modelName = completion.model || clientConfig.model || "unknown model";
```

That prefers the provider's returned model over the requested model or alias. This is probably the right billing identity, but the spec should lock it as a contract. Otherwise providers, local model aliases, and fallback routing can produce inconsistent aggregation keys.

Document these rules:

- use the provider-reported model when present;
- otherwise use the resolved/requested model string;
- preserve the string exactly rather than normalizing provider names;
- define the fallback when neither value is available;
- treat an actual model named `"unknown model"` as an ordinary model, not as unattributed usage.

Add a test that proves `completion.model` wins when it differs from `clientConfig.model`.

## Architecture and anti-pattern assessment

The main architecture avoids the “imperative code everywhere” anti-pattern. Callers declare the attribution on a delta. `recordPaidUsageAt` remains the one accounting boundary, and `InvocationUsageMeter.merge` encapsulates the mutable bucketing algorithm. IPC transports the same semantic delta instead of introducing a second aggregation implementation.

The proposed snapshot weakens that design by making consumers interpret a magic key. A separate `unattributed` field restores the declarative boundary: consumers ask for model rows or unattributed usage without knowing how the meter encodes either one.

The proposed `copyModels` helper is justified. It owns the snapshot-copy invariant and prevents callers from mutating live meter state. Keep it local unless another runtime module needs the same operation.

No other catalogued anti-pattern is inherent in the design. The mutable meter is order-sensitive by nature, but the mutation is localized behind a clear API rather than spread across callers.

## Test plan changes

Keep the proposed tests and add these cases:

1. A real model whose name is `"(unattributed)"` remains separate from unattributed spend. This test becomes unnecessary if the sentinel is removed, but it is a required regression test for any sentinel-based design.
2. Interleaved charges across models use the documented reconciliation tolerance rather than `===`.
3. Repeated deltas for one model aggregate into one row.
4. `completion.model` overrides the requested model identity.
5. A measurable legacy IPC delta without a model marks model attribution incomplete, or the test proves that version skew is rejected before execution.
6. A grandchild's model survives both IPC hops. A parent-handler unit test proves one hop only; the feature's central topology claim needs a two-hop assertion.
7. Two concurrent execution contexts do not share model rows.
8. Mutating a row or adding/deleting a key on one snapshot does not affect later snapshots.
9. Error, interrupt, and resume outcomes retain the same breakdown and completeness fields as successful outcomes.

## Recommended spec edits

Before turning this into an implementation plan:

1. Replace the synthetic map key with a structural `unattributed` field.
2. Replace exact floating-point equality with a named reconciliation policy.
3. Add the public type and rollout compatibility decision.
4. Decide whether model-attribution completeness is a third axis or version skew is impossible.
5. Lock the model identity precedence rules.
6. Expand the tests to cover two-hop IPC, concurrency, and all served outcomes.

With those changes, the design is small, declarative, and aligned with the existing serve cost seam.
