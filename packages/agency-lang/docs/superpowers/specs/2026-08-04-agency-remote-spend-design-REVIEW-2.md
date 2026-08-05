# Re-review: `agency remote spend` Design

## Verdict

The revision resolves every substantive issue from the first review. Scope selection is now deterministic, window resolution has a single declarative output, account totals preserve both completeness signals, small positive costs remain visible, wire schemas state their numeric invariants, ordering and empty-account behavior are explicit, and the tests cover the important edge cases.

The architecture is ready for implementation planning after correcting the small but implementation-breaking API mismatches below. These do not require redesign.

## Resolved from the first review

- Bare invocation is unambiguously account-scoped; only the positional argument selects project scope.
- `--since`, explicit bounds, timezone handling, `Date` range, safe integers, pre-epoch values, and `from < to` are specified.
- `ResolvedSpendWindow` cleanly encapsulates imperative parsing and presents validated bounds plus one display description.
- Both renderers consume the resolved description rather than raw Commander options.
- Account totals aggregate incomplete usage and unpriced-call information instead of presenting an unjustifiably exact total.
- Adaptive currency formatting distinguishes zero from tiny positive spend.
- Zod schemas are the type source of truth and enforce finite, nonnegative, safe-integer, date, and completeness invariants.
- Unsupported-host behavior, deterministic sorting, precise empty-account wording, shared query serialization, and one-sided-window tests are now covered.

## Remaining corrections

### 1. The command pseudocode uses a nonexistent `ProjectTarget.slug`

`resolveProjectTarget` returns:

```ts
type ProjectTarget = AccountTarget & {
  projectSlug: string;
};
```

The proposed command instead passes `target.slug` to both `createProjectClient` and `renderProjectSpend`. That will not type-check. Use `target.projectSlug` in both places:

```ts
const spend = await createProjectClient(
  target.origin,
  target.projectSlug,
  target.apiKey,
).getSpend(window);

console.log(renderProjectSpend(target.projectSlug, spend, window.description));
```

Also use `projectSlug` consistently in the architecture diagram so the plan does not perpetuate the wrong property name.

### 2. The account-client sketch names an unavailable validator and omits the route-union change

`accountClient.ts` has a private `parseValue(...)`, not `parseWire(...)`. The proposed `getAccountSpend` sketch therefore does not compile as written. It should use the existing account error boundary:

```ts
return parseValue(
  z.array(accountSpendRowSchema),
  await request("GET", withQuery("spend", toSpendQuery(window))),
);
```

The file also currently seals route names with:

```ts
type AccountRoute = "whoami" | "projects" | "api_keys";
```

Explicitly add `"spend"` to that union (or have the new query-aware route builder retain an equally narrow route type). Likewise, state that `ProjectClient` and `AccountClient` gain the corresponding public methods. These are straightforward changes, but they belong in the design because the clients intentionally use closed declarative interfaces.

### 3. Restrict “unsupported host” classification to an HTTP 404

The project-client section currently says:

> a 404 (or any non-envelope response) on the `spend` route ... means the host predates the spend API

“Any non-envelope response” is too broad. A reverse proxy can return HTML for a 502/503, and that should remain a reachability/server failure rather than being mislabeled as an old host. Define the rule narrowly:

- `404` plus exact `{ error: "Project not found" }` → project not found;
- any other `404` from a spend endpoint → host does not support the spend API;
- non-404 failures retain the clients' existing status/server-error/non-JSON handling.

Add a non-JSON 5xx regression case to the client tests so the new route-specific handling cannot swallow operational failures.

### 4. Do not describe `resolveSpendWindow` as pure if it calls `fail()`

The spec calls the parser “Pure” while requiring each invalid input to call `fail()`. The existing `fail()` writes to stderr and exits the process, so those claims are incompatible. More importantly, `parseDurationMs` throws; the design must state where that error becomes a clean CLI failure rather than an uncaught stack trace.

Prefer keeping the declarative parser genuinely pure:

```ts
resolveSpendWindow(options, now): ResolvedSpendWindow // returns or throws Error
```

Then let `runSpend` convert parsing errors through the command's `fail(...)` boundary. This keeps validation reusable and unit-testable without process-exit mocking. If direct `fail()` calls are intentionally preferred, remove “Pure” and explicitly require `parseDurationMs` errors to be caught and converted to `fail()`.

## Declarative-interface assessment

Yes. The revised design now places imperative complexity behind coherent declarative interfaces:

- raw time flags become one validated `ResolvedSpendWindow`;
- schemas define and validate transport values while inferred types expose them to callers;
- each client owns route construction, authentication, envelope parsing, and transport failures;
- renderers accept domain values and a resolved description rather than reconstructing CLI semantics;
- the command is limited to scope selection and orchestration.

That is the right decomposition. Correcting the parser's stated error boundary will make the implementation fully match the design's declarative intent.

## Recommendation

Make the four focused corrections above, then proceed to the implementation plan. No architectural rewrite or additional feature work is needed.
