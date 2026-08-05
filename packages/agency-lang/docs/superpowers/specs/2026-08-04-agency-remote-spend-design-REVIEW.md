# Review: `agency remote spend` Design

## Verdict

The command is well scoped and follows the correct ownership path: time parsing belongs outside the HTTP clients, each client seals its own route and wire schema, the command selects account versus project scope, and rendering remains separate from transport. I also checked the stated server contract against statelog PR #18. The endpoint paths, response fields, epoch-millisecond half-open window, project/account authorization split, zero-event account rows, and soft-deleted-project behavior are accurate.

Do not write the implementation plan from this version yet. The scope-selection contract contradicts itself, the proposed time parser can emit values the server rejects, and the renderer signatures do not agree with the command pseudocode. The account renderer also fails to carry the two trust axes into its total.

## Blocking: project selection has two incompatible meanings

Decision 1 says:

- no positional project means account rollup;
- a positional project means one project.

That is clear. But the command type and later text introduce the existing project fallback chain:

```ts
type SpendOptions = ProjectCommandOptions & ...
```

and:

> the project slug resolves from the arg, then `--project`, then the binding

The registration does not define `--project`, and `runSpend` chooses account mode solely from `project === undefined`. Therefore a hypothetical `--project` value would be ignored for mode selection. A binding also cannot be a fallback without changing the meaning of bare `agency remote spend` from “account” to “linked project.”

Keep the positional-only design. Make `SpendOptions` extend `AccountCommandOptions`, not `ProjectCommandOptions`. In the project branch, pass the positional slug explicitly to `resolveProjectTarget`:

```ts
resolveProjectTarget(context, { ...options, project });
```

Remove the `--project` and binding-fallback claim. The binding may still provide the host, but it must not silently select project scope. If `--project` is desired as an alias, redesign mode selection explicitly and document how bare invocation remains account-scoped.

## Blocking: `resolveSpendWindow` can produce server-invalid query values

The server accepts only non-negative, safe integer epoch milliseconds within the JavaScript `Date` range. The proposed parser does not enforce that contract on every path.

### `--since` inherits behavior that is unsafe for this use

`parseDurationMs` intentionally accepts negative and fractional durations. Consequently:

- `--since -1h` produces a future `from`;
- `--since 0h` produces an empty window;
- `--since 0.1ms` produces a fractional epoch value;
- a duration greater than `now` produces a negative `from`.

The first two may be caught by the later `from >= to` check, but the latter two can still be sent to statelog and rejected there. Reuse `parseDurationMs`, then validate the result for this command: it must resolve to a positive, safe integer number of milliseconds, and `now - duration` must be a non-negative safe integer in the `Date` range. Add tests for negative, zero, fractional-millisecond, overflow, and pre-epoch windows. A duration such as `0.5s` may remain valid because it resolves to the integer `500`.

### The explicit-bound path validates only `NaN`

The ISO branch currently says `Date.parse` followed only by a `NaN` check. That accepts implementation-specific non-ISO strings, negative pre-epoch values, and timestamps whose intended timezone is ambiguous. It also does not apply the same safe-integer/range validation as the raw epoch branch.

Lock the syntax:

- raw digits: non-negative safe integer and valid `Date` range;
- date-only ISO (`YYYY-MM-DD`): interpret as UTC midnight;
- datetime ISO: require an explicit `Z` or numeric offset so results do not depend on the machine timezone;
- after parsing either form: require a non-negative safe integer and valid `Date` range.

If broad `Date.parse` input and local-time datetimes are intentional, stop calling the input ISO-8601 and document the timezone-dependent behavior. The strict option is safer for a remote accounting query.

## Blocking: renderer inputs are inconsistent and leak raw CLI options

The file section defines:

```ts
renderProjectSpend(slug, spend, window)
renderAccountSpend(rows, window)
```

but the command calls:

```ts
renderProjectSpend(target.slug, spend, options)
renderAccountSpend(rows, options)
```

The explanation then says `describeWindow(window, options)` needs both values. These are three different contracts.

Resolve the user input once and pass a declarative view value downstream. For example:

```ts
type ResolvedSpendWindow = {
  from: number | null;
  to: number | null;
  description: string;
};
```

`resolveSpendWindow` owns the relationship between raw flags, the captured `now`, query bounds, and the human label (`last 7d`, `since ...`, `all time`). Clients can consume `{ from, to }`; renderers consume `description`. Renderers should not inspect raw Commander options or re-derive time semantics. This gives the imperative parsing one home and exposes a clean declarative result.

## Important: the account total does not preserve trust semantics

