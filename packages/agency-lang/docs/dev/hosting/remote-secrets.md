# `agency remote secrets`

Managing a hosted project's environment secrets — the values agency code reads
with `env("NAME")` from `std::system` — against statelog's encrypted,
**write-only** store. The server half is statelog's project-secrets feature
(`statelog/docs/dev/project-secrets.md`); this note covers the CLI's two
invariants and the seams that enforce them.

## The store is write-only; the CLI must look write-only too

No statelog route ever returns a secret's value, so there is no `secrets get`
and no `secrets pull`, and nothing in the CLI should imply otherwise. `list`
shows names and timestamps only.

## Invariant 1: the value never touches argv

There is deliberately **no `--value` flag** (a dispatch test pins that it stays
an unknown option). A value reaches `set` only through
`resolveSecretValue` (`lib/cli/remote/secretsInput.ts`), in precedence order:
`--from-env VAR` (copies a local environment variable), piped stdin (exactly
one trailing `\n` or `\r\n` stripped — a value meant to keep a final newline
supplies two, `printf 'value\n\n'`), or a hidden TTY prompt
(`promptSecretValue` in `confirmation.ts`, `prompts` type `"invisible"`,
`undefined` = canceled). All of it is injected: recipes never read process
globals, and the Commander actions wire the production adapters.

## Invariant 2: no code path prints a value

A hostile or misconfigured server can echo the submitted value (or the API
key) back in any failure. Three layers keep it out of output:

1. **`readJsonBody`'s `sanitizeDiagnostic` option** (`jsonBody.ts`) runs on the
   RAW body text, body-read exception messages, and the displayed final URL —
   *before* the whitespace collapse and 200-character truncation that would
   otherwise split a value beyond a split/join redactor's reach. It is
   diagnostic-only: protocol data is always parsed from the original text.
2. **`secretsClient`** builds a redactor per verb (`[apiKey, value]` on `set`,
   `[apiKey]` on `list`/`delete`), passes it as the sanitizer, and additionally
   redacts parsed server messages and schema diagnostics post-parse.
3. **`presentSecretError(error, sensitiveValues)`** (`commands/secrets.ts`) is
   the ONE place composing the display transformations, in fixed order:
   redact any additional known values → `terminalSafe` escaping → append the
   trusted one-line 401/403 guidance. Import passes *all* imported values in,
   so one request's failure can never disclose another name's value. Do not
   compose these steps anywhere else.

Untrusted display text (names, server messages) renders through
`terminalSafe`, which JSON-quotes anything containing control characters so a
parsed name can't inject ANSI escapes into the terminal.

## Failure taxonomy (verified against statelog `6cdfa23`)

Domain failures ride **HTTP-200 envelopes**: a missing secret is
`success:false` `"Secret not found."`, and the domain's race-case
`"Project not found."` (with a period) is also a 200 — both pass through as
ordinary errors. The only true 404s: the auth middleware's bare
`{ error: "Project not found" }` (no period; matched on the `error` field, not
whole-object equality) → slug guidance, and any other 404 → "this statelog
host does not support the secrets API (upgrade the host)". A mistyped secret
name therefore never produces the upgrade message. These routes are
API-key-only (full access) — sessions and invoke keys are rejected, which is
why 401/403 gets the full-access-key guidance.

## `import` mechanics

- Parsing is a pure wrapper over `node:util`'s `parseEnv`
  (`parseEnvSource`). The repo's `loadEnv` must NEVER be used here: it takes
  no path or source text, mutates `process.env`, and splits on `=` in a way
  that truncates exactly the values secrets are made of. Entries are
  `Object.entries(parseEnv(text))` — first-insertion order, last assignment
  wins on duplicates; there is deliberately no duplicate *reporting* (correct
  detection would need a second, quote-aware dotenv parser — a `B=` line
  inside a multiline quoted value is not an assignment).
- **Confirmation is for file sources on a TTY only.** `import -` never
  prompts: `readStdin` resolves at EOF and the confirm helper reads the same
  now-exhausted stream, and choosing `-` is itself the authorization.
- The POST loop catches only `SecretRequestError` (anything else is a bug and
  rethrows), continues past failures, and renders one outcome per line. An
  empty value is a per-name failure that sends nothing.

## Exit-status ownership

Recipes render and return semantic outcomes (`SecretsSetResult`,
`ImportResult`); the **Commander actions** are the only place that sets
`process.exitCode` (canceled set, declined or failed import → 1). Preflight
failures (unreadable file, empty parse, target resolution) use `fail()`,
which exits immediately — the POST loop must never call it.

## Injection-timing caveats (from the statelog side)

A secret set here is visible to `env("NAME")` reads in node/function bodies
and ordinary module-level `let` initialization on the next invocation. It is
NOT visible to `static const` captures after the first invocation (they go
stale) or to agency runtime *config* reads (LLM provider keys wired at module
build). Don't promise per-invocation secrets for those.
