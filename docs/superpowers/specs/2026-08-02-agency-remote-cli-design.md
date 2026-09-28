# `agency remote`: a CLI surface for hosted agents

**Revision 2 (2026-08-02).** Revised after review
(`2026-08-02-agency-remote-cli-design-review.md`). Every finding was
re-verified against the code before acting; all held. The two safety-critical
changes: local `run` no longer re-checks its policy at the endpoint (the
original "no-op" claim was wrong — a propagated interrupt surfaces despite an
approve rule, so rechecking would auto-approve it), and `/resume` gains input
validation because an unknown response type currently continues execution
*past* an interrupt. `--function` is scoped to one-shot (served functions have
no resume path), endpoint URLs are origin-checked before the API key follows
them, and the binding's storage is fully specified. See "Response to review" at
the end.

A hosted agent today can be deployed (`agency deploy`) and then only reached by
hand-writing `curl` calls against its `/serve/...` URLs, checking a `success`
field, and threading interrupt state through `/resume` yourself. This spec
turns that into a first-class CLI: link a directory to a hosted agent once, then
list its endpoints, call them, and walk the interrupt cycle — with the *same*
interrupt experience `agency run` already gives you locally.

The whole surface was prototyped first (`lib/cli/remote/`, a throwaway spike;
see its README). The prototype answered the one open design question — the
interrupt UX — by trying it, and the answer is "make it identical to
`agency run`." This spec is the real build. It rests on that validated shape but
restructures the code around clean boundaries and, crucially, makes the
interrupt handling *one shared mechanism* with `run` rather than a parallel one.

Read `docs/dev/hosted-agent-execution.md` first — it explains deploy, the serve
wire, and the moduleId/observability internals this builds on.

---

# Scope

**In this build (no statelog *web-app* changes):** five subcommands under a new
top-level `agency remote` — `link`, `deploy`, `ls`, `call`, `open` — plus a
refactor of `agency run`'s interrupt-resolution code into a transport-agnostic
core that both `run` and `remote call` use, plus a safety hardening of the
`/resume` serve route.

Two of these touch **agency-lang's own serve code** (`lib/serve/`), not the
statelog web app: the interrupt-core refactor and the `/resume` validation.
That is still "no statelog-repo changes" — the distinction that keeps this a
self-contained agency-lang build is that no statelog server route, auth rule, or
schema changes. Everything the CLI *calls* rides statelog's *existing* API-key
surface: the upload endpoint (`POST /api/projects/:id/upload`) and the serve
routes (`/serve/.../list`, `/node`, `/function`, `/resume`). These are the only
statelog routes wired to `authenticateApiKey` (verified against the local
statelog checkout: every other `/api/*` route is `isLoggedIn`, browser-session
only); the CLI holds an API key, so it can reach exactly these.

**`--function` is one-shot.** A served function has no resume path — the serve
adapter returns a function result directly and never inspects it for interrupts
(`lib/serve/http/adapter.ts:63-92`), and `runExportedFunction` is a deliberately
stateless one-shot frame with no checkpoint/restore (`lib/runtime/node.ts:224`).
So `remote call --function` invokes and prints the result; if a function
surfaces an interrupt it is reported as unsupported and fails cleanly, never
entering a resume loop. Only nodes drive the interrupt cycle. (Resumable
functions would need server/runtime work and are out of scope.)