Decision 4 says both trust axes are always surfaced. The account renderer only specifies a trailing `≥` on incomplete project rows, while the `TOTAL` line sums cost, tokens, and invocations. It does not say how the total reports:

- `usageComplete = rows.every(row => row.spend.usageComplete)`;
- `pricingComplete = rows.every(row => row.spend.pricingComplete)`; or
- total `unpricedCallCount`.

A total made from one incomplete row is also a lower bound. A total with unpriced calls can understate cost. Add an `UNPRICED` column or another explicit per-row signal, sum `unpricedCallCount`, and mark the total as a lower bound whenever any row has incomplete usage. Include a one-line account-level note for each degraded axis, equivalent to the project view. Add tests where only one of several projects is incomplete or unpriced and assert that the total remains visibly degraded.

Prefer `≥ $0.4212` over a trailing `≥`; it directly states that actual cost is at least the displayed value.

## Important: four decimal places can turn real spend into zero

`toFixed(4)` renders any positive cost below `$0.00005` as `$0.0000`. That is especially misleading in a command intended to expose sub-cent hosted costs.

Use adaptive formatting that never renders positive spend as zero. For example:

- ordinary values: four decimal places;
- `0 < cost < 0.0001`: `<$0.0001`; or
- enough decimal places to preserve the smallest accounting precision the server supports.

Apply the same rule to project rows and totals, and test zero separately from a tiny positive value.

## Important: specify numeric wire invariants, not only field types

The proposed Zod schema “mirrors `ProjectSpend`,” but a plain `z.number()` / `z.number().int()` still permits values the renderer should never accept. Define the boundary precisely:

- `pricedCost`: finite and non-negative;
- token and invocation counts: non-negative safe integers;
- `unpricedCallCount`: non-negative safe integer;
- `deletedAt`: `null` or a valid ISO datetime.

Also either refine or explicitly trust the server invariant `pricingComplete === (unpricedCallCount === 0)`. A refinement is preferable because the CLI uses both fields to decide what warning to print. Client tests should reject negative cost/counts, unsafe counts, invalid dates, and a contradictory completeness pair.

The cleanest shared interface is to define the Zod schemas in `spendTypes.ts` and infer `ProjectSpend` / `AccountSpendRow` from them. That prevents a hand-written type and its runtime validator from drifting.

## Important: the unsupported-host promise has no implementation

The final coupling note promises a clear error for a host without the spend endpoint. No file section defines that behavior or a test for it. The existing project client maps every HTTP 404 to:

> project '<slug>' not found

so an older host returning 404 for `/spend` will currently be misreported as a missing project. The account client will produce only a generic HTTP 404 error.

Choose an exact policy and include it in the client tasks. One workable distinction is:

- preserve “project not found” when the project route returns the known JSON `{ error: "Project not found" }` response;
- treat a non-JSON route-level 404 from either spend endpoint as “this statelog host does not support the spend API.”

Add project and account client tests for both cases. If the server cannot reliably distinguish them, remove the promise and document the generic 404 limitation instead.

## Smaller corrections

1. **Account ordering needs a total order.** “Cost descending, deleted last” should mean active rows by cost descending, followed by deleted rows by cost descending, with `projectSlug` as a deterministic tie-breaker. Test equal-cost rows.
2. **Capture `now` once.** `resolveSpendWindow` already accepts `now`; the command should call it once and use its returned bounds and description everywhere. Do not call `Date.now()` again while rendering.
3. **Keep query construction shared.** Both clients need identical null omission and decimal serialization. Put `SpendWindow` and `toSpendQuery` in the shared spend module rather than implementing subtly different copies.
4. **Make empty-account wording precise.** The server returns one zero row for every project, so `rows.length === 0` means “no projects,” not necessarily “no spend recorded.” Either print `No projects yet.` for an empty array or filter zero rows deliberately before claiming no spend.
5. **Test one-sided windows.** Client and parser tests should cover from-only and to-only requests, not only both or neither.

## What is already strong

- The command is read-only and additive.
- The positional scope split is simpler than artificial subcommands once its fallback contradiction is removed.
- Reusing `parseDurationMs` is appropriate after command-specific positivity/integer/range validation.
- The project/account client split matches the server's authorization boundaries.
- A shared schema/type module is the right source of truth.
- Separating pure window resolution, HTTP transport, command orchestration, and rendering keeps imperative work behind understandable interfaces.
- The test categories cover all major layers and require no network or LLM calls.

## Recommendation

Revise the scope contract, make window resolution produce only server-valid bounds plus one presentation description, and define account-level completeness aggregation. Then tighten money formatting, wire validation, unsupported-host errors, and the listed edge-case tests. After those changes, this design will be ready for an implementation plan.
