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

### New: Stdlib
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
