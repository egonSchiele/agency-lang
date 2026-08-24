# Agency Language

## Overview

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls OpenAI's structured output API.

Please read the guide at docs/site/guide/ to get up to speed on the language.

NOTE! Most of the file paths you'll see in this CLAUDE.md are relative to the packages/agency-lang directory, as that is the main package and contains all the code for agency lang.

## Key Commands

```bash
make                    # build everything (ALWAYS use this when changing stdlib files)
pnpm test               # Run vitest in watch mode
pnpm test:run           # Run vitest once
pnpm run agency <file>  # Compile and run an .agency file
pnpm run agency test <file>  # Run a single Agency test
pnpm run agency test js <file>  # Run a single Agency js test
pnpm run compile <file> # Compile .agency to .ts
pnpm run ast <file>     # Parse .agency and print AST as JSON
pnpm run preprocess <file>     # Parse .agency, run preprocessor, and print the resulting AST as JSON
pnpm run fmt <file>     # Format .agency file using the AgencyGenerator
make fixtures           # Rebuild all integration test fixtures
pnpm run lint:structure # Run structural linter
pnpm run fmt:ts         # Format TypeScript with prettier (CI fails if you skip this)
```

## The full pipeline

`parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`

## Testing

See `docs/misc/TESTING.md` for the full testing guide.

Agency execution tests (`tests/agency/`) do NOT require LLM calls. They can test pure logic, interrupts, async calls, etc. without any LLM involvement. Use them for any runtime behavior test.

Agency-js tests (`tests/agency-js/`) are similar, but let you test how agency code interacts with js code.

Note that although agency and agency-js tests don't *require* LLM calls, they can support them if needed. Don't make any extra LLM calls because they are slow and expensive, but if you are writing a test and you *need* to make an LLM call, please feel free to make one.

IMPORTANT! When you run tests, save the output to a file so that if the tests fail, you don't need to rerun them to see what failed. The tests in this repo are very expensive and slow to rerun, so if you keep rerunning tests to see what failed, you're going to waste a lot of time. Just run the test and save the output in a file once so you can examine the output at your leisure.

Note: Do not run the agency test suite locally. It takes a long time to run. When you create a PR, CI will run those tests for you. In the meantime, you're welcome to run specific agency tests locally if they are relevant to your change, but don't run the full test suite.

## Documentation

Standard library reference documentation is generated from Agency source using `agency doc`. When adding or changing stdlib APIs, write module-level doc comments, function doc comments, and docstrings in the `.agency` source files instead of hand-editing generated `docs/site/stdlib/*.md` pages. Docstrings also become tool descriptions for LLM-callable functions, so keep them accurate and user-facing. See `docs/site/cli/doc.md` for the `agency doc` conventions.

## CRITICAL: Handlers are safety infrastructure
Handlers (`handle` blocks) are a crucial part of what makes Agency safe. They must NEVER be accidentally skipped or left unregistered. Any feature that affects execution flow (rewind, interrupts, checkpoints, state restoration) must ensure handlers are correctly registered and invoked. If there is any risk of a handler being skipped, treat it as a critical issue and flag it immediately. Handlers are registered on `__ctx.handlers` via `pushHandler()` in the generated code and are NOT serialized as part of checkpoint state — be aware of this when working on state restoration features.

## VERY IMPORTANT: Agency syntax rules
When writing Agency code (in plans, specs, tests, or examples), you MUST use the correct syntax. Verify against `docs/site/guide/basic-syntax.md` and existing test fixtures when unsure.

**Correct syntax:**
- Functions use `def`, curly braces, and optional `: ReturnType` after params: `def foo(x: number): string { ... }`
- Nodes use `node`, parentheses for params, and curly braces: `node main() { ... }`
- `if`, `while`, and `for` statements REQUIRE parentheses around the condition AND curly braces for the body: `if (x > 5) { ... }`
- Variables must be declared with `let` or `const` before use. Bare assignment (`x = 5`) is NOT allowed without a prior declaration.
- `for` loops use `in`: `for (item in items) { ... }`

**Common mistakes to NEVER make:**
- `function foo() -> ReturnType:` — WRONG. Use `def foo(): ReturnType { ... }`
- `node main -> end:` — WRONG. Use `node main() { ... }`
- `if condition:` / `if condition {` — WRONG. Use `if (condition) { ... }`
- `result = foo()` without `let`/`const` — WRONG unless already declared.
- Using Python-style colon+indentation for blocks — WRONG. Always use `{ ... }`

