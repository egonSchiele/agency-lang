# Review: Per-Model Cost Breakdown Implementation Plan

## Verdict

The plan follows the right ownership path and is close to executable. It keeps flat billing unchanged, puts model bucketing inside `InvocationUsageMeter`, and routes subprocess attribution through the existing accounting boundary.

Do not execute it unchanged. The proposed wire format cannot distinguish legitimate model-less spend from model attribution lost to a version-skewed child. As a result, `modelAttributionComplete` can remain `true` when the breakdown is incomplete. Several tests also claim to prove behavior that they do not exercise.

## Blocking issue: the wire representation loses attribution provenance

Task 4 marks attribution incomplete only for the old `{ type: "telemetry", costUsd }` message. That is not the only relevant version-skew path.

The immediately preceding runtime from PR #801 already emits full `invocationUsage` messages, but those messages do not contain `model`. A child running that runtime sends:

```ts
{
  type: "invocationUsage",
  pricedCost: 0.1,
  inputTokens: 100,
  outputTokens: 20,
  unknownCostCallCount: 0,
}
```

The planned parent normalizes this to `model: undefined`, books it to `unattributed`, and leaves `modelAttributionComplete === true`. That is the exact degraded-attribution case the third completeness axis is meant to expose.

The parent cannot infer whether a model-less full delta came from:

- a current runtime intentionally reporting `addCost`; or
- an older runtime reporting an LLM completion before the wire had a model field.

An optional `model` scalar does not carry enough information. Replace it on the wire with an explicit attribution discriminator. For example:

```ts
type UsageAttribution =
  | { kind: "model"; model: string }
  | { kind: "unattributed" };

type IpcInvocationUsageMessage = {
  type: "invocationUsage";
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  unknownCostCallCount: number;
  attribution?: UsageAttribution;
};
```

Current completion deltas send `{ kind: "model", model }`. Current `addCost` deltas send `{ kind: "unattributed" }`. A measurable legacy message with no discriminator is booked to `unattributed` **and** marks model attribution incomplete. Pure unknown-attempt deltas can remain invocation-level and need no row.

The internal delta can use the same discriminator. That makes the accounting interface declarative and prevents an absent optional field from carrying two incompatible meanings.

`modelAttributionComplete` is not safely cuttable while the code accepts version-skewed IPC. It is cuttable only if the implementation rejects all children that do not send the new attribution discriminator before accepting their usage.

## Important plan corrections

### 1. The floating-point test does not demonstrate the stated failure

Task 1 says its interleaved test covers a case where `===` fails, but the test runs every `a` charge and then every `b` charge:

```ts
for (const c of a) ...
for (const c of b) ...
```

That is grouped, not interleaved. The flat accumulation order can match the row-sum grouping, and the test never asserts that strict equality differs.

Use a fixed sequence of `{ model, cost }` entries known to produce different floating-point results. Merge them in that exact interleaved order. Assert both:

```ts
expect(rowSum).not.toBe(usage.pricedCost);
expect(Math.abs(rowSum - usage.pricedCost)).toBeLessThanOrEqual(tolerance);
```

### 2. The model-identity test does not test model identity precedence

Task 2 directly calls:

```ts
accountCompletionUsage(..., "opus-4.8")
```

This proves that the supplied key reaches the meter. It does not prove that `completion.model` wins over `clientConfig.model`; that choice happens in `prompt.ts` before this function runs.

Extract the existing precedence into a small pure helper such as `resolveCompletionModel(completionModel, configuredModel)`, use it at the prompt call site, and test the three locked branches directly. Alternatively, test the real prompt path. Do not label a downstream plumbing test as proof of upstream selection behavior.

### 3. The proposed `RuntimeContext` fixture is not valid code

The plan shows:

```ts
new RuntimeContext<GraphState>(undefined as any)
```

The current tests already have the correct constructor pattern with `statelogConfig`, `smoltalkDefaults`, and `dirname`. Copy that exact helper into the test or reuse an existing test utility. An implementation plan should not leave a known-invalid fixture for the worker to rediscover.

### 4. The send side needs a direct test

Task 3 tests `handleInvocationUsageMessage`, which proves the receiving side. It does not prove that `sendInvocationUsageToParent` includes the model/attribution field when it spreads the delta.

Extend `costTelemetry.test.ts` with a `process.send` assertion for both a modeled completion and an explicitly unattributed charge. Keep the IPC handler tests for normalization and parent bucketing.

### 5. Task 5 does not implement its advertised outcome coverage

The task promises returned, thrown, interrupt, and resume coverage. Its concrete tests cover only addCost success and throw.

Add explicit interrupt and resume cases, or identify existing adapter tests that already prove the generic `routeResultFor` pass-through and state exactly which new assertion each receives. Do not leave two required outcome paths only in prose.

### 6. The reconciliation tolerance needs a stronger justification

An absolute `$0.000001` tolerance can hide a completely missing charge smaller than one microdollar. Whether that is acceptable depends on provider price precision and host reconciliation policy, not only floating-point ulps.

Either derive a tighter absolute-plus-relative tolerance from realistic maximum call counts and costs, or explicitly declare one microdollar to be the smallest attribution discrepancy the host cares about. Add a negative test where a real omitted charge above the accepted precision fails reconciliation.

### 7. The plan's lint limits conflict with repository guidance

The plan says 1,250 lines per file and 150 lines per function. `docs/dev/coding-standards.md` says 1,000 and 100. Use the repository's actual structural-linter limits or cite the specific configured exemption. Do not teach an implementer a second global standard in this plan.

### 8. Do not mandate a fabricated co-author

The plan applies to any “agentic worker” but requires every commit to credit one specific model. Co-authorship should reflect who actually contributed to the commit. Remove the unconditional `Co-Authored-By: Claude Opus 4.8` instruction from the plan.

## Declarative-interface and anti-pattern assessment

The meter design is good: callers submit semantic usage, and the meter encapsulates the imperative mutation. `recordPaidUsageAt` remains the single boundary for guard billing, metering, and relay.

The optional `model` proposal weakens that interface because absence means both “legitimately unattributed” and “attribution metadata missing.” That is a leaky abstraction and an ambiguous state. A discriminated attribution value makes the valid states explicit:

- modeled usage;
- deliberately unattributed usage; or
- legacy/unknown provenance detected while decoding the wire.

With that change, the plan neatly separates declarative policy from imperative accumulation. No other major anti-pattern is inherent in the task breakdown.

## Recommended task ordering

1. Revise the spec and Task 1 around a discriminated attribution type.
2. Implement meter bucketing and reconciliation tests.
3. Thread resolved model identity and explicit unattributed identity through the accounting boundary.
4. Extend the wire and test both send and receive paths.
5. Implement the non-cuttable attribution-completeness transition for legacy messages lacking provenance.
6. Test all serve outcomes, then update documentation and run `make` once.

After these changes, the plan will be safe to execute task by task.
