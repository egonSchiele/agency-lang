# The `remote` schedule backend

`agency schedule add|list|remove|edit --backend remote` manages schedules that
live on a hosted statelog server. The server runs them on a cron (see the
hosted-agent-schedules design in statelog); the CLI is only a management
client. This note covers the seams and the decisions that are easy to get
wrong when touching this area.

## The server is authoritative

A remote schedule has no local registry entry. `add` never calls
`registry.set`; `list`, `remove`, and `edit` are server queries. `remove` and
`edit` take the **server schedule id** (shown by `list`), not a local name —
the same positional argument means a name on the local path and an id on the
remote path. `remote.test.ts` enforces the boundary by mocking `Registry` to
throw if any remote recipe ever constructs it.

## Three layers, one file each

- `lib/cli/statelog/schedulesClient.ts` — the sealed HTTP client, shaped like
  `projectClient.ts`: it alone knows the `/api/projects/:slug/schedules*`
  routes, the wire DTO, and the failure shapes. Callers get validated
  `RemoteSchedule` values or a thrown `ScheduleRequestError` carrying the
  server message and (when there was a response) the HTTP status.
- `lib/cli/schedule/remote.ts` — pure resolvers plus thin recipes.
  `resolveScheduleAdd` and `resolveSchedulePatch` translate CLI options into
  declarative request values and throw on every invalid flag combination
  *before* any target resolution or network call. The `addRemote` /
  `listRemote` / `removeRemote` / `editRemote` recipes sequence target
  resolution, deployment policy, and one client call.
- `scripts/agency.ts` — Commander registration and dispatch only. The action
  handlers validate the `--backend` string, await the remote recipe and
  return, or fall through to the unchanged local/github path.

## Target resolution: the binding, not `log.projectId`

Remote schedule commands resolve host/project/key with `resolveProjectTarget`
(`lib/cli/remote/commands/util.ts`), the same seam every `agency remote`
command uses: origin from `--host` → `log.host` → the `remote.serveUrl`
binding that `agency remote deploy` writes; project from `--project` or the
binding (guarded by an origin match); API key from the environment only,
read last. Do not switch this to `resolveDeployTarget`
(`lib/cli/deploy/target.ts`) — that resolver predates the binding and requires
`log.projectId`, which a directory linked by `agency remote deploy` does not
have.

## A failure can arrive inside an HTTP 200

statelog's file-routed handlers return failures as
`{ success: false, error }` **with HTTP status 200**. The schedules client
therefore never judges success by status: it unwraps the envelope and throws
on `success: false` regardless. Anything talking to these routes must go
through the client; a hand-rolled `fetch` with an `response.ok` check will
report success on a failed request.

## Deploy-if-missing

`add` wants the agent on the server before scheduling it. The policy is
resolved as a `DeployMode`:

- default (`if-missing`): list the project's sources via
  `projectClient.pullSource()` and deploy only when `<fileName>.agency` is
  absent (exact basename match);
- `--redeploy` (`always`): deploy without checking;
- `--no-deploy` (`never`): never deploy; the server's
  `Agent '<file>' not found` failure is surfaced with a deploy hint.
  Commander delivers this flag as `deploy: false` (defaulting to `true`), so
  conflict checks compare against the explicit `false`, never truthiness.

The deploy reuses `runDeploy` (`lib/cli/remote/commands/deploy.ts`), which now
returns an exhaustive outcome: `"deployed" | "aborted" | "preview"` (a deploy
error exits the process instead of returning). A resolved promise is NOT proof
of an upload — declining the no-exports confirmation resolves with
`"aborted"` — so schedule creation is gated on the `"deployed"` outcome
specifically. The deploy also receives the already-resolved
`{ host, project, apiKeyEnv }`, so it cannot re-derive a different target from
config than the schedule POST will use.

## Edit is deliberately narrow

The server's PATCH accepts only `{ enabled?, cronExpr?, timezone? }`. Target,
name, and args are immutable — changing them is delete-and-re-add. The CLI
mirrors the server's empty-patch rejection client-side for a better message.
`--enabled`/`--disabled` are two ordinary flags (not a negated pair); both
together is an error. `resolveCron` does not reject `--every` combined with
`--cron` (it silently prefers `--every`), so the remote resolvers check flag
presence themselves before calling it.

## A flag the backend cannot honor fails loudly — in both directions

`--node`, `--timezone`, `--host`, and friends on a local or github schedule
command are an error, not a no-op — otherwise a typo'd `--backend` would
silently create a local schedule that ignores half its flags. The inverse
holds too: `--env-file`, `--secret`, `--write`, and `--no-pin` with
`--backend remote` are errors, so the command can never report success while
requested environment, secrets, or permissions were silently dropped. The timezone
default (when `--timezone` is omitted) is the machine's IANA zone from
`Intl.DateTimeFormat().resolvedOptions().timeZone`, applied in the resolver so
the request always carries an explicit zone.

## Current limitations

- No per-run result retrieval; scheduled runs are fire-and-forget (the agent
  must deliver its own results) and are observed through statelog's
  schedule-run history and traces.
- Scheduled runs are unattended: a node that interrupts has no responder, and
  the server records the run as a terminal error.