**When writing plans or specs:** Always verify Agency code snippets by checking docs/site/guide/basic-syntax.md and existing test fixtures (tests/agency/, tests/typescriptGenerator/). If unsure about syntax, run `pnpm run ast` on a test file to confirm it parses.

## General code Guidelines
- Do not add code to support symlinks. Symlink support is not important right now; where a feature would need extra machinery to handle symlinks, refuse symlinks instead.
- NEVER use dynamic imports
- Use objects instead of maps.
- Use arrays instead of sets.
- Use types instead of interfaces.
- NEVER force push or amend commits.

## Things that often confuse you
Tools and functions are the same thing in the agency. Functions are tools. So there is no point in treating tools and functions separately because they're the same thing.

Please note that you cannot write and run agency files in the `/tmp` directory or any directory outside of the current directory, because certain node modules are needed for the files to run and the `/tmp` directory does not have those node modules.

## Guidance on writing commit messages and PR descriptions
If you try to write commit messages with apostrophes right on the command line, you will get an error. I'm telling you this now because you do this every time. Same with PR descriptions. Instead you need to write the commit message or PR description in a file, and then pass that in to the git command.

## Creating worktrees
Always create work trees inside the agency-lang directory. Never create work trees directly in home directory.

## General writing tips
When talking to me, or writing documentation or comments, please follow these general writing tips: packages/agency-lang/docs/dev/general-writing-tips.md

Specifically, make sure you are writing readable prose, not using jargon, and explaining things with examples where possible.

## Anti-patterns
Make sure the code you write does not have any of these anti-patterns:
packages/agency-lang/docs/dev/anti-patterns.md

## Deeper docs

Read these before starting work:
- `docs/dev/coding-standards.md` — Banned patterns and style rules. Enforced by the structural linter.
- `docs/dev/formatting.md` — Prettier for hand-written TypeScript: `pnpm run fmt:ts`, what is ignored and why, the VS Code wiring, and the CI check
- `docs/dev/anti-patterns.md` — Common mistakes with before/after examples.
- `docs/dev/adding-features.md` — Step-by-step guides for adding AST nodes, CLI commands, etc.