**Deferred (needs statelog web-app changes, tracked separately):** `inspect`
(files + last-uploaded-at), `pull` (download a zip of the source), and `logs`
(fetch a hosted agent's traces into the CLI logs viewer). All three read from
routes that are currently guarded by `isLoggedIn` (browser session), not the
API key — `GET /api/projects/:id`, `GET /api/projects/:id/traces` — so the CLI
cannot reach them without server work. They belong to the structured web-app
track, not this CLI-only build.

**Also deferred:** per-project provider API keys (statelog hard-codes the host
owner's keys today; multi-tenant key management is a separate problem),
versioning/rollback of deployed agents, and any statelog UI.

**A model assumption this build leans on:** one hosted agent per project. A
statelog project's id is unique per user, so "one agent per project" makes the
serve URL unique for free and lets a project's traces be that agent's traces.
This build does not *enforce* the rule (that is server-side), but its CLI is
designed around it: a link points at a project, and that project's single agent
is what every command acts on.

---

# What exists today, and what this reuses

The point of the architecture is to write almost no new mechanism. The pieces
already in the tree:

**Deploy.** `deploy(entrypointPath, config, options)`
(`lib/cli/deploy/deploy.ts:32`) resolves the target, bundles the `.agency`
files, checks they compile, uploads, and returns a `DeployOutcome`
(`deploy.ts:27`) whose `deployed` case carries `endpointUrls`.
`resolveDeployTarget` (`lib/cli/deploy/target.ts:45`) produces
`{ host, projectId, apiKey }` from `agency.json` `log.*` plus the
`STATELOG_API_KEY` env var. `serveBaseUrl(endpointUrls)`
(`lib/cli/deploy/uploadClient.ts:135`) extracts the shared
`…/serve/:user/:project/:file` base from the upload response.

**The serve wire.** The HTTP adapter (`lib/serve/http/adapter.ts`) defines the
contract every serve route speaks: `/list` returns `{ functions, nodes }`
unwrapped (`adapter.ts:149`); `/node`, `/function`, `/resume` return
`{ success, value }`, where a paused run is `success:true` with
`value = { interrupts, state }` (`interruptResult`, `adapter.ts:52`); a tool
failure is `success:false` at HTTP 200. **The interrupt items in
`value.interrupts` are the runtime's own `Interrupt[]`** — the same objects
`agency run` decides locally — which is what makes a shared interrupt core
possible.

**Run's interrupt machinery** (`lib/runtime/runPolicyHandler.ts`). This is the
heart of what we reuse:

- `resolveCliInterrupts(result, respond, opts?)` (`:240`) — the endpoint loop a
  CLI-driven run plays after a top-level node returns: for each surfaced
  interrupt, decide it, then `respond` (resume) and repeat until the run
  finishes. **`respond` is already a parameter** — the loop does not know how
  resume happens.
- `terminalPrompt` (`:103`), `terminalValuePrompt` (`:118`),
  `formatInterruptPrompt` (`:138`), `parsePromptAnswer` (`:73`) — the terminal
  UX: the effect banner and `(a)pprove / (r)eject / (aa) approve-always /
  (rr) reject-always` prompt, plus the value-prompt for value-expecting
  interrupts. All exported.
- `reportUnhandledInterrupts(result)` (`lib/runtime/interrupts.ts:155`) — the
  "you need a handler" message + `exit(1)` used when an interrupt surfaces with
  no way to decide it.
- `makeRunPolicyHandler` (`:58`) / `installRunPolicyHandler` (`:210`) — the
  policy applied as an in-process handler *during* execution, via
  `checkPolicyExplicit` (`lib/runtime/policy.ts`).
- `resolveRunPolicy(flags)` (`lib/cli/runPolicy.ts:59`) — turns
  `--policy/--approve/--reject` flags into a `Policy` object.

**Local export detection.** `collectServeMetadata` (`lib/serve/metadata.ts:27`)
builds a `SymbolTable` and reads exported nodes; the same table exposes exported
functions (`kind === "function" && exported`), which is how the prototype's
pre-upload "no endpoints" check works.

---

# The central design decision: one interrupt mechanism, two transports

## Why this is the crux

`remote call` must let a paused hosted run be approved/rejected/resumed. We want
it to inherit everything `agency run` offers: interactive prompts, the
`--policy / --approve / --reject` flags, value-prompts, "always" answers
remembered per effect, and the unhandled-interrupt report. Rebuilding any of
that for remote would be duplication — and, worse, a *second interrupt-control
mechanism*, which is exactly what the project forbids (interrupts are safety
infrastructure; there must be one path).

The insight that makes reuse possible: **the only thing that differs between a
local run and a hosted run is how you resume.** Local run resumes in-process
(`respondToInterrupts`); remote resumes over HTTP (`POST /resume`). Everything
else — the decision for each surfaced interrupt, the prompts, the policy, the
remembering — is identical, because the interrupts themselves are the same
`Interrupt[]` objects on both sides.

## What surfaces to the client differs — and this must be stated

There is one real semantic difference, and the spec must name it so it is a
decision and not a surprise.

For `agency run`, `--policy` is installed as a handler *in the execution chain*
(`installRunPolicyHandler`), so it decides interrupts *as they are raised*,
inside the same process. For a hosted agent, execution happens on the statelog
server; the CLI cannot install a handler there. The agent's own handlers run
server-side, and **only interrupts no server-side handler settled surface to the
client.** So for `remote call`, a policy can only decide *surfaced* interrupts —
it is a user-endpoint policy, not an in-chain one.

This is the correct model (the client is the user endpoint, the same role
`resolveCliInterrupts` plays for run), but it means `--reject std::write` behaves
differently in the two cases: locally it blocks the write as it is raised;
remotely it only acts if the write surfaces unhandled. This difference is
inherent to remote execution and will be documented in the command's help and
the dev doc, not engineered away.

## The refactor

Extract two things from `runPolicyHandler.ts` into a new
`lib/runtime/interruptResolution.ts`:

**1. The driver** — `resolveInterrupts(result, respond, decide)`. The loop body
of today's `resolveCliInterrupts` (`:266-285`), with the decision delegated to
an injected `decide` and resume delegated to the injected `respond`. Pure of
transport and pure of flags — just the loop. The "no decision mechanism →
report unhandled and exit" guard stays in the *callers*, not the driver,
because whether a mechanism is active depends on caller-specific facts the loop
cannot see: run's IPC mode and whether any policy flag was passed
(`loadEnvPolicy`), and for remote whether any of `--interactive/--policy/
--approve/--reject` was given. Each caller makes that check before entering the
driver, exactly as run's guard sits before its loop today (`:249-254`).

**2. The decider builder** — `buildDecider({ policy?, interactive, prompt?,
valuePrompt? })` returns the `decide` function. `policy` is **optional**, and
whether it is passed is the whole correctness question (below). For each surfaced
interrupt the decider:

- If a `policy` is supplied, consults it (`checkPolicyExplicit`). An explicit
  `approve` → approve; explicit `reject` → reject; **explicit `propagate` →
  treat as unsettled** (fall through to the interactive/reject step below), never
  emitted as a response. A no-match also falls through.
- Unsettled (no policy, or policy fell through): if `interactive`, prompt
  (`terminalPrompt` for a decision, `terminalValuePrompt` for a value-expecting
  interrupt), remembering "always" answers per effect; otherwise reject
  (fail-closed).

Its return type is **`{ approve, value? } | { reject }` only** — `propagate` is
not representable, which is half of finding 2's fix: a `propagate` can never be
sent over `/resume`.

**The policy is NOT re-applied at the endpoint for local `run` — this is the
finding-1 correction.** The original spec claimed rechecking run's policy at the
endpoint was a no-op. It is not: a program handler can `propagate` while the run
policy has an `approve` rule, and propagation wins
(`lib/runtime/interrupts.ts:387`), so the interrupt surfaces *despite* the
approve rule; an explicit `propagate` policy rule surfaces it deliberately
(`runPolicyHandler.ts:64`). Rechecking the same policy at the endpoint would
turn either into an automatic approval — silently removing a user decision the
system currently requires. So:

Then rewire the two callers:

- `resolveCliInterrupts` (run's bootstrap endpoint) becomes a thin adapter:
  keep the `isIpcMode()` guard; use the env policy (`loadEnvPolicy`) **only to
  decide whether a mechanism was supplied**, not as an endpoint decider input;
  build the decider with `interactive` from `AGENCY_RUN_POLICY_INTERACTIVE` and
  **no policy**; call `resolveInterrupts` with `respond = respondToInterrupts`.
  Run's policy keeps acting solely in the in-chain handler
  (`installRunPolicyHandler`) exactly as today, so its observable behavior does
  not change — its existing interrupt tests are the guard.
- `remote call` builds the decider **with** the policy (from `resolveRunPolicy`,
  the same flag→policy function run uses) plus `interactive`, and calls
  `resolveInterrupts` with a `respond` that POSTs `/resume`. Applying policy in
  the endpoint decider is correct here precisely because there is no remote
  in-chain handler — the endpoint is the only place a `remote` policy can act.

**`respond` shape and errors (finding 5).** One adapter serves both the initial
invoke and every resume. The driver works over a `{ data }` result where `data`
is either an `Interrupt[]` (paused) or the final value (`hasInterrupts` tells
them apart). Run's `respondToInterrupts` already returns this. The remote adapter
maps the serve client's result: paused → `{ data: interrupts }`; done →
`{ data: value }`; **serve/network error → throw a typed command error.**
`remote call` catches that once around the whole driver and fails cleanly. An
error must never be smuggled through as a final `{ data: error }`. This holds for
a failure on the first invoke or on any later resume.

**Layering.** `interruptResolution.ts` lives in `lib/runtime/`, imports only
runtime pieces (`interrupts.ts`, `policy.ts`) and `termcolors`. `remote call`
(under `lib/cli/`) imports *down* into runtime, a direction that already exists
throughout the CLI. No new cycle.

---

# Safety: harden `/resume` against malformed responses (finding 2)

This is an agency-lang serve fix, independent of the CLI, that `remote` makes
worth doing now because it makes `/resume` a routinely-exercised path.

**The hole.** The HTTP adapter validates only that `interrupts` and `responses`
are arrays (`lib/serve/http/adapter.ts:95-118`). `buildResponseMap` checks the
two lengths match but not the response *discriminants*
(`lib/runtime/interrupts.ts:615-619`). The generated resume path acts only on
`type === "approve"` and `type === "reject"`; **an unknown type matches neither
branch and execution continues past the interrupt**
(`lib/templates/backends/typescriptGenerator/interruptReturn.ts:9-20`). So a
malformed `/resume` body can bypass an interrupt gate — a safety defect,
because an interrupt gate is exactly what must never be silently skipped.

**The fix.** Reject malformed resume input before it reaches
`respondToInterrupts`:

- Require a non-empty interrupts batch and equal interrupts/responses lengths.
- Require every response `type` to be exactly `"approve"` or `"reject"`.
- Validate the serialized interrupt identity fields (the `interruptId` each
  response is matched to), rather than trusting shape via a cast or the
  `type`-only `isInterrupt`.
- On any violation return HTTP 400 without calling `respondToInterrupts`.
- Add the same discriminant check inside `buildResponseMap` as defense in depth,
  so a non-HTTP caller (MCP, a direct embedder) cannot bypass a gate either.

The client half of this fix is already covered by the decider's return type:
`remote call` cannot construct a non-`approve`/`reject` response. The server
half protects every *other* `/resume` caller, which is why it belongs in the
adapter and runtime, not the CLI.

---

# Component: the sealed statelog wire (`lib/cli/statelog/`)

Consolidate everything that knows statelog's HTTP contract into one directory,
so a statelog API change touches one boundary. This *moves* the existing
`uploadClient.ts` out of `lib/cli/deploy/` and adds the serve client beside it.

```
lib/cli/statelog/
  uploadClient.ts   MOVED from lib/cli/deploy/ (+ URL validation, finding 4)
  serveClient.ts    the serve wire: list / invokeNode / invokeFunction / resume
```

`serveClient.ts` exposes a declarative surface and hides fetch, Bearer auth, and
the envelope discrimination:

- `fetchManifest(serveBase, apiKey) → Result<ServeManifest>` — GET `/list`.
- `invokeNode(serveBase, name, args, apiKey) → ServeResult`
- `invokeFunction(serveBase, name, args, apiKey) → ServeResult`
- `resume(serveBase, interrupts, responses, apiKey) → ServeResult`

`ServeResult` is the paused-or-done-or-error union the prototype already
defines: `{ ok:true, done:true, value }` | `{ ok:true, done:false, interrupts }`
| `{ ok:false, error }`. The paused case carries `interrupts` verbatim so the
caller echoes it straight back to `/resume` without understanding its internals.

**URL trust — the move hardens, it does not preserve (finding 4).** Today
`uploadClient` accepts `endpointUrls` as any array without confirming the
entries are strings, keeps the response's absolute URLs, and then sends the
Bearer token to whichever `/list` URL the response names
(`uploadClient.ts:62-83`, `:94-114`). A compromised or buggy statelog response
could point the API key at another origin. The consolidated client must instead:

- Require each endpoint URL to be a string, `http:`/`https:`, with **no embedded
  credentials**.
- Require the endpoint origin to **match the resolved deploy target's origin**
  before sending Bearer auth to it or persisting a binding from it.
- Define the canonical binding as the exact `…/serve/:userId/:projectId/:filename`
  base — no query, no hash, no trailing command route, no extra segments.
- Build every request URL (`/list`, `/node/:name`, `/function/:name`, `/resume`,
  and the `open` project-page URL) with the `URL` constructor, encoding each
  dynamic path segment exactly once.

So consumers treat responses as untrusted in the strong sense: a bad *shape*
becomes a clean error, and a wrong *origin* is refused before the key follows
it. This is behavior that `uploadClient` does not have today; adding it is part
of the move, and its tests (cross-origin endpoints, embedded credentials,
non-string entries, query/hash, trailing slashes, names needing encoding) come
with it.

The move re-points deploy's one import (`deploy.ts` imports `uploadBundle` and
`serveBaseUrl` from `../statelog/uploadClient.js`). `projectClient.ts` — for the
deferred `inspect`/`pull`/`logs` — has a reserved home here but is not built.

---

# Component: the binding (`lib/cli/remote/binding.ts`)

The binding answers "which hosted agent does this directory talk to." A serve
URL is `…/serve/:userId/:projectId/:filename`. `projectId` lives in
`agency.json` (`log.projectId`) already; `filename` is the deployed
entrypoint's basename; **`userId` is the one value the client cannot derive** —
it is the API key's owner, known only from a deploy response (the server
authorizes off the key's identity, and the URL's ids are validated against it).

So the binding persists the serve base URL (which encodes all three) that a
deploy learned. Declarative surface: `readBinding(configPath)` /
`writeBinding(configPath, binding)`.

**Storage design (finding 6, resolved).** The binding lives in `agency.json` as
an optional `remote?: { serveUrl: string }` on `AgencyConfig` and its schema.
The mechanics are specified because the config loader has sharp edges:

- **Which file.** `getConfig()` loads a config but discards the path it came
  from (`scripts/agency.ts:190-197`), and `loadConfig` reads exactly the global
  `--config` path or `path.resolve(cwd, "agency.json")` — no upward project-root
  search (`lib/cli/commands.ts:95`). So remote commands receive a
  `{ config, configPath }` context: the exact `--config` path when supplied,
  otherwise `path.resolve(cwd, "agency.json")`. The binding reads and writes that
  one file.
- **How to write.** Re-read the raw JSON object from disk and replace only its
  `remote` key. **Do not serialize the parsed `AgencyConfig`** — that would
  normalize or drop nested keys the loader does not model. Two-space reformatting
  of the file is accepted; comments need no consideration because the loader uses
  strict `JSON.parse`, so a commented `agency.json` is already invalid.
- **Edge cases.** A missing file reads as *unlinked*; a successful `link --url`
  or `deploy` creates it. Invalid JSON or a non-object root fails **without
  modifying the file**. A `--dry-run` or a failed deploy never writes a binding.

**The cached `userId` is a stopgap.** `serveUrl` bakes `userId` (from the deploy
response) into `agency.json`. It is not secret, but it is redundant with the API
key's identity, and a stale one (project re-owned, key rotated) would build a
URL the server correctly rejects. The clean fix is a statelog "whoami" route
that resolves `userId` from the API key, leaving the binding to hold only
`projectId` (already present) while the CLI reconstructs the serve URL. That is a
small statelog web-app change, so it is a deferred follow-up; until it exists,
the cache is the pragmatic choice, recorded here as a stopgap rather than the
intended end state.

---

# Component: argument building (`lib/cli/remote/args.ts`)

Declarative: `buildArgs(flags) → Record<string, unknown>`. Hides the `--arg
name=value` splitting and JSON coercion validated in the prototype: repeatable
`--arg`, each value `JSON.parse`d when it can be (`count=3` → number, `flag=true`
→ boolean) and kept as a string otherwise (`message=hi` → `"hi"`), over an
optional `--data '{...}'` base object for nested cases.

---

# Component: rendering (`lib/cli/remote/render.ts`)

Terminal output behind `termcolors`, following deploy's `render.ts` +
`deployReport.mustache` pattern: the `ls` manifest listing, the `call` result,
and the `link` status. Whether the layouts warrant typestache templates or a
render module alone is an implementation call — the manifest listing is the only
one with real structure. No ad-hoc ANSI; no output logic in the command
recipes.

---

# Component: the commands (`lib/cli/remote/commands/`)

Five recipes, each a handful of lines composing the pieces above. This is the
"what"; every "how" is already encapsulated.

- **`link.ts`** — with `--url`, parse a serve base into a binding and write it;
  without, print the current binding (or "not linked").
- **`deploy.ts`** — reuse `deploy()`; on success, derive `serveBaseUrl`, write
  the binding, and report the link. Pre-flight: if the entrypoint exports no
  nodes or functions (`countExportedEndpoints`), warn and confirm before
  uploading — the check that catches a forgotten `export`. (Skipped on
  `--dry-run` and when stdin is not a TTY.)
- **`ls.ts`** — read binding, `fetchManifest`, render nodes and functions with
  their parameters and interrupt effects.
- **`call.ts`** — read binding, build args, invoke.
  - **Node (default):** `invokeNode`, then
    `resolveInterrupts(result, respond, decide)` where `respond` POSTs `/resume`
    (throwing a typed error on serve/network failure, caught once around the
    driver) and `decide` comes from the flags. Prints the final value, or — with
    no decision flag and a surfaced interrupt — reports it unhandled and exits,
    exactly like `run`.
  - **`--function`:** `invokeFunction`, print the result. No resume loop —
    served functions are one-shot (finding 3). If a function surfaces an
    interrupt, report that resuming a served function is unsupported and fail
    cleanly; never enter the driver. An integration test pins this.
- **`open.ts`** — construct the project page URL
  (`${host}/projects/show?id=${projectId}`, verified against statelog's
  frontend routing) and open it.

`countExportedEndpoints` (the prototype's `exportedEndpoints.ts`) moves in
alongside, or into `lib/cli/statelog` if it is better seen as serve-metadata
adjacent — implementation call.

---

# Command registration, and retiring top-level `deploy`

`agency remote` registers as a command group in `scripts/agency.ts`, mirroring
the existing grouped commands (`trace`, `eval`, `test`), with each subcommand's
action a one-line delegation to its recipe. `call` gains `--arg` (repeatable),
`--data`, `--function`, `--interactive`, and — new for the real build —
`--policy`, `--approve`, `--reject`, reusing run's flag definitions and
`resolveRunPolicy`.

The new home for deploying is `agency remote deploy`. But top-level
`agency deploy` **works today and is user-documented**
(`docs/site/cli/deploy.md`), so removing it outright is a compatibility break
(finding 7). Instead, keep top-level `agency deploy` as a **hidden deprecated
shim** for at least one release: it preserves the old behavior exactly —
including *not* writing a binding, since old callers do not expect that — and
prints a one-line notice pointing at `agency remote deploy`. Because the shim
still works, `docs/site/cli/deploy.md` stays accurate and is left untouched in
this build (user-facing docs are not edited in a feature PR). This is a move of
where the *primary* command lives, not a change to the `deploy()` engine, which
stays in `lib/cli/deploy/`.

While the hosted feature matures, `agency remote` stays registered `hidden`
(works, absent from `--help`), matching how `deploy` is registered today.

---

# What deliberately does not change

- **`agency run`'s interrupt behavior.** The refactor is a pure extraction; run
  keeps its env-driven policy, its in-chain policy handler, its IPC guard, and
  its exact prompts. Its policy is never re-applied at the endpoint (finding 1).
  Its existing tests are the guard.
- **The `deploy()` engine.** `target.ts`, `bundle.ts`, and the compile
  pre-flight are untouched; `uploadClient.ts` moves and gains URL validation
  (finding 4), and deploy's one import moves with it.
- **The statelog web app.** No statelog server route, auth rule, or storage
  changes — the CLI only calls existing API-key routes. The `/resume` validation
  (finding 2) is in *agency-lang's* serve adapter and runtime, not statelog.
- **Provider API keys, versioning, and the statelog UI.** Out of scope, as
  above.

---

# Tests

The pure pieces get co-located unit tests; the I/O recipes get light coverage.

- **`interruptResolution.test.ts`** (the most important). Drive the loop with a
  fake `respond` (no network) and a scripted decider: a single interrupt
  approved/rejected; several interrupts in one pause; a run that pauses more than
  once; a value-expecting interrupt; "always" answers remembered across pauses;
  the no-mechanism path reporting unhandled and exiting.
  - **Finding-1 policy tests (on the decider):** an explicit `propagate` policy
    rule resolves as unsettled — prompts if interactive, else rejects — and is
    never emitted as a response; a program handler that propagates while the run
    policy approves still surfaces and is *not* auto-approved; value-expecting
    interrupts behave correctly under approve, reject, propagate, and no-match
    policies. (This replaces the old, incorrect "policy matches nothing is a
    no-op" pin.)
  - **Run guard:** run's existing interrupt/policy tests stay green unchanged —
    the proof the extraction preserves run, whose endpoint receives *no* policy.
- **`/resume` validation (finding 2).** In the serve adapter tests: an unknown
  response `type` returns HTTP 400 and never calls `respondToInterrupts` (the
  critical one — it must not continue past the interrupt); a length mismatch and
  an empty batch are rejected; a well-formed approve/reject pair still resumes.
  In the runtime: `buildResponseMap` rejects a non-`approve`/`reject`
  discriminant (defense in depth for non-HTTP callers).
- **`serveClient.test.ts`** — envelope parsing: done value, paused
  (`value.interrupts` → `done:false`), `success:false` → error, non-JSON/HTTP
  error → clean error. **URL trust (finding 4):** a cross-origin endpoint URL is
  refused before the key is sent; embedded credentials rejected; non-string
  entries rejected; query/hash and trailing-slash variants normalized to the
  canonical base; a node/function name needing percent-encoding is encoded
  exactly once.
- **Resume-error routing (finding 5).** Invoke succeeds, then the first resume
  fails, and separately the second resume fails — for both `success:false` and a
  network throw — surfaces as one clean command error, never a final
  `{ data: error }`.
- **`--function` one-shot (finding 3).** An integration test: calling a served
  function prints its result; a function that surfaces an interrupt fails cleanly
  with the "resuming a served function is unsupported" message and never enters
  the driver.
- **`args.test.ts`** — coercion table (`n=1`→number, `flag=true`→boolean,
  `msg=hi`→string), `--data` base merge, malformed `--arg`.
- **`binding.test.ts` (finding 6)** — write/read round-trip; serve-URL parse into
  `{ userId, projectId, filename }`; an explicit `--config` path is honored; a
  missing file reads as unlinked; a write preserves unrelated keys and only
  replaces `remote`; invalid JSON / non-object root fails without modifying the
  file; a `--dry-run` or failed deploy writes nothing.
- **`exportedEndpoints.test.ts`** — an entrypoint with no exports counts zero
  (drives the deploy warning); one exported node counts one; a parse error is
  swallowed (deploy's own validation reports it).

No new LLM calls anywhere in the suite.

---

# Risk

- **The refactor touches safety-critical code.** Interrupt resolution is how a
  user gets the final say over a hosted agent's actions. The extraction must be
  behavior-preserving for `run`; the finding-1 correction (run's policy is *not*
  re-applied at the endpoint) is the specific hazard, and run's existing tests
  plus the new propagate tests are the guard. This is why the interrupt work
  lands in its own early PR, before any remote command depends on it.
- **The `/resume` bypass is a live defect** independent of this feature — an
  unknown response type continues past an interrupt. The feature makes `/resume`
  routinely reachable, which is why the hardening is pulled in now and lands
  early. Its risk is low (adds rejection of malformed input) but its absence is
  a real safety hole.
- **The remote policy semantics differ from run's** (client-endpoint vs
  in-chain). The risk is a user assuming `--reject X` on `remote call` blocks X
  the way it does locally. Mitigation is documentation in the command help and
  the dev doc, not code.
- **The cached `userId` in the binding** is a stopgap for the missing whoami
  route. If a project is re-owned or the key rotates to a different user, a stale
  binding would build a URL the server rejects (correctly, but confusingly). The
  whoami follow-up removes the cache entirely.

---

# PR sequence

1. **`/resume` hardening (finding 2).** Adapter rejects malformed resume input
   (unknown response type, length mismatch, empty batch) with HTTP 400 before
   `respondToInterrupts`; `buildResponseMap` validates discriminants as defense
   in depth. Smallest, purely safety, no dependencies — lands first.
2. **Extract `resolveInterrupts` + `buildDecider`** into
   `lib/runtime/interruptResolution.ts`; make `resolveCliInterrupts` a thin
   caller that passes *no* policy to the endpoint (finding 1). No behavior change
   for run; run's tests plus the new propagate tests guard it. Safety-critical,
   lands before any remote command depends on it.
3. **`lib/cli/statelog/`** — move `uploadClient.ts` and add URL validation
   (finding 4); add `serveClient.ts` with envelope + URL-trust tests; re-point
   deploy's import.
4. **`agency remote`** — `binding` (finding 6), `args`, `render`, the five
   command recipes (`--function` one-shot, finding 3), registration in
   `scripts/agency.ts`, and the hidden deprecated `deploy` shim (finding 7).
   `call` composes PRs 1–3. Optionally split `call` (where the pieces converge)
   from the other four commands if this PR grows too large.

The dependency direction is one-way: the deferred `inspect`/`pull`/`logs`
commands and the whoami route are follow-ups that need statelog server work and
sit on the structured web-app track, not here.

---

# Response to review

Review: `2026-08-02-agency-remote-cli-design-review.md`. Every finding was
re-verified against the code before acting; all seven held, and none needed
pushback.

- **Finding 1 (endpoint policy recheck changes `run`): accepted — it was a real
  correctness bug in the spec.** Verified: `hasPropagation` returns `propagated`
  ahead of collected approvals (`interrupts.ts:387`), and an explicit
  `propagate` policy rule surfaces intentionally (`runPolicyHandler.ts:64`), so
  a surfaced interrupt can have interacted with the policy. Rechecking would
  auto-approve it. Fixed: run passes *no* policy to the endpoint decider (the
  in-chain handler is its only policy site); remote passes policy because it has
  no in-chain handler; endpoint-level `propagate` is treated as unsettled and is
  not representable as a response.
- **Finding 2 (`/resume` accepts malformed responses): accepted, safety-critical.**
  Verified: the adapter checks only that the two fields are arrays
  (`adapter.ts:95-118`), `buildResponseMap` checks only lengths
  (`interrupts.ts:615-619`), and the generated resume path continues past the
  interrupt on an unknown type (`interruptReturn.ts:9-20`). Added a dedicated
  hardening PR plus the decider return-type guarantee. This is agency-lang serve
  code, not statelog.
- **Finding 3 (functions cannot resume): accepted.** Verified `callFunction`
  never inspects interrupts (`adapter.ts:63-92`) and `runExportedFunction` is a
  one-shot frame with no restore loop (`node.ts:224`). Took the smallest option:
  `--function` is one-shot; a surfaced function interrupt fails cleanly.
- **Finding 4 (untrusted endpoint URLs redirect the key): accepted.** Verified
  `readEndpointUrls` accepts any array and the Bearer token follows the
  response's URL (`uploadClient.ts:62-83`, `:94-114`). The move now hardens:
  string `http(s)` only, no embedded credentials, origin must match the deploy
  target, all URLs built with `URL` and encoded once.
- **Finding 5 (resume errors have no route out): accepted.** One adapter for
  invoke and resume: paused → `{ data: interrupts }`, done → `{ data: value }`,
  error → throw a typed command error caught once around the driver. Never a
  final `{ data: error }`.
- **Finding 6 (binding storage unresolved): accepted the recommendation.**
  Verified `getConfig` discards the config path (`agency.ts:190-197`) and
  `loadConfig` reads exactly `--config` or `cwd/agency.json`
  (`commands.ts:95`). Now specified: `remote` on `AgencyConfig`, a
  `{ config, configPath }` context, raw-JSON read-modify-write of only the
  `remote` key, and the missing/invalid/dry-run rules.
- **Finding 7 (retiring `deploy` is a compat break): accepted.** Verified
  `docs/site/cli/deploy.md` documents it. Kept as a hidden deprecated shim for a
  release, old behavior preserved (no binding write), with a notice — which also
  keeps the doc accurate without editing it.

**On the reviewer's cross-repo caveat.** The review noted it could not inspect
the statelog repository (no GitHub access) and asked that the auth/route claims
be checked against current statelog source. They were, against the local
statelog checkout: the upload and `/serve/*` routes use `authenticateApiKey`
while every other `/api/*` route (project info, project traces) uses
`isLoggedIn` (browser session). That boundary is exactly why `inspect`/`pull`/
`logs` are deferred — the CLI's API key cannot reach the routes they need.
