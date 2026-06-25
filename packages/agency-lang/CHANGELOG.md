## Jun 24 2026 — v0.6.4

### Language / Typechecker
- Fixed value-parameterized validation types (e.g. `NumberInRange(1, 10)!` from `std::types`); `@validate` factories now resolve instead of erroring on a missing function.
- New `std::capabilities` — standard capability effect sets.

### Runtime
- Unified abort taxonomy: aborts carry a typed cause (guard trip, user cancel, race loser) with `guardId` matching, so an outer guard no longer mis-attributes an inner trip. Thread cancellation is now non-destructive (preserves earlier rounds).
- `agency serve` now works for functions, not just nodes.

### Eval / Optimize
- Default judge now grades against `input.expected` even with no custom grader.
- `gepa` and `example` optimizers now populate the champion grade breakdown and select the champion by validation, matching `greedy`.
- Optimizer per-input working dir is seeded from the forked workspace, so agents that reference project files (e.g. `exec` on a repo path) find them instead of running in an empty dir.

### Agency Agent
- Can set the LLM provider used by the agency agent.

### Stdlib
- Marked more stdlib functions read-safe (pre-approved).

## Jun 22 2026 — v0.6.1

### Agency Agent
- Per-model cost attribution in the agency agent; tool-call branches now propagate their cost up to the main branch.
- Unhandled interrupts from the command line print a clear error message instead of crashing silently.

### Logs Viewer
- Grouped + flattened LLM call view; `e`/`E` expands/collapses the current node, `z`/`Z` expands/collapses the whole tree.
- Statelog viewer fixes: short IDs, cross-process tail decoding, and `logs` now defaults to the `view` subcommand.

### Runtime
- Structured abort causes — aborts now carry typed cause information instead of a bare string.

### CLI
- `agency serve` prints the list of exposed endpoints on startup.

## Jun 20 2026 — v0.6

### Language / Typechecker
- New effect sets and `raises` declarations; interrupt "kind" renamed to "effect".
- Builds are cached correctly when compiling a whole dir, where files may be imported multiple times. Previously the files would get recompiled multiple times.
- Fire-and-forget statelog events.

### Execution model
- Memory functions are now branch-scoped, and the memory id is set correctly inside forks.

### Eval
- New pluggable optimizer framework: bring your own optimizer (`--optimizer ./module.ts`), custom graders, validation sets, and a HumanGrader.
- Added the GEPA optimizer.
- `withCriteria` helper for declarative eval criteria (judge anchoring).
- Renamed "tasks" to "inputs" everywhere across evals and optimizers.

### Stdlib
- `std::chart` — new charting module.
- `std::table` — new table module.
- `std::syntax` — diff and patch functions, auto language detection, and themes (plus custom themes) for highlighting; removed `std::fs::printDiff`.
- Syntax-highlight code inside diffs.
- `std::llm` — user-selectable models via `setModel` / `setLlmOptions` / `pickProvider`, plus agent CLI flags.
- `std::edit` interrupts now render as a diff (prompt + auto-approve).
- `ls` caps its result count, and tool-call responses are size-capped.
- Fixed center alignment in `std::layout`.