Pipeline and architecture:
- `docs/dev/typescript-ir.md` — Structured TsNode tree representation of generated TypeScript
- `docs/dev/typechecker/` — Bidirectional type checking (overview in `README.md`; flow-sensitive narrowing in `narrowing/`)
- `docs/dev/interrupts.md` — How interrupts resume inside blocks using step counters (substeps)
- `docs/dev/simplemachine.md` — Graph execution engine that runs compiled Agency programs
- `docs/dev/async.md` — How async function calls work
- `docs/dev/checkpointing.md` — Snapshotting execution state for retry loops and rollback
- `docs/dev/threads.md` — ThreadStore and MessageThread system for LLM conversation history
- `docs/dev/globalstore.md` — Global variable management with module isolation and serialization
- `docs/dev/init-topsort.md` — Per-variable init dep graph, topological sort, per-module init plans, runtime init registry
- `docs/dev/smoltalk.md` — External LLM client library for structured output requests
- `docs/dev/run-directory.md` — The run directory (`lib/runDirectory/`): the statelog is the run; the coherent lock-free read snapshot (plus the best-effort `notes.md` read outside it), the three annotation kinds and their fold (deterministic ids, complete-pass scores, per-question checklist fold, revision-named annotators), the one-run invariant (reader guard + writer preflight), the four declarative writes and their preflight/torn-tail/lock rules, digest merge, code-by-closure-hash, dated workdir snapshots, and `safeDeleteDirectoryWithin`
- `docs/dev/statelog.md` — Observability and tracing system for execution events; `agentStart` records code identity (`code`, cwd-independent closure hash) and the explicit `input`
- `docs/dev/config.md` — AgencyConfig options for compiler and runtime configuration
- `docs/dev/approval-policies.md` — How policy rules match: absolutized dir values, the `.` = launch-directory resolution, picomatch's `**`-skips-dot-segments rule, and why eval `.staging` workdirs need a cwd-scoped policy
- `docs/dev/cli-arguments.md` — One command line, two programs: the position rule (agency's flags before the filename), the ownership rule (a flag is valid after its owning command, never before), the misplaced-flag warning and its `--` suppression, the shorthand being the real `run` command, the agent's full flag delegation with the minimal launcher pre-scan, and the `--` asymmetry across launchers
- `docs/dev/vendored-commander.md` — The vendored commander fork: what was copied, the six ledgered modifications (duplicate-name guard, boundaries, provenance, fallback, ownership-aware parsing), the fork-discipline rules, and how to diff against upstream
- `docs/dev/supply-chain.md` — Dependency supply-chain hardening: the 7-day release-age cooldown and its first-party exclusions, exotic-subdep blocking, install-script denials, and why the pnpm version is pinned in the root package.json (older pnpm silently ignores all of it)
- `docs/dev/debugger.md` — Interactive debugger for stepping through and rewinding execution
- `docs/dev/concurrent-interrupts.md` — Supporting multiple concurrent threads that interrupt simultaneously
- `docs/dev/tool-loop-guards.md` — The two refusals in the tool loop: a call repeated with the same arguments and the same result (`maxRepeatedToolCalls`, default 3, `0` disables) and a string argument that is really tool-call markup (`</antml…`); both before hooks, neither counts as a failure
- `docs/dev/runBatch.md` — The `runBatch` primitive: signature, three modes, slice rule, invoke no-throw contract, defensive guards
- `docs/dev/saveDraft.md` — saveDraft salvage-on-abort: aborted functions return their draft (`AbortedResult`), the salvage rules and why they are structural, trade-offs, and easy-to-miss nuances — including the three node boundaries that turn an abort back into an exception (`throwIfNodeResultAborted`: why it must run before `createReturnObject`, why a tail-position `return foo()` needs it, why the partial goes through `atNodeBoundary()`, and the `endsRun` trace-writer rule), and why a diagnostic must ride the `AbortCause` rather than the error object
- `docs/dev/reply-attachments.md` — How tools hand images back to the model: attachToReply, branch-local queues, harvest/inject in the tool loop, marker-string API
- `docs/dev/writing-optimizers.md` — How to write a new `optimize` strategy on `BaseOptimizer`: the contract, helpers, grading semantics, reflection feedback, registration, testing
- `docs/dev/std-agency-test.md` — std::agency test()/testFile(): the closure validator's pure-Agency invariant and mirror TOCTOU boundary, one-vote scripted answers (and the outer-valueless-approve merge wart), gate-before-read testFile, and convergence with the CLI runner
- `docs/dev/test-cli-sandbox.md` — `agency test run` / `agency run` under `--policy`/`--reject` and `--agency-only` (+ `--json`): why the two flags together make running untrusted Agency safe (reject beats `with approve`; static init cannot interrupt), the clear-then-set env rule, flags go after `test run`, a refusal is a file failure
- `docs/dev/eval-tracking.md` — Tracking agent evals on statelog, the agency-lang half: `eval run --trials k` (`<out>/<test>/<trial>/`, trial-major, `batch`/`trial` on every run row), batch statistics over a complete trial grid with SE paired by trial index, one summary derivation for traced AND silent runs (`status`, `endedAt`, `score` = grading's did-not-finish-is-zero rule), `summarizeEvalRun` as the canonical-rows boundary statelog must not go around, `eval upload`'s server-proven upload states and the events-before-annotations rule, URL-safe agent names, the narrow `agency-lang/eval` exports, and what the statelog PR must provide
- `docs/dev/eval-grading.md` — The run directory is the interface between running and grading: `eval run` never grades (staging → `recordCompletedRun`, harness-minted trace ids incl. `AGENCY_TRACE_ID` for command agents), `eval grade` reads the directory and records one complete grading pass of `score` annotations, errored-runs-score-zero via the harness's `run` row, per-test graders and the override/fallback precedence, revision-named graders
- `docs/dev/logs-viewer.md` — The interactive statelog viewer: the component View classes and view stack, the timeline kernel (self-time, busyness shading, thread-label grouping), and the rebuilt follow mode
- `docs/dev/runs-explorer.md` — The cross-run explorer behind `agency logs <paths…>`: the loader's two-read phase 1 + bounded backfill, cursor pinned to row identity, the shared column-width table component, the embedded-viewer hand-off rules, CSV semantics
- `docs/dev/eval-command-agents.md` — Running a CLI as the eval agent (`--agent-cmd`): the EvalTarget union, tokenize-then-substitute, the AGENCY_CONFIG_OVERRIDES/AGENCY_TRACE_ID statelog handoff, process-group kill lifecycle, and the two cost-cap feeds
- `docs/dev/pkg-imports.md` — Importing Agency code from npm packages using `pkg::` prefix
- `docs/dev/trace.md` — Execution traces capturing checkpoints at every step
- `docs/dev/binop-parser.md` — Binary expression parser using precedence climbing
- `docs/dev/locations.md` — How `loc.line` / `loc.col` / parse-mode template offset interact
- `docs/dev/validation-annotations.md` — `@validate(...)` and `@jsonSchema(...)` internals: tag merging, `__agency_descriptor` contract, descriptor tree, runtime walker
- `docs/dev/async-context.md` — `agencyStore` AsyncLocalStorage frame and `getRuntimeContext()` pattern for stdlib TS helpers
- `docs/dev/local-models.md` — Local-model support: provider, name resolution, catalog refresh, and SHA-256 download verification
- `docs/dev/incremental-builds.md` — The build manifest: schema, invalidation fields, the ManifestTracker policy object, --force
- `docs/dev/doc-cache.md` — The `agency doc` incremental cache: the output-directory ownership ledger, freshness vs ownership evidence, the linkTargets re-check, the deletion boundary, and the conservative no-ledger contract
- `docs/dev/splices.md` — Compile-time splices `$( ... )`: where expansion sits in the pipeline, the five paths that must run it, why the cache is mandatory, the import restriction that carries the safety argument, and the cycle guard
- `docs/dev/effect-propagation.md` — How a function's interrupt effects are computed: the shared walk in lib/analysis/effects.ts, the fixpoint at the end of SymbolTable.build, following re-exports, the `.invoke()` shape, why `_guard` is seeded rather than walked, and the four things the walk cannot see
- `docs/dev/trailing-comments.md` — How `agency fmt` keeps an end-of-line `//` comment where it was written: the two mechanisms (`BaseNode.trailingComment` vs `placement: "trailing"` list trivia) and which applies where, who owns the end of the line, why a reordering formatter path must call `remapListTrivia`, the `CommaListPolicy` table, and the three ways this silently regresses
- `docs/dev/template-agency.md` — Template Agency internals: the Hole node and per-position parsing, `Code` fragment kinds, the never-parse lifting rule and its two escaping conventions, scope-keyed hygiene with `__hyg` seeding, AG8001/AG8002 refusals, and the walker-completeness tripwire
- `docs/dev/hosted-agent-execution.md` — Hosting agents on statelog (`agency deploy` + the `./serve` API): the serve wire contract and moduleId gotcha, per-agent observability via `withRuntimeConfigOverrides`, `compileSource(sourcePath)` for multi-file, the deploy CLI's module layout, the statelog host pieces, and the known limitations
- `docs/dev/statelog-clients.md` — The seven sealed statelog CLI clients over the one `statelogRequest` transport core: family-owned failure mappers vs core-owned fetch/envelope mechanics, the classification precedence, the two deviants (`requireOk:false` for upload, `contentType:"always"` for serve), `readJsonBody`'s redirect/http:// diagnosis, and the test rule that mocks stub `text()` not `json()`
- `docs/dev/remote-secrets.md` — `agency remote secrets`: the write-only store, the two invariants (value never in argv, value never in output) and their three enforcement layers (`sanitizeDiagnostic`, per-verb client redaction, `presentSecretError`), the HTTP-200 failure taxonomy, `import`'s parseEnv/no-`loadEnv` rule and file-only confirmation, and Commander-owned exit codes
- `docs/dev/schedule-remote-backend.md` — `agency schedule --backend remote`: the server-authoritative contract (no registry entry), binding-based target resolution via `resolveProjectTarget`, the failure-inside-HTTP-200 envelope, deploy-if-missing and the `runDeploy` outcome gate, the PATCH-only-cadence edit limitation, and why remote-only flags fail loudly on other backends
- `docs/dev/eval-labeling.md` — `agency label <path…>` over a group of run directories: `resolveLabelingGroup` (one common parent, aliases dropped, duplicate trace ids refused), session files in `<group>/checklists/`, the `labelStore.ts` facade, identities (trace id, checklist revision, question id, session id, deterministic annotation id), the checklist row shape, the per-question fold, the sign-off commit protocol and its recovery boundaries, the three narrow locks (per-session draft, per-publication, per-run append via `recordChecklistRow`) and why there is no group lock, and why validation is strict where grading is tolerant
- `docs/dev/invocation-usage-accounting.md` — The serve cost seam's full cost/token breakdown: the authoritative-flat-total vs best-effort-attribution split, the valid-price and kind-specific-token rules, the one `recordUsageDelta` sink, untrusted IPC recovery that never drops money, the #809 rejected-promise boundary, and the `agency remote spend` schema/rendering
- `docs/dev/per-invocation-config.md` — Per-invocation config overrides + injectable trace id: the `InvocationOptions` request, the single `resolveInvocation()` policy owner, the positive v1 config allow-list (and the inert filesystem/code-loading/model fields), run-id precedence and the resume rule, `RouteResult.traceId` presence, and the agency-is-a-mechanism / host-owns-clamping-and-trust boundary
- `docs/dev/aws.md` — AWS stdlib support (`std::aws/s3`): the SigV4 signer (node:crypto only, no SDK), the functional core (uri/base64/credentials/endpoints/sigv4/client), the atomic `AwsRequestTarget` and one-encoding canonical-URI contract, the single `runS3Operation` declarative executor, the bounded region/partition policy + `ValidatedBucket` + final-hostname defense, `std::aws/s3` vs the `std::aws::s3::*` effect labels, interrupt+destructive writes, strict-base64 binary with the 10 MiB two-way cap, the statelog redaction with a custom marker + narrowed v1 guarantee, and presigned URLs (query-string SigV4, the one-encoding contract on the query, the non-inherited final-hostname check, bearer-URL redaction)
- `docs/dev/data-connectors.md` — Writing a `std::data` connector: the shared core (`connectorFetch`'s internal approve as a vote not a bypass, `connectorError`, `clampLimit`, `dateStrToEpochMs`), the 8-part anatomy modeled on `stdlib/data/social/bluesky.agency`, the conventions (epoch-ms times, union-typed enums, clamped limits, `idempotent` reads, payload carries what handlers judge), wire types validated with bang syntax at the finalize boundary (`shapeError` embeds Zod's mismatched paths so drift fails loudly), the fetchMocks testing template incl. the shape-drift test, the agency-js style (import test, the propagate-surfaces-the-fetch pattern, -live tiers), ergonomics rules (adapt-don't-mirror, tagged unions over sentinels), the two runtime gotchas, and how to update a connector (absorbed the old adding-connectors.md)
- `docs/dev/speech-via-smoltalk.md` — Cloud speech (STT `transcribe` / TTS `speak`) routed through the LLM client like `std::image`: the local `say` vs cloud `speak` rename and DISTINCT effects (`std::say` vs `std::synthesizeSpeech`), the `_speak` ABI freeze, the conservative #809 failure-accounting rule, atomic no-clobber TTS publication (`publishSpeechOutput`), audio-token collapse into `totalTokens`, the `transcription`/`speechSynthesis` leaf events, the `Attachment` vs `MessageAttachment` split for `audio()`/`attachToReply`, and cancellation (branch signal → smoltalk `abortSignal`; `SmoltalkClient` adapts smoltalk's resolved `failure("Request was aborted")` into a reject with the branch reason via `rejectIfAborted`, since the `LLMClient` contract rejects on abort)

Other references:
- `docs/misc/TESTING.md` — Full testing guide (unit tests, fixtures, execution tests, agency-js tests)
- `docs/misc/config.md` — `agency.json` configuration file
- `docs/misc/lifecycleHooks.md` — Lifecycle hooks and callbacks
- `docs/misc/stateStack.md` — State stack serialization/deserialization for interrupts
- `docs/misc/typeChecker.md` — Type checker usage
- `docs/misc/envFiles.md` — Environment variables and .env files

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files. See Tarsec docs: https://egonschiele.github.io/tarsec/. Debug parser errors with `DEBUG=1 pnpm run ast foo.agency > foo.debuglog`.

Templates in `lib/templates/` are compiled via [typestache](https://www.npmjs.com/package/typestache). Run `pnpm run templates` to recompile. Only modify `.mustache` files, not the generated `.ts` files.

The runtime (`lib/runtime/`) is the library that compiled Agency code imports at execution time. Push functionality here whenever possible — it's testable and type-safe, unlike generated code.
