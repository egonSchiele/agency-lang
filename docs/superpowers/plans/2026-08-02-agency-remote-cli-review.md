# Review of the `agency remote` implementation plan

## Recommendation: changes required before execution

Revision 2 fixes the original design problems, but the implementation plan is
not safe to execute as written. It contains two interrupt-safety regressions,
several compile/PR-sequencing blockers, and test gaps around the contracts the
revision was intended to pin.

## 1. Critical: value-expecting interrupts bypass explicit policy decisions

Task 2.2 checks `intr.expectsValue` before consulting the policy
(`2026-08-02-agency-remote-cli.md:212-219`) and says a value interrupt should
use the value prompt even under an approve or reject rule (`:187-192`). That
means:

```text
agency remote call main --reject X --interactive
```

could prompt for a value and approve an `X` interrupt despite the explicit
reject rule.

This contradicts Revision 2, which evaluates policy first. A valueless policy
approval is valid for an assignment interrupt: the generated resume code turns
it into the default approval value (`interruptAssignment.mustache:3-18`).

Required plan correction:

1. Consult policy before `expectsValue`.
2. Policy reject → `reject()` immediately.
3. Policy approve → `approve()` immediately; an assignment receives the
   runtime's default approval value.
4. Policy propagate/no-match → value prompt for a value-expecting interrupt,
   ordinary prompt for a statement interrupt, or reject when non-interactive.
5. Replace the current value-interrupt test bullet with explicit approve,
   reject, propagate, and no-match cases.

## 2. Critical: the malformed `/resume` validator can itself throw

The proposed `validateResumeBody` reads `.interruptId` and `.type` after TypeScript
casts without first checking that each item is a non-null object
(`2026-08-02-agency-remote-cli.md:69-83`). `null`, `undefined`, and primitives
can therefore throw before the adapter reaches its `try`, rather than returning
HTTP 400.

The runtime test also calls `buildResponseMap` directly, but that helper is not
exported (`lib/runtime/interrupts.ts:609-627`), so the proposed test does not
compile. The existing successful adapter fixture uses `{ id: "1" }` and must be
updated when `interruptId` becomes required (`lib/serve/http/adapter.test.ts:204-212`).

Required plan correction:

- Check `typeof value === "object" && value !== null && !Array.isArray(value)`
  before reading any field.
- Add null, primitive, array, missing-field, and malformed-discriminant cases;
  each must return 400 and leave `respondToInterrupts` uncalled.
- Update the existing successful `/resume` fixture to carry a non-empty
  `interruptId`.
- Reject duplicate interrupt IDs. `buildResponseMap` is ID-keyed, so duplicates
  silently overwrite an earlier response.
- Test runtime defense through public `respondToInterrupts` with a minimal fake
  context—the invalid response is rejected before the context is used—or
  extract and export a focused `validateInterruptResponses` helper. Do not
  export `buildResponseMap` solely for its test.

## 3. High: the driver type erases `RunNodeResult`

Task 2.1 defines `resolveInterrupts` and `ResumeFn` around only
`{ data: unknown }` (`2026-08-02-agency-remote-cli.md:133-170`).
`resolveCliInterrupts` currently returns a full `RunNodeResult`, which also
carries messages and may carry other metadata. Returning the narrowed type will
either fail type checking or require an unsafe cast that erases the public
contract.

Make the driver generic over the result shape:

```ts
export type ResumeFn<R extends { data: unknown }> = (
  interrupts: Interrupt[],
  responses: InterruptResponse[],
) => Promise<R>;

export async function resolveInterrupts<R extends { data: unknown }>(
  result: R,
  respond: ResumeFn<R>,
  decide: DecideFn,
): Promise<R> {
  // unchanged loop
}
```

This preserves `RunNodeResult` locally while allowing the remote adapter to use
its minimal result type.

## 4. High: PR 2 introduces a direct circular runtime import

Task 2.2 makes `interruptResolution.ts` import prompt types and implementations
from `runPolicyHandler.ts` (`2026-08-02-agency-remote-cli.md:183-185,232`). Task
2.3 then makes `runPolicyHandler.ts` import `buildDecider` and
`resolveInterrupts` from `interruptResolution.ts` (`:238-266`).

