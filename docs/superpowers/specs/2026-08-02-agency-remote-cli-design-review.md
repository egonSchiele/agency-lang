# Review of `agency remote`: changes required before implementation

The overall shape is good: a shared transport-neutral interrupt loop is the
right boundary. However, the spec currently has two safety-critical defects and
several unresolved contracts.

## 1. Critical: reapplying local policy at the endpoint changes `agency run` behavior

The spec says rechecking the policy is a no-op because surfaced interrupts
necessarily did not match it. That is incorrect:

- An explicit `propagate` rule matches and intentionally surfaces the
  interrupt (`lib/runtime/runPolicyHandler.ts:58-65`).
- A program handler can propagate while the outer run policy approves.
  Propagation takes precedence over collected approvals, so the interrupt still
  surfaces (`lib/runtime/interrupts.ts:370-394`).

Today, surfaced interrupts are prompted or rejected without another policy
check (`lib/runtime/runPolicyHandler.ts:266-283`). Rechecking could therefore
automatically approve something that currently requires a user decision.

Required amendment:

- Keep policy optional in `buildDecider`.
- For local `run`, use the environment policy only to determine whether a
  mechanism was supplied; do not pass it to the endpoint decider.
- For `remote call`, pass the policy because there is no remote in-chain policy
  handler.
- Define endpoint-level `propagate` as “unsettled”: prompt if interactive,
  otherwise reject. Never return or send `propagate` as an interrupt response.
- Add tests for:
  - an explicit `propagate` policy;
  - a program handler that propagates while the run policy approves;
  - value-expecting interrupts under approve, reject, propagate, and no-match
    policies.

The proposed “policy matches nothing” regression test is not sufficient.

## 2. Critical: `/resume` accepts malformed responses that can bypass an interrupt

The HTTP adapter currently validates only that `interrupts` and `responses` are
arrays (`lib/serve/http/adapter.ts:95-118`). The runtime checks their lengths,
but not the response discriminants (`lib/runtime/interrupts.ts:609-626`).

Generated resume code handles only `"approve"` and `"reject"`. An unknown
response type enters neither branch and continues execution past a statement
interrupt (`lib/templates/backends/typescriptGenerator/interruptReturn.ts:6-20`).

Required amendment:

- Require a non-empty interrupt batch.
- Require equal interrupt/response lengths.
- Validate serialized interrupt identity fields.
- Require every response type to be exactly `"approve"` or `"reject"`.
- Return HTTP 400 without calling `respondToInterrupts` for malformed input.
- Add equivalent runtime validation as defense in depth for non-HTTP callers.
- Use a shared wire schema rather than casts or `isInterrupt`, which currently
  checks only `type`.

At minimum, the shared decider’s return type must make `propagate` impossible to
send over `/resume`.

## 3. High: exported functions do not support the proposed interrupt cycle

The spec says `remote call --function` enters the same invoke/resume loop as
nodes. The current serve contract cannot do that:

- Node responses inspect `result.data` for interrupts, while function responses
  always return `ok(result)` (`lib/serve/http/adapter.ts:63-92`).
- `runExportedFunction` is explicitly a one-shot stateless function frame with
  no checkpoint/restore loop (`lib/runtime/node.ts:195-266`).
- Creating a resumable checkpoint without a current node fails
  (`lib/runtime/state/checkpointStore.ts:173-189`).

Required amendment: choose one:

1. Keep `--function`, but define it as one-shot only. Document that surfaced
   function interrupts are unsupported and fail cleanly; add an integration
   test.
2. Defer `--function`.
3. Expand scope to add synthetic-node or resumable-function server/runtime
   support. This would no longer be a CLI-only build.

The smallest option is the first.

## 4. High: untrusted endpoint URLs can redirect the API key

The spec moves `uploadClient.ts` with unchanged behavior while claiming network
responses are treated as untrusted. Currently:

- `endpointUrls` is accepted as an array without confirming its entries are
  strings.
- Absolute URLs from the response remain absolute.
- The Bearer token is then sent to whichever `/list` URL the response provides.

See `lib/cli/deploy/uploadClient.ts:62-83` and `:94-114`.

Required amendment:

- Require string `http:` or `https:` URLs with no embedded credentials.
- Require the endpoint origin to match the resolved deploy target before
  sending Bearer authentication or persisting the binding.
- Define the canonical binding as the exact
  `/serve/:userId/:projectId/:filename` base, with no query, hash, trailing
  command route, or ambiguous extra segments.
- Build `/list`, `/node/:name`, `/function/:name`, `/resume`, and the project-page
  URL with `URL`; encode dynamic path segments exactly once.
- Test cross-origin endpoints, credentials, non-string entries, query/hash
  values, trailing slashes, and endpoint names requiring encoding.

## 5. High: later `/resume` errors have no specified route out of the driver

The spec says serve errors are handled “around the loop,” but `respond` is
defined as returning `{ data }`. It does not say how an error from the first or
later `/resume` becomes a command error.

Required amendment:

Define one adapter used for both initial invocation and every resume:

- paused → `{ data: interrupts }`;
- done → `{ data: value }`;
- serve/network error → throw a typed command-level error.

`remote call` should catch that error once around the whole driver. An error
must never become final `{ data: error }`.

Add tests where invocation succeeds but the first and second resume fail,
covering both `success:false` and network failures.

## 6. High: binding location and mutation semantics are still open

The storage section leaves the central persistence decision unresolved. This
matters because:

- The global `--config` path is available in `scripts/agency.ts`, but
  `getConfig()` discards it after loading (`scripts/agency.ts:183-197`).
- Normal loading uses exactly `cwd/agency.json`, not upward project-root search
  (`lib/cli/commands.ts:90-109`).
- A missing file currently loads as an empty config (`lib/config.ts:548-576`).

Recommended decision:

- Store `remote?: { serveUrl: string }` in `AgencyConfig` and its schema.
- Use the exact global `--config` path when supplied; otherwise use
  `path.resolve(cwd, "agency.json")`.
- Pass a `{ config, configPath }` context to remote commands.
- On write, reread the raw JSON object and replace only `remote`. Do not
  serialize the parsed `AgencyConfig`, because doing so can normalize or discard
  nested unknown data.
- Missing file: read as unlinked; successful `link --url` or deploy creates it.
- Invalid JSON or a non-object root: fail without modifying the file.
- Accept two-space reformatting. Comments do not need consideration because the
  existing loader uses strict `JSON.parse`; commented `agency.json` files are
  already invalid.
- Dry runs and failed deploys never write a binding.

Tests should cover explicit `--config`, missing files, malformed-file
preservation, unrelated-key preservation, and writing only after successful
deployment.

## 7. Medium: retiring top-level `deploy` is a compatibility break

Although hidden from help, top-level `agency deploy` works today
(`scripts/agency.ts:403-437`) and is publicly documented in
`docs/site/cli/deploy.md`.

Recommended amendment: retain a hidden compatibility command for at least one
release. It should preserve the old behavior—including not changing the
binding—and emit a deprecation notice directing users to
`agency remote deploy`.

## Recommended verdict

Not safe to implement as written. Amend the spec first, especially findings
1–3.

After that, the architecture is sound:

- share the loop and prompt mechanics;
- keep local policy evaluation solely in the handler chain;
- apply policy in the remote endpoint decider;
- validate every resume and URL boundary;
- scope function calls to what the existing serve runtime can actually support.

The agency-lang side was validated directly. The statelog repository could not
be independently inspected because external GitHub access was unavailable, so
the spec’s cross-repository route/auth assertions should still be checked
against the current statelog source before implementation.
