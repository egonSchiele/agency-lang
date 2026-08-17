# Hosted agent execution (`agency deploy` + statelog serve)

This doc explains how an Agency agent is uploaded to a hosted [statelog](https://github.com/egonSchiele/statelog) instance and run over HTTP — the hosted equivalent of `agency serve http`. It spans two repositories, so both are covered here: **agency-lang** (the language, the CLI, and the serve API a host embeds) and **statelog** (the host app that stores agents, runs them, and collects their traces).

Read this before working on `agency deploy`, the `./serve` API, per-agent observability, or multi-file hosting.

## What "hosted execution" means

Normally you run an agent locally: `agency run agent.agency`, or expose it over HTTP with `agency serve http agent.agency`, which starts a server in your own process. **Hosted execution** moves that server into statelog: you upload the agent once, and statelog runs it on demand and records every run's trace automatically.

The end-to-end flow:

1. **Deploy** — `agency deploy agent.agency` reads the agent's source, uploads it to statelog, and prints the URLs where it can be run.
2. **Serve** — statelog compiles the uploaded source, and each request to a `/serve/...` URL runs the agent and returns its result (or an interrupt to respond to).
3. **Observe** — every hosted run auto-traces into the same statelog instance, attributed to the agent's own project.

## The map: which piece lives where

| Piece | Repo | Path |
|---|---|---|
| `./serve` API (the dispatcher a host embeds) | agency-lang | `lib/serve/` |
| `agency deploy` CLI | agency-lang | `lib/cli/deploy/` |
| `compileSource` (with `sourcePath`) | agency-lang | `lib/compiler/compile.ts` |
| Per-agent observability seam | agency-lang | `lib/runtime/configOverrides.ts` |
| The serve host (runs agents per request) | statelog | `src/backend/lib/serveHost.ts` |
| Upload endpoint | statelog | `src/backend/routes/api/projects/[id]/upload.ts` |
| Compile + write helpers | statelog | `src/backend/lib/agencyCompiler.ts` |
| Observability config | statelog | `src/backend/lib/config.ts` |
| Route registration | statelog | `src/backend/server.ts` |

---

## 1. The serve API (agency-lang `lib/serve/`)

A host embeds a small dispatcher that turns HTTP requests into agent runs. The public surface is `agency-lang/serve` (barrel: `lib/serve/public.ts`):

- **`createServeHandler(compiledPath, options) => Promise<ServeHandler>`** — imports a compiled Agency module and returns a `ServeHandler`, which is a function `(method, path, body) => Promise<RouteResult>`. It handles four routes: `/list`, `/function/:name`, `/node/:name`, `/resume`.
- **`collectServeMetadata({ filePath, config }) => { moduleId, exportedNodeNames, interruptEffectsByName, errors }`** — builds a symbol table and type-checks, producing the metadata `createServeHandler` needs.
- **`ServeHandler`, `CreateServeHandlerOptions`, `RouteResult`** — the types.

Internally (`lib/serve/discovery.ts`), `discoverExports` walks the compiled module and builds one `ExportedFunction` or `ExportedNode` per exported item. `ExportedNode` carries a `parameters` array; **`ExportedFunction` also carries `parameters`** (added so `/list` describes function arguments — before, only nodes did; see "PR history"). Bound params (from partial application) are filtered out — only caller-facing params are listed.

### moduleId consistency — the load-bearing gotcha

`createServeHandler` filters *exported functions* by `moduleId`: it only serves functions whose compiled `fn.module` equals the `moduleId` you pass in `options`. `compileSource` stamps a **fresh random** `moduleId` (`agency_<nanoid>`) into the code each time it compiles, and that id is **not recoverable** from a stored `.js` file.

So a host must **recompile at serve time** and pass `compiled.moduleId` (the id of the code it just wrote), not reuse a previously stored artifact with an unknown id. If the ids disagree, `/list` shows an empty `functions` array and function calls 404. Nodes are discovered by name and are moduleId-independent, which is why a mismatch silently breaks only functions.

### The wire contract

All routes return `RouteResult = { status, body }`. Bodies use a `{ success, ... }` envelope:

- **`GET /list`** → `{ functions: [{ name, description, parameters, destructive, idempotent, interruptEffects }], nodes: [{ name, parameters, interruptEffects }] }`. `parameters` is a list of names.
- **`POST /function/:name`** (body = named args, e.g. `{ "a": 2, "b": 3 }`) → `{ success: true, value }` on success, or `{ success: false, error }` on a tool failure. **Note: failures come back with HTTP 200** — the adapter maps tool errors into the body, not the status, and sanitizes the message (the full error is logged server-side, never sent to the client).
- **`POST /node/:name`** (body = named args) → same as function, **except** if the run raises an interrupt it returns `{ success: true, value: { interrupts: [...], state } }`. Each interrupt item is `{ type: "interrupt", effect, message }` (`effect` like `app::confirm`, `message` a human string).
- **`POST /resume`** (body = `{ interrupts, responses }`) → resumes a paused run. `interrupts` is the array echoed from the previous response's `value.interrupts`; `responses` is one response per interrupt, each `{ type: "approve" | "reject", value? }`. The result is again either a final value or another interrupt, so a client loops until there are no more interrupts. **The run is stateless across requests** — the interrupt payload carries the run state, so `/resume` needs no server-side session.

The interrupt/resume loop is exactly the ceremony a future `agency call` command would hide (see "Follow-ups").

---

## 2. Per-agent observability (`withRuntimeConfigOverrides`)

**Goal:** every hosted run auto-traces into statelog, attributed to *its own* project. A statelog instance hosts many agents from different projects, so run A's trace must go to project A and run B's to project B.

### Why config can't be baked at compile time

The obvious approach — compile each agent with its statelog config (host, project, apiKey) baked in — is wrong for a multi-agent host, and was rejected during review:

- The statelog **API key would sit in the compiled `.js` on disk** (plaintext at rest).
- One compiled artifact can't carry per-project routing; caching artifacts keyed by observability config fights the one-artifact-per-agent cache and causes write races.
- It violates the principle that config belongs to the *run*, not the *build*.

### How config actually reaches a run

`compileSource` bakes a `statelogConfig` object into the compiled module. At runtime, when the module's `RuntimeContext` is constructed, it applies runtime overrides on top of the baked config (`lib/runtime/state/context.ts`). Two override transports feed the same merge (`lib/runtime/configOverrides.ts`, `applyRuntimeConfigOverridesToContextArgs`):

- `AGENCY_CONFIG_OVERRIDES` — an environment variable (read by `readConfigOverrides`).
- `setRuntimeConfigOverrides(overrides)` — a process-global (used by subprocess IPC).

**The crucial fact:** that `RuntimeContext` is built **once, at module-import time** — the moment `createServeHandler` calls `await import(...)`. The per-invocation path (`createExecutionContext`) just copies the frozen config. So observability is decided when the module loads, and both override transports are process-global.

### The seam: `withRuntimeConfigOverrides`

`lib/runtime/configOverrides.ts` exports (via `agency-lang/serve`):

```ts
withRuntimeConfigOverrides(overrides, fn)  // set overrides, run fn, restore previous
```

A host wraps the **module import** in it, so the module's `RuntimeContext` reads that agent's config as it constructs:

```ts
await withImportLock(() =>
  withRuntimeConfigOverrides(
    { observability: true, log: { host, projectId, apiKey } },
    () => createServeHandler(compiledPath, { ... }),
  ),
);
```

Two things make this correct:

- **Routing is per-agent, not per-request.** An agent belongs to one project; that never changes. Each agent is a separately-cached module import. So config only needs to bind once, at that agent's import.
- **Imports are serialized (`withImportLock`).** The override is a process-global and `import` has an `await` inside it, so two overlapping imports could read each other's config. A mutex around the import prevents that. Invocations don't need the lock — they never touch the global.

### The invariant, and its guard

This design rests on one invariant: **a `RuntimeContext` is only constructed at module import, never per-invocation.** If a future agency-lang change made that read lazy (deferred to first run), the override would already be cleared and observability would silently go dark. The statelog test `serveHost.test.ts > "per-agent observability routing"` is the guard — it builds two agents with different configs and asserts each traces only to its own project; it fails if the import-time capture stops happening.

There is a filed follow-up to replace this ambient-global coupling with a first-class `createServeHandler({ observability })` binding API (see "Follow-ups").

---

## 3. Multi-file compile: `compileSource(sourcePath)`

An agent can import sibling `.agency` files (`import { helper } from "./helpers.agency"`). Hosting these was originally impossible, for a subtle reason.

### The bug

`compileSource(source, config)` takes source as a **string**, with no location. To resolve a relative import, the compiler's symbol table has to find the sibling file on disk. So `compileSource` wrote the source to a **throwaway temp directory** and compiled it there — where the sibling doesn't exist. Result: `Symbol 'helper' is not defined in './helpers.agency'`. Statelog used `compileSource` on both upload and serve, so multi-file agents couldn't even be uploaded.

### The fix

`CompileSourceOptions` gained an optional **`sourcePath`**. When set, `compileSource` compiles at that real on-disk path (where the siblings live) instead of a temp dir, so relative imports resolve. Without it, behavior is unchanged (single-file, temp dir).

**The on-disk file is authoritative when `sourcePath` is set:** `compileSource` reads and parses the bytes at `sourcePath` (ignoring the passed `source` string), because the symbol table and closure builder also read from disk. Parsing the string while resolving from disk could silently diverge; reading both from disk removes that risk. Pass the file's contents as `source` for clarity, but the disk file wins.

### The flat-directory constraint

Statelog stores an agent's files **flat** (one directory, keyed by basename), and its upload filename schema forbids slashes. So multi-file hosting only supports **same-directory siblings**. An import that resolves outside the entrypoint's directory (`./sub/x.agency`, `../x.agency`) cannot be represented and is refused (by `agency deploy`, and should be contained server-side — see statelog#11 under "Follow-ups").

---

## 4. `agency deploy` (agency-lang `lib/cli/deploy/`)

`agency deploy agent.agency` uploads an agent to statelog. The command is currently **registered hidden** in `scripts/agency.ts` (works, but not shown in `--help`) while the hosted feature matures.

### Architecture — "what" split from "how"

The orchestrator reads like a recipe; each stage is one single-concept module hiding its mechanics behind a typed result:

```
deploy.ts        the "what": resolveDeployTarget → collectAgencyBundle
                 → validateBundleCompiles → uploadBundle
target.ts        resolve { host, projectId, apiKey } + provenance
bundle.ts        collect the .agency file set + local compile pre-flight
uploadClient.ts  the ONLY file that knows statelog's upload API
curlExamples.ts  pure: manifest → ready-to-run curl commands
render.ts        terminal output (via a typestache template)
```

`render.ts` builds coloured blocks (using `lib/utils/termcolors.ts`) and hands them to `lib/templates/cli/deployReport.mustache`, which owns the layout. (The template is deliberately compact — one line with placeholders and two sections — because typestache does not strip standalone section-tag lines and nested inline sections don't render; the block builders own all the spacing.)

### Configuration

Deploy reuses the **`log` section of `agency.json`** (`log.host`, `log.projectId`) for the target — the same config observability uses. The **API key is read only from an environment variable** (`--api-key-env <NAME>`, default `STATELOG_API_KEY`), never from a flag or `agency.json`, so it can't be committed or leak into process listings. The host is required and URL-validated.

### Multi-file bundling

`collectAgencyBundle` walks the entrypoint's transitive local `.agency` imports (reusing the compiler's own `resolveAgencyImportPath` and `agencyImportTargets`, so the deploy walk resolves imports exactly as the compiler will). It refuses imports resolving outside the entrypoint's directory (the flat constraint) and local TypeScript/JavaScript interop imports (statelog only compiles `.agency` source). `validateBundleCompiles` compiles each file at its `sourcePath`, so the local pre-flight resolves imports the same way statelog does.

Nothing local leaks to the server: `uploadClient` sends only `{ entrypoint, files: [{ name, contents }] }`; the on-disk absolute paths stay client-side.

### Only the entrypoint's exports are served

`collectServeMetadata` reads exports from the entrypoint's symbols only, and `discoverExports` filters functions by the entrypoint's `moduleId`. So an `export` inside an imported sibling file is *not* an endpoint of the deployed agent. Re-exporting from the entrypoint (`export { helper } from "./lib.agency"`) makes it one, because the symbol table merges re-exports into the entrypoint's file symbols.

`remote deploy` warns before uploading an agent with zero endpoints (`lib/cli/remote/exportedEndpoints.ts`). When the entrypoint has none, it also scans the other bundled files for exports and prints the re-export line that would serve them, so a user whose exports live in `lib.agency` sees the fix instead of just "none". That scan builds a second symbol table, which is why it runs only when the entrypoint count is zero.

Known gap: a re-exported *node* is counted by the metadata but not served — the generated code re-exports its `__<name>NodeParams` but not the node function itself, so `discoverExports` never finds it. Only re-exported functions are served today.

### The statelog coupling is sealed

`uploadClient.ts` is the single file that knows statelog's HTTP contract: it POSTs to `/api/projects/:project/upload` with body `{ entrypoint, files }`, reads the `Result<{ endpointUrls }>` envelope, and best-effort fetches `/list` for the manifest (to print curl examples). Server responses are treated as untrusted — a bad shape reports an error or drops the extra rather than crashing a deploy that already landed. If statelog's API changes, only this file changes.

---

## 5. The statelog host (statelog repo)

The host is a React + Express + Postgres app. The relevant backend pieces:

### `serveHost.ts` — runs an agent per request

`buildServeHandler({ sourcePath, compiledPath, observability })`:

1. Reads the agent source, `compileSource(source, { sourcePath })` (real-path compile, so multi-file imports resolve), writes the `.js` to `compiledPath`.
2. `collectServeMetadata` for the moduleId/nodes/effects.
3. Wraps `createServeHandler` in `withImportLock(() => withRuntimeConfigOverrides(observability, () => ...))` so the run binds this agent's trace destination at import (section 2).

It **recompiles the entrypoint** rather than reusing the stored `.js`, because it must pass `compiled.moduleId` (the moduleId gotcha in section 1). For a multi-file agent it recompiles only the entrypoint; the siblings' `.js` were written at upload time and sit next to `compiledPath`, so the generated `import "./helper.js"` resolves at runtime.

Built handlers are cached, keyed by `compiled_path:mtime` (of the entrypoint). **Authorization is off the API key's identity (`res.locals`), not the URL** — the key is bound to one project, so URL ids that disagree are rejected (this closed an IDOR where trusting `req.params` ids let one tenant act on another's agent).

### `upload.ts` — the upload endpoint

`POST /api/projects/:projectId/upload`, body `{ entrypoint, files: [{ name, contents }] }`. It **writes every source file to disk *before* compiling any of them**, so a multi-file agent's `./sibling.agency` is present when each file compiles. Then it compiles each file at its stored `sourcePath`, writes the `.js`, and upserts a DB row. The response's `endpointUrls` advertise the `/serve/...` URLs (a client that follows them hits the serve routes; earlier they pointed at the older `/run/...` path).

`agencyCompiler.ts` provides `compileAgencySource(source, config, publicNodesOnly, sourcePath?)` and the path helpers `sourcePathFor` / `compiledPathFor` (single source of truth for the `UPLOADS_DIR/userId/projectId/` layout, so sources and their compiled `.js` always colocate).

### `config.ts` — observability config

`getServeObservabilityConfig({ projectId, apiKey }) => { observability: true, log: { host: INGEST_HOST, projectId, apiKey } }`. `INGEST_HOST` is where a run POSTs its traces (the statelog client sends them to `${host}/api/logs`); it defaults to this server's own origin (derived from `STATELOG_PORT`) so a run auto-traces back into this instance, overridable via `STATELOG_INGEST_HOST`.

### The serve routes (`server.ts`)

```
GET  /serve/:userId/:projectId/:filename/list
POST /serve/:userId/:projectId/:filename/function/:name
POST /serve/:userId/:projectId/:filename/node/:name
POST /serve/:userId/:projectId/:filename/resume
```

`filename` is the base name (no `.agency`; `serveHost` re-appends it). All are behind the API-key auth middleware.

---

## 6. `agency remote` (agency-lang `lib/cli/remote/`)

`agency remote` is the CLI surface for a hosted agent — the ceremony a client would otherwise hand-write against the serve routes.

Agent commands:

- **`remote link`** — show, or set with `--url`, the linked agent (stored as `remote.serveUrl` in `agency.json`).
- **`remote deploy <file>`** — upload + link (reuses the `deploy()` engine). Warns, and on a TTY confirms, if the agent exports no nodes/functions.
- **`remote ls`** — the callable nodes/functions (`GET /list`).
- **`remote call <name>`** — invoke a node (or `--function`) and drive the interrupt cycle.
- **`remote open`** — the project page in a browser.

Account-management commands (consume statelog's account API, `GET/POST /api/{whoami,projects,api_keys}`):

- **`remote whoami`** — the authenticated user.
- **`remote projects`** (list) and **`remote projects create <project_id> --name …`** — list and create projects.
- **`remote keys`** (list) and **`remote keys create <name> --project <slug>`** — list and create API keys.

Rules the CLI enforces around these:

- **`whoami` accepts an account- or project-scoped key**; **projects and keys require an account-scoped key** (a project-scoped key is refused with 403 and the CLI names the env var to fix).
- **`keys create` mints project-scoped keys only** — minting an account key is session/web-only on the server.
- **CLI project arguments and output are public `project_id` slugs.** The sealed account client (`lib/cli/statelog/accountClient.ts`) translates statelog's internal database ids in both directions and never exposes them.
- **A newly created key's plaintext is shown once** and must be copied immediately; the list view never returns it.

Introspection commands (project-scoped **reads**; a **project key on its own project** is enough — no account key):

- **`remote pull [--out <dir>] [--force]`** — download the deployed source to disk (`GET …/source`). Server filenames are untrusted, so a non-mutating planner refuses traversal/duplicate/non-regular names and collects **all** conflicts before any write, and the applicator publishes each file **atomically** (create via `fs.link`; `--force` replaces a still-regular file). Output-directory symlinks are refused, and a pull bundle is **not transactional** — a later failure reports the files already committed. It refuses to overwrite without `--force`.
- **`remote logs [traceId] [--json] [--list]`** — open a trace's logs in the same viewer `agency logs` uses (`GET …/traces` + `…/traces/:id/logs`, mapped to the viewer's JSONL through one owner). Defaults to the most recent trace; `--list` shows recent traces; `--json` writes raw JSON to stdout instead. **Viewer mode requires an interactive stdin/stdout** (`--json` is the headless alternative).

The project-read wire is sealed in `lib/cli/statelog/projectClient.ts` (slug-addressed), keeping the project-**404** / wrong-project-**403** / HTTP-success **`Trace not found`** failure layers distinct. Like the account and serve clients, its success values are validated with **Zod** schemas (the `lib/cli/statelog/` clients share this convention).

**One interrupt mechanism, shared with `agency run`.** `remote call` reuses the runtime's `resolveInterrupts` + `buildDecider` (`lib/runtime/interruptResolution.ts`); it differs from a local run only in the resume transport (HTTP `/resume` vs in-process). It borrows run's flags — `--interactive`, `--policy`, `--approve`, `--reject` — through `resolveRunPolicy`. With no such flag a surfaced interrupt is reported unhandled and exits, exactly like `run`. **The remote policy acts on *surfaced* interrupts only** (the server's own handlers ran first), unlike run's in-chain policy.

**`--function` is one-shot.** Served functions have no resume path (`runExportedFunction` is a stateless frame; an unhandled function interrupt fails at checkpoint creation and comes back wrapped in a success envelope — see `functionFrame.integration.test.ts`). So `remote call --function` prints the result and never enters the resume loop.

**The sealed statelog wire** lives in `lib/cli/statelog/`: `serveUrl.ts` (origin-checked, canonical `/serve/:user/:project/:file` parsing and route building) and `serveClient.ts` (`createServeClient` → `fetchManifest`/`invokeNode`/`invokeFunction`/`resume`, returning the runtime's `InterruptResult`/`ResumeFn` so the shared driver consumes them directly). The binding, arg coercion, decider, prompts, browser launch, and rendering each sit behind their own module in `lib/cli/remote/`; the command files are thin recipes.

Top-level `agency deploy` has been **removed** (a breaking change) in favor of `agency remote deploy`; the `deploy()` engine in `lib/cli/deploy/` stays and is what `remote deploy` calls.

**Deferred:** a `remote link --project <slug>` convenience that builds the serve URL from `host + whoami.userId + project + file` (dropping the pasted URL). A **`remote inspect`** metadata view (entry point, last upload, per-file exported nodes) is also deferred until the statelog `/api/projects/:slug/agent` endpoint returns the full callable manifest — functions and typed/defaulted parameters — so it would launch differentiated from `remote ls` rather than as a thin subset. The management (`whoami`/`projects`/`keys`) and introspection (`pull`/`logs`) commands are shipped.

---

## Running a deployed agent (curl)

```bash
export KEY='<project-api-key>'
export BASE='https://<host>/serve/<userId>/<project>/<agent>'   # from the deploy output

curl -s -H "Authorization: Bearer $KEY" "$BASE/list" | jq
curl -s -X POST "$BASE/node/main" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"message":"hi"}' | jq
```

Check the `success` field, not the HTTP code (failures are 200). If a node returns `value.interrupts`, respond by POSTing `{ interrupts, responses }` to `$BASE/resume`.

---

## Known limitations (trusted single-tenant v1)

These are accepted for the current trusted, single-tenant posture and tracked in **statelog#11**:

- **No sandboxing.** Hosted code runs in the statelog process. A hung agent can stall the server.
- **Compile-time containment gap.** Compiling at a real path means a traversing import (`../../other/agent.agency`) reads the live filesystem at compile time. The upload filename is sanitized, but import specifiers inside a file's source are not. Compile-only and low-leak, but a new cross-project read surface.
- **Sibling cache staleness.** `serveHost` cache-busts the entrypoint's module URL by content hash, but its relative `import "./sibling.js"` is not version-busted, so Node's ESM cache serves an old sibling even after a re-upload — a multi-file sibling edit needs a process restart. Same root cause as the general "ESM registry accretes modules" caveat; the planned child-process execution model fixes it.
- **Upload atomicity.** Upload pre-writes all sources then compiles/upserts per file; a mid-batch failure can leave partial on-disk/DB state. Re-uploading recovers.
- **Per-agent (not per-request) observability.** Trace routing is fixed per agent at import time; a single agent can't route different runs to different projects.

---

## Follow-ups

- **`agency call`** — ✅ **shipped as `agency remote call`** (section 6). The interrupt-UX fork resolved to "mirror `agency run`."
- **First-class observability binding** — replace the ambient `withRuntimeConfigOverrides` + import-mutex with a supported `createServeHandler({ observability })` option that agency-lang applies internally. Filed as an agency-lang issue.
- **statelog#11** — the containment, sibling-cache, and atomicity items above.
- **Minimal statelog UI** — an upload/list/invoke browser flow with a jump to a run's trace. Deferred in favor of the CLI (`agency deploy`) path.

---

## PR history (the arc, for context)

The feature landed as a sequence of small PRs. In agency-lang: the `./serve` public API; per-agent observability (`withRuntimeConfigOverrides`, released in 0.11.0); `/list` function parameters; `compileSource(sourcePath)` (released in 0.12.0); `agency deploy` (single-file, then multi-file). In statelog: migration to the newer agency-lang, the `/list` + `/function` + `/node` + `/resume` serve host, per-agent auto-observability, the `endpointUrls`-point-at-`/serve` fix, and multi-file serve support. The dependency direction is one-way: statelog consumes published agency-lang versions, so an agency-lang change ships first (merge + publish), then statelog bumps the dependency.

---

## Serve cost seam — per-invocation usage

A host that runs an agent (statelog, "platform pays") needs the **authoritative**
cost of each hosted invocation, read from the run it executed — not from
client-supplied `/api/logs` telemetry, which the tracked party can forge. Every
post-execution serve `RouteResult` therefore carries a `usage` figure.

**The meter.** Each execution context owns a fresh `InvocationUsageMeter`
(`lib/runtime/invocationUsage.ts`), set in `createExecutionContext` and **never
serialized or restored** from a checkpoint. Because each `/node`, `/function`,
and `/resume` invocation builds its own execCtx, per-leg and concurrent isolation
are structural: a resume leg starts at zero (it does **not** inherit the
checkpoint-carried `stateStack.localCost`), and two concurrent requests never
share a meter.

**One accounting boundary.** Every paid unit of work submits one
`InvocationUsageDelta` to `recordPaidUsageAt({ ctx, stack }, delta)`
(`lib/runtime/recordPaidUsage.ts`), which bills the branch's cost guards (reusing
`StateStack.billCharge`), merges the invocation meter, and relays the full delta
upward once when this process is a subprocess. The three paid sites route through
it: the LLM completion (`prompt.ts` → `accountCompletionUsage`), `addCost`
(memory / image generation), and the IPC telemetry handler. So `pricedCost` means
*all* trusted billable spend and never depends on execution topology (an
`addCost` charge counts identically in-process and in a child). `addCost` throws
on invalid input rather than silently dropping a real charge.

**Pricing vs delivery completeness — two axes, never conflated.**
`pricingComplete` (on the usage) is derived: `unknownCostCallCount === 0`. A
finite `0` price is a KNOWN free price; only an *absent* price is unknown.
`usageComplete` (on the snapshot) starts true and becomes permanently false when
an **abnormal subprocess termination** (a kill, error, or unexpected close) means
unsent child telemetry cannot be ruled out — making `usage` a trusted **lower
bound**, relayed upward once. Normal `result`/`interrupted` completions stay
complete (IPC FIFO guarantees all telemetry preceded the terminal message).

**Per-model breakdown.** Alongside the flat totals, `usage` carries a
`models` map (`{ [model]: { pricedCost, inputTokens, outputTokens } }`) and an
`unattributed` row of the same shape. The breakdown rides the *same* delta and
IPC wire as the total, so it includes subprocess-relayed spend that the
process-local `__tokenStats.models` (used by `/cost`) cannot cross. Each charge
carries a discriminated `attribution` — `{ kind:"model", model }` (a completion)
or `{ kind:"unattributed" }` (`addCost`: memory / image, which has no model). A
scalar model field would not do: the immediately-preceding runtime (#801) relays
usage deltas with *no* attribution, and "no model" from `addCost` must stay
distinct from "model lost by an old child." Cost per model is a single number —
input-vs-output dollars are **not** split (the provider gives one `totalCost`
through this seam). Rows plus `unattributed` reconcile to the flat `pricedCost`
within `usageReconcileTolerance(pricedCost)` = `max(1e-9, 1e-9·|pricedCost|)`
(relative+absolute, because float ulp drift scales with magnitude); token counts
reconcile **exactly within the safe-integer range** — the meter rejects any
individual count at or above 2**53 and real totals are far below it, so only a
subprocess relaying absurd counts whose accumulation crosses 2**53 makes token
attribution best-effort (like cost). The flat total stays authoritative for
both — a host bills `pricedCost`, not the row sum.

**Model attribution — the third completeness axis.** `modelAttributionComplete`
(on the usage) starts true and flips false the moment a *measurable* child
delta arrives over IPC with **no** attribution: an older child (a #801 runtime,
or the legacy `{ costUsd }` telemetry handler) whose real LLM spend books to
`unattributed` with its model lost. This is distinct from both `pricingComplete`
(price availability) and `usageComplete` (telemetry delivery): pricing and
delivery can both be complete while the model labels are not. The flag is raised
only at the IPC boundary (`accountChildUsageWithProvenance`) and relayed upward
once, mirroring `usageComplete`; `addCost` and normal completions always carry
an explicit attribution and never trip it. A host seeing it false should read
`unattributed` as "includes spend of unknown model," not runtime overhead.

**Model identity.** The per-model key is `resolveCompletionModel(completion.model,
clientConfig.model)` (`lib/runtime/modelIdentity.ts`): the provider-reported model
wins, else the requested/configured model, else the literal `"unknown model"`.
The string is used verbatim (no provider-name normalization); a real model named
`"unknown model"` is an ordinary row, never `unattributed`.

**Rollout / absence.** `models`, `unattributed`, and `modelAttributionComplete`
are optional on the public `InvocationUsage` type (a required field would break
host code that constructs it); the current runtime always emits them. A host that
sees them **absent** is reading an older runtime's snapshot — it must fall back
to the flat totals and record "breakdown unavailable," never treat absence as
zero spend.

**The invocation boundary.** `runNode` / `runExportedFunction` /
`respondToInterrupts` each split into an internal core that returns a
`ServedInvocationOutcome<T>` (`{ status:"returned", value } | { status:"threw",
error }` plus the usage snapshot) and a public wrapper that unwraps-or-rethrows —
so the CLI/debugger contract is unchanged. The `…ForServe` variants hand the
outcome to the serve adapters. The lifecycle boundary starts the moment the
execution context exists, so an already-aborted signal or a setup failure still
yields an outcome-with-usage and still runs cleanup; the meter snapshot is taken
**after** cleanup so cleanup-incurred paid work counts. User values and thrown
errors are never mutated or wrapped (identity, `readCause`, stack, cause
preserved).

**The wire.** Generated modules export `__invokeNodeForServe` /
`__invokeFunctionForServe` / `__respondToInterruptsForServe` (see
`imports.mustache`). The **public** `ExportedFunction.invoke` /
`ExportedNode.invoke` keep their original raw contract (value-or-throw; node
positional args) for host apps that construct/consume these directly; the serve
adapters use a separate internal `invokeServed` that `discoverExports` wires to
the `…ForServe` invokers. `discoverExports` requires each serve invoker **only
for the kind actually exported** (a node-only bundle needs just the node one) and
fails fast with a recompile-required error otherwise — **served bundles must be
recompiled** to report usage. The HTTP adapter's one `routeResultFor` mapper
attaches `usage` (and the sibling `usageComplete`) to every post-execution
`RouteResult` — success, interrupt, 402 `budgetExceeded`, generic failure,
cancellation — and omits both on `/list`, 404, and validation 400. The host
reads them in-process; they are not part of the standalone HTTP body. MCP unwraps
the outcome to the raw value (or rethrows) and does not expose usage in v1.

**In-process dispatch failures count too.** Beyond a returned-but-unpriced
completion, a provider request that is *dispatched and then times out / is
cancelled / errors after dispatch* may have incurred untracked spend with no
price metadata, so each such attempt (each retry is a fresh attempt, via
`meteredDispatch`) adds one to `unknownCostCallCount` and flips `pricingComplete`
false. A failure proven *before* dispatch counts nothing.