### Agency Agent
- Esc cancels the in-flight request.
- Oneshot mode works.
- `/paste` adds multi-line input to the line-mode REPL.
- New `doctor` command
- Updated default models, and the agent prints which model was used.
- Fix for cwd - `getAgentCwd` / `setAgentCwd`.
- Policies pre-approve read-only agency commands. Fixed an extra prompt echo after interrupts and the coding agent losing all its tools after the first round.
- Stopped telling the agent to print highlighted code (removed the highlight/print tools).
- Fix bug where history file kept getting reset (was only saving the most recent session's history, now appends to it instead).

### Runtime / codegen / CLI
- Upgraded smoltalk to v0.4.1.
- Fixed duplicate tool names.

## Jun 12 2026 — v0.5

### Language / Typechecker
- Block types take named params and the `->` arrow.
- You can pass an array where a variadic is expected.
- Strings keep their original quotes instead of getting forced to double quotes, single-quoted strings work, and escapes are supported.
- Comments work inside records.

### Execution model
- Fork/parallel/race branches each get their own isolated state now (you can still opt into sharing). This means that users can safely store state in globals without worrying about concurrent access from different threads.

### Eval
- Big one: there's a whole new `agency eval` command — `extract`, `run`, `judge`, and `optimize` (this replaces the old `agency test eval`).
- New `optimize` modifier on variables, and we now find every optimize-marked variable across the whole import tree.

### Stdlib
- `withLock` — a mutex for threads.
- `std::layout` got tables, plus you can set widths (a number, a percent, or "full") and text wraps to fit.
- `std::args` for parsing command-line args.
- `std::skills` understands the standard SKILL.md format.
- Eval helpers (`evalJudge`, `evalExtract`), a `StatelogParser`, and `runAgencyAgent()` for running the built-in agents.

### Agency Agent
- Re-architected from a handoff model to a coordinator pattern.
- If you don't have a policy yet, it asks whether you want a minimal or recommended one and writes it out for you.
- Picks up your commands from `.claude/commands/`.
- Takes command-line args, plays nicely with unix pipes, and prints tool calls more readably.
- When it hits the max tool-call rounds it now tells the LLM to wrap up instead of throwing.

### Runtime / codegen / CLI
- Parsing got a lot faster — tarsec caches its line table and we memoize, taking ui.agency from 6s down to <1s.
- Docs only list exported functions and types now.

## Jun 3 2026 — v0.4

Breaking change: - **Disable per-function checkpoint** (perf). Was creating ~3 checkpoints per keystroke in the agent. Will return as opt-in eventually.

### Language / Typechecker
- Initialize static and global variables in the right order by running a topological sort to compute dependencies.
- `static` keyword now applies to bare top-level statements too.
- All statics and globals now initialize before any user code runs
- Typechecker no longer complains when a block arg is passed as a named arg.
- Allow bare top-level `<expr> with handler`.
- Interrupts inside handler functions are now disallowed at compile time.
- Fix infinite handler loops (an interrupt inside a handler function was triggering the same handler again).
- New `memory { ... }` blocks.

### Stdlib
- `std::ui` redesigned around a declarative builder + `runLoop` API
- `std::layout` — string layout utilities (boxes, rows, columns, padding, alignment).
- `std::markdown` — new module with `walk()` (map over AST) and `renderForCli()` (CLI-friendly markdown)
- `std::skills::readSkills` — load skills from a directory.
- Brave search moved into its own stdlib module.
- `~` expansion in stdlib path resolution.
- `shell::exec` accepts a `subcommand` so users can approve just one subcommand of a CLI.
- `printDiff()` and `edit(printDiff: true)` for colored diffs.
- Threads: continue prior threads and look up information across threads; eager summarize now works.
- Wikipedia: set a user agent (fixes 429); switched to the new REST endpoint.
- Moved some policy and agent functionality from the agency agent into the stdlib.

### Agency Agent
- Re-architected into a multi-agent architecture.
- Switched to **line mode** (TUI code left in place for now)
- Precompile bundled agents for faster startup.
- Markdown rendering with syntax-highlighted code blocks.
- Free-text response to an interrupt is treated as a rejection with the text as the reason.
- Built-in [superpowers](https://github.com/obra/superpowers) skill; coding agent prompt improved + given todo tools; research agent uses Brave search instead of browseruse.
- Quadrant-art images at session start.

Lots of improvements to the TUI version too, even though it is no longer the default:
- Redesigned status line (user input above, status takes two rows).
- Keyboard shortcuts (clear line, paste), multi-line input (shift+enter and multi-line paste).
- Fast-typing fix: previously dropped keystrokes when multiple chars arrived in one data event.
- Error handling inside the REPL: logger writes through `console` (not raw stderr) so the REPL's console capture isn't bypassed; error messages truncated to 5 lines.

### Runtime / codegen / CLI
- **Disable per-function checkpoint** (perf). Was creating ~3 checkpoints per keystroke in the agent and never freeing them — 2.5GB after a few turns. Will return as opt-in.
- `agency literate weave` command.
- Bundle agency docs files so agents can read them; frontmatter added to all docs.
- Upgrade tarsec

---

## May 28 2026 — v0.3

### Language
- Generics in Agency (`def foo<T>(x: T): T`, generic types)
- Value-parameterized type aliases (`type Age(low) = number`)
- Validation annotations: `@validate(...)` and `@jsonSchema(...)` on types, fields, and params
- `Success<T>` / `Failure<E>` type aliases for `Result`, with pattern-matching support for success/failure variants
- String interpolation inside docstrings
- `return llm(...)` works in any block body (no schema required for plain string output)
- Pipe operator fixes for method calls in chains
- `callback` keyword replaced by a scoped `callback()` stdlib function; callback bodies are lifted to the top level so they survive interrupt/resume
- `class` syntax removed
- Schema parameter injection for typed structured-output flows

### Stdlib
- `std::system::dirname()` — absolute path of the directory containing the calling compiled `.js` module; relative `read`/`write`/`readImage`/`edit`/`multiedit` now resolve against this directory rather than `cwd` (BREAKING — pass `dir: cwd()` to restore the old behavior)
- `std::skills::readSkill(filepath)` — `readSkill` moved out of the codegen magic into a regular stdlib module; import it explicitly
- `std::thread` with per-branch cost/token tracking and cost guards (`guard(cost: $X) as { ... }`)
- `std::validators`, `std::schemas`, `std::types` — runtime backing for the new annotation system
- AST functions for parsing, writing, formatting Agency code, and filtering imports
- Path containment on every fs/process helper: optional `allowedPaths: string[]` on `fs.{applyPatch,mkdir,copy,move,remove}`, `shell.{exec,bash,ls,grep,glob,stat,exists}`, `system.screenshot`, `speech.{speak,record,transcribe}`, `policy.writePolicyFile`. `shell::exec` also accepts `allowedExecutables: string[]` (renamed from `allowedCommands`, BREAKING for keyword callers)
- `sleep`, `input`, `prompt`, `exec`, `bash`, `oauth`, `browserUse`, `speech`, `system`, `fetch`, `fetchJSON` are now abortable: SIGTERM / `fetch` cancellation fires on Ctrl-C, race-loser, or time-guard abort
- `webfetch` renamed to `fetchMarkdown`

### TypeScript helpers (`agency.*` namespace)
- `agency.ctx`, `agency.callsite`, `agency.global`, `agency.thread.*` — read context and push thread messages from TS
- `agency.withHandler`, `agency.withCostGuard`, `agency.withTimeGuard`, `agency.addCost` — install handlers and guards from TS
- `agency.checkpoint`, `agency.getCheckpoint`, `agency.restore`, `agency.withCallsite` — checkpoint primitives
- `agency.llm(prompt, opts)` — façade over `runPrompt` with Zod-typed structured output
- `agency.withResumableScope(opts, body)` — Temporal-style journaled steps (`s.step`, `s.getLocal`/`s.setLocal`, `s.halt`)
- `agency.interrupt()` — raise interrupts from TS callers
- Memory layer now charges its internal LLM / embedding spend against the active `withCostGuard` via `agency.addCost`
- Docs: new [ts-helpers.md](docs/site/guide/ts-helpers.md), rewritten [ts-interop.md](docs/site/guide/ts-interop.md)

### Runtime / codegen
- AsyncLocalStorage migration: `__ctx`, `__state`, `__threads` all flow through the `agencyStore` ALS frame; matching dead-local prune in codegen
- The trailing `state` positional argument is gone from `AgencyFunction.invoke`, `__call`, `__callMethod`, and every generated `def` body (BREAKING; `getRuntimeContext` is no longer part of the public `agency-lang/runtime` surface — use `agency.ctx()` / `agency.ctxMaybe()`)
- `runBatch` concurrent-interrupt primitive; `fork`, `race`, `runPrompt` migrated onto it (parallel-tool dispatch + per-branch isolation)
- Callback-interrupt propagation through every codegen-emitted hook site (`onFunctionStart`, `onEmit`, `onNodeStart`, `onNodeEnd`); batch-interrupt collection across callbacks
- Timeout guards (`withTimeGuard`) and shared cost guards with real-time mid-fork enforcement
- `BootstrapThreadStore` + real threads delivered on `onAgentEnd`; fresh `ThreadStore` per tool call
- TypeScript Builder split into focused emitters (`AssignmentEmitter`, `ClassEmitter`, `PipeChainEmitter`, `NameClassifier`, `ScopeManager`, `StepPathTracker`, `partitionProgram`/`assembleSections`); high-frequency TS IR builders (`methodCall`, `awaitCall`, `iife`)

### Breaking changes summary
- Relative `dir` in `read`/`write`/`readImage`/`edit`/`multiedit` resolves against the module dir, not `cwd`
- Trailing `state` arg removed from `invoke`/`__call`/generated `def` bodies; `getRuntimeContext` not public
- `class` keyword removed
- `callback` keyword replaced by `callback()` stdlib function
- `shell::exec` parameter `allowedCommands` renamed to `allowedExecutables`
- `webfetch` renamed to `fetchMarkdown`

See [ts-helpers.md](docs/site/guide/ts-helpers.md) for the new TS API, including the determinism contract for `withResumableScope`.

---

## May 18 2026 — v0.2

### Language
- Destructuring and pattern matching (`match` blocks, destructuring in `let`/`const`/`for`)
- Undefined function diagnostics — typechecker warns on undefined functions
- Methods on primitives (e.g. `.length` on strings)
- Const reassignment checks in typechecker
- `parseJSON` built-in function
- Fix string interpolation parser for concatenating function calls and strings

### New: Memory Layer
- Built-in memory layer: temporal knowledge graph, hybrid retrieval, conversation compaction
- Configured via `agency.json`, accessible via `std::memory` (`remember`, `recall`, `forget`, `setMemoryId`)

### CLI
- `pack` command — creates standalone JS files with all dependencies inlined
- Fix global install of agency (`agency run` now tells node where to find agency-lang)
- `logs view` command — TUI for viewing statelog files with search, follow, clipboard, formatted LLM chat history
- Troubleshooting section added to guide
- Integration tests for the CLI (run on push to main)

### Observability / Statelog
- Lots of new statelog events, plus spans for more structured tracing
- Per-branch span stacks via AsyncLocalStorage (concurrent fork/race branches get proper span attribution)
- Statelog logging throughout the runtime and memory layer
- Timeouts for statelog calls (1.5s), `agentEnd` made fire-and-forget
- Performance improvements for traces

### TUI
- TUI abstractions extracted: line, scrollList, runLoop, key management

### Debugger
- Fix ctrl-z handling, fix rewindFrom

### Other
- Upgrade smoltalk to 0.3.0 (embed() and image() functions)
- Move to MIT license
- Typechecker now runs on all typescriptGenerator tests and stdlib code
- Dead preprocessor code removed

## May 13 2026 — v0.1.3

### Language
- `with approve` works on `return` statements
- `.preapprove()` method on AgencyFunction — wraps function in implicit approve handler; works with PFAs, global functions, imports, and the interrupt/resume cycle
- Parenthesized type expressions: `(name | serving_size)[]`, `(string | number)[]`
- Access chains on parenthesized expressions: `(a + b).foo`, `(foo()).length`, `(new Foo()).method()`
- Type aliases can be declared inside node/function bodies (hoisted at codegen)
- Compound assignment (`+=`, `-=`, `*=`, `/=`) to globals now lowers correctly
- Nested `fork`/`race` blocks can see outer block args
- Reserved `Result` type — cannot be redefined
- `as` not needed in blocks if no param

### TUI
- Syntax highlighting in TUI
- Remove `chalk` dependency (folded into termcolors)
- Various TUI fixes

### New: whisper-local package
- Add `@agency-lang/whisper-local` package (vendors whisper.cpp v1.7.6, pins SHA-256 hashes for all whisper models)

### Scheduling
- `schedule` command supports GitHub Actions as a backend

### Docs
- `doc` command lists interrupts thrown by a function

### Other
- Don't format object type as `Record`
- Coverage: thresholds, file exclusions, nicer PR comment
- Fix tool-retry test (safe nested method)

## May 12 2026 — v0.1.2

### New: Serve Command
- Add `agency serve` command — HTTP server for Agency programs
- Standalone mode for serve
- Expose nodes in MCP server
- Add Streamable HTTP transport for MCP server
- More granular policy tools for MCP server
- Add MCP interrupt policies
- Harden HTTP serve and MCP stdio against security issues

### New: Subprocess Execution
- Add `run()` function to execute Agency code in a subprocess
- Per-call resource limits for `run()`
- Timeouts for agency runner
- Restrict subprocess imports to stdlib files only

### New: Standard Library
- Add `@agency-lang/github` stdlib package
- Add `std::agency` with a `compile()` function
- Add `record()` function to speech stdlib
- Re-export zod from agency

### New: Static Analysis
- Add static interrupt analysis
- Surface interrupt kinds in serve and LSP hover
- Add trace mode to agency generator

### Language
- Add `export { foo } from "bar"` syntax
- Error on importing/exporting nodes with `safe` keyword
- Fix parser for multi-line parameter lists in function definitions and calls

### CI & Testing
- Add DeterministicClient for running agency/agency-js tests without OpenAI API key
- Add sandboxed stdlib tests (CI only)
- Add bundler and CLI integration tests
- Add `--coverage` flag
- Add docs build to CI, re-enable lint, harden GitHub Actions

### Other
- Fix phase ordering bug in TypeScript preprocessor (blocks not reading local variables)
- Move stdlib backing TS into `lib/` for clean three-phase build
- Function identity tracking
- Inline termcolors and remove as dependency
- Initial work on policy command
- Docs improvements and reorganization

## May 7 2026 — v0.1.0

### New: Standard Library Modules
- Add `std::browser` — Browser Use cloud API wrapper for web automation
- Add `std::email` — Email sending via Resend, SendGrid, and Mailgun APIs
- Add `std::sms` — Twilio SMS with E.164 validation
- Add `std::imessage` — iMessage via AppleScript
- Add `std::oauth` — OAuth 2.0 Authorization Code flow with PKCE, encrypted token storage, automatic refresh
- Add `std::keyring` — System keyring access (macOS Keychain, Linux Secret Service)
- Add `std::calendar` — Google Calendar (list, create, update, delete events) with OAuth integration
- Add `std::date` — Timezone-aware date/time utilities (now, today, tomorrow, addMinutes, addHours, addDays, atTime, startOfDay/Week/Month, etc.)
- Add `std::policy` — Structured interrupt policies
- Add `exec` and `args` to `std::system`
- Add `review` agent to stdlib

### New: Schedule CLI
- Add `agency schedule add/list/remove/edit` commands for running agents on a recurring schedule
- Supports launchd (macOS), systemd (Linux), and crontab (Linux fallback)
- Presets: `minute`, `hourly`, `daily`, `weekdays`, `weekends`, `weekly`, `monthly`
- Custom cron expressions with validation
- Per-run timestamped log files with automatic rotation

### New: Packages
- Migrate to pnpm workspaces
- Move MCP to its own package (`@agency-lang/mcp`)
- Add `@agency-lang/brave-search` package
- Add `@agency-lang/web-fetch` package
- Add `@agency-lang/email` package (Nodemailer-based SMTP)

### New: Language Features
- Add partial function application (PFAs/currying) with `.partial()` and `.description()` methods
- Add time units to Agency (e.g. `5.seconds`, `2.hours`)
- Add structured interrupts and policies
- Add concurrent interrupts
- Add parallel and sequential block types
- Make `catch` work with pipe operator
- Make inline blocks work with pipes (initial value no longer needs to be a result)
- Replace `shared` keyword with `static`

### Type Checker
- Typecheck block bodies: route returns and propagate slot types
- Handle optionals, excess property checks, better typing for LLM config objects
- Pipe slot validation, named-args by name, regex types
- Typecheck shorthand bang syntax for schema validation
- Result type improvements and reserved name checking
- Pipe arity, block types, suppression directives, cross-file aliases
- Resolve stdlib auto-imports via SymbolTable
- Condition and splat checks

### LSP
- Syntax highlighting on hover
- Show errors on the correct line
- Highlight selected variable across the file, document links, folding blocks
- Signature help, find references, rename symbol
- Dot-completion, show type on hover, go to type definition
- Code actions (add missing imports)
- Snippets, workspace symbols, local go-to-definition
- Filename completions for imports

### Formatter
- Preserve blank lines
- Add line length wrapping
- Sort imports

### Debugger
- Rewrite debugger and tests using the new `@agency-lang/tui` library
- Add `@agency-lang/tui` package (testable TUI with immediate-mode rendering and flexbox layout)

### Other
- Add `agency review` command for code quality review
- Various stdlib fixes for async, interrupts, module doc comments
- Loc-line normalization and cleanup

## Apr 25 2026 — v0.0.107
- Add inline blocks syntax
- Add support for `arr[0]()` and `arr[0]?.()` call syntax
- Add LSP implementation
- Add `setLLMClient` function for supporting other LLM clients
- Add `goto` keyword for state machine transitions
- Add `emit` function to emit arbitrary events that can be listened to through the `onEmit` hook
- Add support for importing types (`import type`)
- Add runtime call dispatch (checks at runtime whether to use `.invoke` or regular call)
- Use WeakMap so parallel callbacks don't block each other
- Print when a tool call crashes
- Fix `.agency` imports to always become `.js` imports, even when building `.ts`
- Fix docs to use backticks for return types (prevents Vue parsing errors with `Result<T>`)
- Delete old unused utility functions (`not`, `eq`, `and`, etc.)
- New interrupt tests

## Apr 22 2026 — v0.0.104
- First-class functions: `AgencyFunction` runtime class, better support
- Remove `uses` statement, `tool()` function, and `import tool` syntax
- Fix stdlib imports to not use relative paths

## Apr 21 2026 — v0.0.102
- Add mcp support with auth, docs
## Apr 21 2026 — v0.0.101
- Add mcp support
## Apr 20 2026 — v0.0.100
- Fix various import-related issues
## Apr 19 2026 — v0.0.93
- Added `schema()` function and made validation work with Result types
- Added `__type: "resultType"` tag to result types to avoid misdetecting user return values
- Added watch mode (`agency watch`)
- Added `traceDir` config option and `trace log` CLI command
- Added UI library to the standard library for building basic TUIs for agents
- Added LLM abort/cancel via `AbortController` (cancel in-flight requests, `AgencyCancelledError`, cleanup on teardown)
- Added Python-style slice syntax
- Added support for user-defined callbacks in Agency code
- Added many missing binary operators (`||=`, `&&=`, etc.), postfix `++`, and `typeof`/`instanceof`/`void`/`in` keywords
- Added doc comments and ability to link to code in other doc files or source files
- Added revivers for `Date`, `Error`, `RegExp`, `URL`, `Map`, and `Set`
- Allow bare `return;` statements
- Debugger: new checkpoint viewer UI, zoomable panels, ctrl-c/ctrl-z support, stdlib UI fallback, log tool calls with args, various fixes
- Fixed parser bug where comments after a binary operation were interpreted as part of the operation
- More docs: schemas, CLI options, smoltalk, debugger, TypeScript comparison