That creates:

```text
runPolicyHandler.ts ──▶ interruptResolution.ts
        ▲                       │
        └───────────────────────┘
```

ESM live bindings might make this appear to work, but module initialization
order should not become part of safety-critical interrupt behavior. It also
contradicts the spec's claim that the new core creates no cycle.

Required plan correction: move `PromptDecision`, `PromptFn`, `ValuePromptFn`,
the terminal prompts, and their parse/format helpers into a leaf module such as
`interruptPrompts.ts`. Both runtime modules import that leaf.
`runPolicyHandler.ts` can re-export the existing names to preserve callers and
tests.

## 5. High: PR 3 rejects valid relative endpoint URLs

The upload API currently returns relative endpoint URLs, and the existing tests
pin that behavior. Task 3.1 applies `assertSameOriginHttpUrl` before converting
the response URLs to absolute URLs (`2026-08-02-agency-remote-cli.md:313-325`).
Its `new URL(url)` call therefore rejects valid `/serve/...` entries.

Correct order:

```ts
if (typeof raw !== "string") throw ...;
const absolute = new URL(raw, target.host).toString();
return assertSameOriginHttpUrl(
  absolute,
  new URL(target.host).origin,
);
```

Keep the existing relative-URL test and add same-origin absolute, cross-origin,
non-string, embedded-credentials, and “no manifest fetch after rejection”
cases.

## 6. High: moving `uploadClient` leaves PR 3 uncompilable

Task 3.1 says to update only imports in `deploy.ts` and then delete the old
module (`2026-08-02-agency-remote-cli.md:284-295`). Current additional consumers
include:

- `lib/cli/deploy/render.ts`
- `lib/cli/deploy/curlExamples.ts`
- `lib/cli/remote/remote.ts`, which remains imported by `scripts/agency.ts`
  until PR 4
- `lib/cli/deploy/uploadClient.test.ts`

The proposed grep for `deploy/uploadClient` also misses relative
`./uploadClient.js` imports.

Required plan correction: enumerate and update every consumer during PR 3, or
leave a temporary re-export at the old path until PR 4 removes the prototype.
Search for the basename `uploadClient` before deleting the old file, then build
PR 3 independently.

## 7. High: manual links do not satisfy the canonical URL contract

Revision 2 requires an HTTP(S), credential-free, exact
`/serve/:user/:project/:file` base with no query, hash, command route, or extra
segments. Task 4.1 merely finds `"serve"` anywhere in the path and takes the
next three segments (`2026-08-02-agency-remote-cli.md:376-385`). It would accept
inputs such as:

```text
https://h/x/serve/u/p/a/function/f
https://user:pass@h/serve/u/p/a
ftp://h/serve/u/p/a
https://h/serve/u/p/a?route=/other
```

Define one canonical parser and use it for both upload-derived and manual
bindings. It must:

- require HTTP(S) and no embedded credentials;
- inspect `URL.pathname`;
- require exactly `serve`, user, project, and file as the non-empty path
  segments;
- reject command/extra segments;
- reject or deliberately canonicalize query, hash, and trailing slash;
- decode fields for display/use and encode each field once when rebuilding
  URLs.

Add tests for credentials, extra segments, query/hash, trailing slash, encoded
names, empty segments, and unsupported protocols. `writeBinding` must also
reject array roots; arrays are objects in JavaScript, but their `remote`
property is discarded by `JSON.stringify`.

## 8. High: the serve client cannot classify pauses from the current test plan

Task 3.2 classifies any successful object with an array-valued `interrupts`
field as paused (`2026-08-02-agency-remote-cli.md:345-350`). A legitimate final
value such as `{ interrupts: [], completed: 12 }` would incorrectly enter the
resume loop.

The actual node pause envelope has both:

- a non-empty runtime `Interrupt[]`; and
- a serialized `state` string (`lib/serve/http/adapter.ts:40-54`).

Required plan correction:

- Recognize a wrapped node pause only when `state` is a string and
  `hasInterrupts(value.interrupts)` is true.
- Otherwise treat the object as a normal final value.
- Validate every manifest item's `name`, `parameters`, and `interruptEffects` at
  the HTTP boundary; checking only that nodes/functions are arrays still lets
  malformed entries crash rendering.
- Add final-value tests containing empty and non-interrupt `interrupts` arrays,
  plus malformed nested manifest entries.

## 9. High: the served-function test mocks a wire state that may be unreachable

Task 4.4 mocks `invokeFunction` as `{ done: false }` and treats that as proof
that a real function interrupt reports “unsupported resume”
(`2026-08-02-agency-remote-cli.md:438-460`). The existing function path does not
produce the node pause envelope:

- `callFunction` returns `ok(result)` without inspecting interrupts
  (`lib/serve/http/adapter.ts:63-75`).
- `runExportedFunction` has no checkpoint/restore loop
  (`lib/runtime/node.ts:224-265`).
- An unhandled function interrupt may fail while trying to create a checkpoint
  without a current node (`lib/runtime/state/checkpointStore.ts:173-189`), in
  which case the adapter returns the generic tool error and the CLI cannot
  distinguish it from another function failure.

Required plan correction: replace the mocked pause as the primary proof with a
compile + HTTP integration test using an exported function that raises an
unhandled interrupt. Pin the actual current wire result. If it is a generic
`success:false`, the CLI can only report that error; promising a special
unsupported-resume message requires an adapter/runtime change and must be
moved into scope explicitly. If a raw top-level `Interrupt[]` can reach the
client, classify it separately from a normal final value.

## 10. High: Task 4.5 deletes a production module from Task 4.3

Task 4.3 creates or promotes `lib/cli/remote/exportedEndpoints.ts` as the real
`countExportedEndpoints` implementation (`2026-08-02-agency-remote-cli.md:404-415`).
Task 4.5 lists the same path among prototype files to delete (`:492-500`). The
new deploy command still consumes it.

Remove `exportedEndpoints.ts` from the deletion list. It already exists as part
of the prototype, so Task 4.3 should say to promote/edit it and add tests, not
create it. Delete only the prototype modules actually superseded by the new
layout.

## 11. Medium: the critical local-run propagation regression is not added

Task 2.3 only reruns existing tests (`2026-08-02-agency-remote-cli.md:238-276`).
The current tests do not cover the exact Revision 2 regression: a surfaced
interrupt whose effect is approved by the environment policy.

Add a `resolveCliInterrupts` regression where:

- `AGENCY_RUN_POLICY` approves effect `X`;
- the supplied result already contains a surfaced `X`, simulating propagation
  winning in-chain;
- non-interactive endpoint resolution rejects it;
- interactive endpoint resolution prompts and follows that answer;
- the endpoint never auto-approves it from the environment policy.

This belongs in Task 2.3. Policy-aware `buildDecider` tests prove remote
behavior, not preservation of local behavior.

## 12. Medium: command-level failure and persistence contracts remain untested

Task 4.4 tests only pause-then-success and a mocked function pause. Revision 2
also requires errors on later resume legs and binding writes through the actual
command recipes.

Add command-level tests for:

- no mechanism + surfaced node interrupt → unhandled report and no resume;
- failure on the first and second resume, for both `success:false` and network
  failures;
- invalid policy path/content → a clean CLI error rather than an uncaught
  rejected promise;
- deployed outcome writes the exact context `configPath`;
- preview and error outcomes do not write;
- explicit relative and absolute `--config` paths are honored;
- malformed or non-object `agency.json` remains byte-for-byte unchanged;
- export-count failure is allowed to fall through to `deploy()`'s better
  compile/parse error rather than pre-empting it.

## Required plan changes before implementation

At minimum, revise Tasks 1.1, 1.2, 2.1–2.3, 3.1–3.2, 4.1, 4.4, and 4.5.
The corrected execution order can remain four PRs, but PR 3 must compile on its
own while the prototype still exists, and PR 4 must not delete the promoted
export-count helper.

After those corrections, the four-boundary architecture remains sound:

1. validate resume input before runtime state restoration;
2. share a generic transport-neutral loop without reapplying local policy;
3. seal and validate the statelog wire before sending credentials;
4. compose thin remote commands with command-level contract tests.
