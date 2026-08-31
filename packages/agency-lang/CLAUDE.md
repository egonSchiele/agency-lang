# Agency Language (packages/agency-lang)

This package is the language itself: compiler, runtime, standard library, CLI, and the built-in agent. Paths in this file are relative to this directory.

Read the guide at `docs/site/guide/` to get up to speed on the language.

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

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files. See Tarsec docs: https://egonschiele.github.io/tarsec/. Debug parser errors with `DEBUG=1 pnpm run ast foo.agency > foo.debuglog`.

Templates in `lib/templates/` are compiled via [typestache](https://www.npmjs.com/package/typestache). Run `pnpm run templates` to recompile. Only modify `.mustache` files, not the generated `.ts` files.

The runtime (`lib/runtime/`) is the library that compiled Agency code imports at execution time. Push functionality here whenever possible, because it is testable and type-safe, unlike generated code.

## Testing

See `docs/misc/TESTING.md` for the full testing guide.

Agency execution tests (`tests/agency/`) do NOT require LLM calls. They can test pure logic, interrupts, async calls, etc. without any LLM involvement. Use them for any runtime behavior test.

Agency-js tests (`tests/agency-js/`) are similar, but let you test how agency code interacts with js code.

Note that although agency and agency-js tests don't _require_ LLM calls, they can support them if needed. Don't make any extra LLM calls because they are slow and expensive, but if you are writing a test and you _need_ to make an LLM call, please feel free to make one.

IMPORTANT! When you run tests, save the output to a file so that if the tests fail, you don't need to rerun them to see what failed. The tests in this repo are very expensive and slow to rerun, so if you keep rerunning tests to see what failed, you're going to waste a lot of time. Just run the test and save the output in a file once so you can examine the output at your leisure.

Note: Do not run the agency test suite locally. It takes a long time to run. When you create a PR, CI will run those tests for you. In the meantime, you're welcome to run specific agency tests locally if they are relevant to your change, but don't run the full test suite.

## Documentation

Standard library reference documentation is generated from Agency source using `agency doc`. When adding or changing stdlib APIs, write module-level doc comments, function doc comments, and docstrings in the `.agency` source files instead of hand-editing generated `docs/site/stdlib/*.md` pages. Docstrings also become tool descriptions for LLM-callable functions, so keep them accurate and user-facing. See `docs/site/cli/doc.md` for the `agency doc` conventions.

## CRITICAL: Handlers are safety infrastructure

Handlers (`handle` blocks) are a crucial part of what makes Agency safe. They must NEVER be accidentally skipped or left unregistered. Any feature that affects execution flow (rewind, interrupts, checkpoints, state restoration) must ensure handlers are correctly registered and invoked. If there is any risk of a handler being skipped, treat it as a critical issue and flag it immediately. Handlers are registered on `__ctx.handlers` via `pushHandler()` in the generated code and are NOT serialized as part of checkpoint state — be aware of this when working on state restoration features.

## MUST READ: How interrupts, handlers, policies, and effects work

Interrupts are the most important feature of this language. Every task that touches them — code, review, spec, or plan — starts here. Do not reason about interrupts from grepped code fragments; an earlier review got the whole resume model wrong that way and proposed a security fix for a hole that did not exist. Read this section, then the guide pages (`docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`, `policies.md`), then the dev doc for the mechanism you are changing.

### The four words

- **Effect**: the name of a kind of permission, declared with `effect std::env { name: string }` (`stdlib/system.agency:33`). Effects are what handlers and policies match on.
- **Interrupt**: one raise of an effect, with a message and data: `interrupt std::env("Are you sure…?", { name: name })`. It pauses the program until someone answers approve or reject.
- **Handler**: code that answers a raise. `handle { … } with approve`, `handle { … } with (intr) { … }`, or `someCall() with approve`.
- **Policy**: a JSON rule set (`lib/runtime/policy.ts`) that matches interrupts by effect and data globs. A policy can be used inside any handler, as a programmatic way to respond to interrupts. The benefit of policies is they allow you to specify how to respond to interrupts in a way that can be saved as pure data. You can save a policy as a JSON file and then use `agency run --policy <file>` to run some code with a specific policy.

### The lifecycle of one raise

Follow `env("FOO")` through `stdlib/system.agency:109-113`:

```
def requestEnvRead(name: string): string | null {
  return interrupt std::env("Are you sure…?", { name: name })
  return _env(name)
}
```

#### 1. Raise

The function raises an interrupt. The interrupt's effect is `std::env`. The interrupt has a message and some additional data.

#### 2. Handling programmatically

Every interrupt can be responded to programmatically or interactively. To respond to an interrupt programmatically, you wrap it in a handler like this:

```
handle {
  requestEnvRead("FOO")
} with (intr) {
  if (intr.effect == "std::env") {
    return approve()
  } else {
    return reject()
  }
}
```

An interrupt may trigger one or more handlers. Handlers nest. When an interrupt is raised, _every handler in its chain is consulted, not just the first one, and if any of those handlers returns a rejection, then the interrupt is rejected_. This is a key safety property of this language, because it means that users always have a chance to reject an action. Interrupts are usually raised before taking an action that is considered to be dangerous, destructive, or something that will mutate a value or read sensitive data: actions to read and write files or environment variables, for example. In Agency, every function is a tool that an LLM can call. Therefore, interrupts are important because they allow a user to reject an action that an agent wants to take.

#### 3.a Handling interactively

Like I said, you can respond to interrupts interactively or programmatically. If you don't respond to an interrupt programmatically, you must respond to it interactively. The interactive part happens in different ways, but the mechanism is fundamentally the same.

Suppose you are calling this agency code from TypeScript code. An interrupt has been raised and it did not get handled programmatically. What will happen is the entire execution state of the agency code will get serialized into a checkpoint. The interrupt and the checkpoint will both get surfaced to the TypeScript code, and in TypeScript, you can respond to the interrupt. When you do, you also pass in the checkpoint data, and Agency will use the serialized execution state in that checkpoint to restore execution to where it was. This is a pretty cool and important feature of Agency because it means that at any point, you can save the execution state of some agency code, and later on, you can resume that agency run at that exact line. This is an unusual feature for a language – no mainstream language lets you resume execution from an exact line across process boundaries. It's a really useful feature for agency, because it means that when an agent tries to take an action that is potentially risky, you can always choose to surface that to a human and get human approval.

#### 3.b The `--interactive` flag

I mentioned that the interactive part can happen in different ways. Here we saw the example of calling agency code from TypeScript code. But you can also run agency code on the command line and pass the --interactive flag to respond to interrupts interactively:

```
agency run --interactive <script.agency>
```

You can also approve or reject specific effects on the command line:

```
agency run --approve std::read --reject std::write <script.agency>
```

#### 3.c Serving agents interactively

Finally, another way users can respond to interrupts interactively is when your agent is being served. Agency has a serve feature that lets you serve your agent as an HTTP or MCP server. In that case, all of your exported nodes and functions become endpoints that can be hit on the server.
In that case, if something raises an interrupt, and it is not handled programmatically, it gets returned to the user along with a checkpoint for interactive response, and then the user needs to hit a specific `/resume` endpoint with the interrupts (each carries its checkpoint) and one approve or reject response per interrupt in order to resume from there.

#### 3.d When interrupts go to a human

Note that the interrupt only goes to a human for interactive approval in two cases:

1. No handler was able to give an adequate response for this interrupt. If any handler rejects the interrupt, the interrupt is immediately rejected. If any handler approves the interrupt, we still run all of the handlers to make sure that none of them reject. Then if all the handlers have been run, and there is at least one approval, the interrupt is approved. If no handler approved, then the interrupt goes to a human for interactive approval.
2. If any handler explicitly returned "propagate" for this interrupt, the interrupt will go to a human for interactive approval (unless it gets rejected, in which case it will be immediately rejected).

#### 4. Resume

When we resume from an interrupt, what happens depends on the response to the interrupt. If the interrupt was rejected, the function that the interrupt was raised in exits immediately with the failure. If the function was called as a tool by an LLM, we return a clear message to the LLM saying that the call was rejected.
If the interrupt was approved, then the function resumes from after the exact line where the interrupt was raised. Note it's important to understand that none of the data tied with the interrupt is used for anything except giving users information about the interrupt. For example, let's go back to the interrupt that was raised for reading an environment variable. You can see the data contains the name of the variable being read:

```
return interrupt std::env("Are you sure…?", { name: name })
```

We expose the name of the environment variable so that users can write code that responds to the interrupt programmatically based on the name. Or if they're responding to the interrupt interactively, they'll want to see the name to see environment variable we're trying to read, in order to decide whether to approve the read or not. That interrupt data is not used for anything else. In particular, it is never used when you resume from the interrupt. For example, a user could not choose to approve this interrupt, but pass in a name of a different environment variable.

There is a separate way to raise an interrupt where we do seek feedback from the user. That way looks like this, where the interrupt is used in an assignment:

```
let userResponse = raise std::getEnvName("What environment variable should I read?")
```

In this way, the user approves with some data. Even in this case, the interrupt data itself is not used for anything after we resume. The interrupt data is only used to give the user more information about what the interrupt is for.

### The checkpoint _is_ the program.

Like I said, the checkpoint is the serialized execution state of the program, which means it contains everything about the program: What line the user is on, what the call stack is, what the local and global variables are, etc. This means that someone could modify the checkpoint state to change the data we resume with. In the code to read an environment variable that we have been discussing, a user could change the value of the `name` variable in the `requestEnvRead` function before resuming the checkpoint, and that would mean that now the checkpoint is going to read a different environment variable instead. This is a potential attack vector that we must guard against.

We have a lot more documentation containing implementation details in docs/dev/:

- How a program resumes mid-block is `docs/dev/runtime/interrupts.md`.
- We've been talking about one interrupt, but actually, Agency supports multiple interrupts being raised concurrently from multiple threads, and it can pause and resume multiple threads. Information for this feature is in `docs/dev/runtime/concurrent-interrupts.md`.
- Details about the checkpoint format are in `docs/dev/runtime/checkpointing.md`.
- More info about policies is in `docs/dev/agents/approval-policies.md`.
- The HTTP round trip is `docs/dev/hosting/how-hosted-serving-works.md`.
- The `with approve` shorthand is `docs/dev/language/with-approve.md`.
- How effects propagate through function signatures is `docs/dev/compiler/effect-propagation.md`.

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

**When writing plans or specs:** Always verify Agency code snippets by checking `docs/site/guide/basic-syntax.md` and existing test fixtures (`tests/agency/`, `tests/typescriptGenerator/`). If unsure about syntax, run `pnpm run ast` on a test file to confirm it parses.

## Things that often confuse you

Tools and functions are the same thing in the agency. Functions are tools. So there is no point in treating tools and functions separately because they're the same thing.

Please note that you cannot write and run agency files in the `/tmp` directory or any directory outside of the current directory, because certain node modules are needed for the files to run and the `/tmp` directory does not have those node modules.

## Deeper docs

`docs/dev/` holds a doc per feature, recording the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss. **Read the one covering an area before changing it.** The index below lists every doc with what it is for; skim it at the start of a task and open the ones that match.

Read these four before starting work:

- `docs/dev/contributing/coding-standards.md` — Rules for writing code here. Each rule says whether the structural linter enforces it or it is a convention.
- `docs/dev/contributing/anti-patterns.md` — Common mistakes, each with a before/after example.
- `docs/dev/contributing/adding-features.md` — Step-by-step guides for adding an AST node, a CLI command, a type, and similar.
- `docs/dev/contributing/formatting.md` — Prettier for hand-written TypeScript, and the CI check that fails on unformatted files.

Other process docs:

- `docs/dev/contributing/general-writing-tips.md` — How to write prose in this repo. Follow it for docs, comments, and messages to the user.
- `docs/dev/contributing/verbal-tics.md` — Phrases to cut from every piece of prose before showing it to anyone. Read it after drafting, before sending.
- `docs/dev/contributing/supply-chain.md` — The dependency hardening that guards against a malicious npm release.
- `docs/dev/contributing/updating-pinned-actions.md` — Refreshing the pinned GitHub Action SHAs that generated workflows use.
- `docs/dev/contributing/untestable-builtins.md` — Stdlib functions CI cannot test, and the cases we want once they can be mocked.
- `docs/dev/contributing/message-thread-tests.md` — An index of message-thread test cases and which file covers each one.

### Language semantics and syntax features

- `docs/dev/language/agency-function.md` — The wrapper codegen emits around every Agency `def`. Covers tool metadata, argument resolution, and block arguments.
- `docs/dev/language/closures-and-lambdas.md` — Why Agency has blocks and first-class functions but no lambdas, and what makes adding them hard.
- `docs/dev/language/effect-patterns.md` — Naming an interrupt effect in a `match` arm and destructuring its payload, how it lowers, and its limits.
- `docs/dev/language/lambda-sketch.md` — A design sketch for lambdas. Nothing here is implemented.
- `docs/dev/language/match-expression-positions.md` — Where a `match` may appear as a value, and why each such position has to be wired up by hand.
- `docs/dev/language/null-and-undefined.md` — Why Agency has exactly one nothing-value, `null`, and treats `undefined` as another spelling of it.
- `docs/dev/language/parallel-blocks-v2-dataflow.md` — A spec for grouping parallel statements automatically by dataflow. Not implemented.
- `docs/dev/language/parallel-blocks.md` — The shipped design for `parallel` and `seq` blocks: what they lower to and what they refuse.
- `docs/dev/language/pkg-imports.md` — Importing Agency code from npm packages with the `pkg::` prefix.
- `docs/dev/language/splices.md` — Compile-time splices `$( ... )`, which run a generator during compilation and paste the code it returns into the file.
- `docs/dev/language/template-agency.md` — How templates work under the hood: holes, `fill`, and hygiene.
- `docs/dev/language/triple-quoted-string-escapes.md` — The two escapes a raw `"""` string honours, `\${` and `\"""`, and the three places (parser, generator, optimizer) that must agree on them.
- `docs/dev/language/validation-annotations.md` — How `@validate` and `@jsonSchema` are compiled, and how the runtime walks a validated value.
- `docs/dev/language/with-approve.md` — The `with approve/reject/propagate` shorthand for wrapping a single statement in a handler.

### Runtime

- `docs/dev/runtime/async-behavior-checklist.md` — The case-by-case behavioral checklist the async implementation was built against.
- `docs/dev/runtime/async-context.md` — The async-context frame that carries runtime state, and how stdlib TypeScript helpers read it.
- `docs/dev/runtime/async.md` — How async function calls work, and the problems the design solves.
- `docs/dev/runtime/callback-hooks.md` — Registering callbacks for runtime events such as node, function, and tool lifecycle.
- `docs/dev/runtime/checkpointing.md` — Snapshotting execution state so a program can restore back to it later.
- `docs/dev/runtime/concurrent-interrupts.md` — What happens when several concurrent execution paths interrupt at the same time.
- `docs/dev/runtime/config.md` — Every `AgencyConfig` option, with types and defaults, and how config is resolved.
- `docs/dev/runtime/globalstore.md` — Module-namespaced storage for top-level variables at runtime.
- `docs/dev/runtime/interrupts.md` — How a program resumes in the middle of a block after an interrupt, using step counters.
- `docs/dev/runtime/lock.md` — A per-run mutex for serializing access to shared resources such as the terminal prompt.
- `docs/dev/runtime/rewind.md` — Replaying execution from a checkpoint, optionally with different values for its local variables.
- `docs/dev/runtime/runBatch.md` — The one primitive that owns concurrent-interrupt orchestration for forks, parallel blocks, tool calls, and subprocesses.
- `docs/dev/runtime/saveDraft.md` — How a scope's best-so-far value survives a guard trip instead of being lost.
- `docs/dev/runtime/simplemachine.md` — The graph execution engine that runs compiled Agency programs.
- `docs/dev/runtime/subprocess-ipc.md` — How an agent compiles and runs Agency code in a subprocess, and how the parent's handler chain extends across that boundary.
- `docs/dev/runtime/threads.md` — How LLM conversation history accumulates and flows through thread and subthread blocks.
- `docs/dev/runtime/trace.md` — Execution traces: a checkpoint per step, written to a file the debugger can replay.

### Compiler and type checker

- `docs/dev/compiler/agency-only-bound-names.md` — The `--agency-only` JS-globals bind-check: the sandbox allowlist, the four capability positions it refuses, and why it is defense in depth rather than the boundary.
- `docs/dev/compiler/binop-parser.md` — How binary expressions parse, including the operator precedence and associativity table.
- `docs/dev/compiler/codegen-als-accessors.md` — How generated code reads runtime values out of the active async-context frame.
- `docs/dev/compiler/effect-propagation.md` — How the interrupt effects a function carries are computed and propagated through calls.
- `docs/dev/compiler/hoist-calls.md` — Why helper calls are hoisted into their own statements, so resuming never re-runs a call that already finished.
- `docs/dev/compiler/incremental-builds.md` — The build manifest that lets the compiler skip files whose inputs have not changed.
- `docs/dev/compiler/init-topsort.md` — The dependency graph and ordering that decide which module's top-level code runs first.
- `docs/dev/compiler/init.md` — Design history for running a file's top-level code before any node executes.
- `docs/dev/compiler/interrupts-command.md` — `agency interrupts`, which statically prints which handlers could enclose each interrupt.
- `docs/dev/compiler/locations.md` — How source positions flow through the parser, and what to check when a reported location is wrong.
- `docs/dev/compiler/rewriting-imports.md` — How imports in generated output are rewritten, and why compile mode and run mode differ.
- `docs/dev/compiler/trailing-comments.md` — How `agency fmt` keeps an end-of-line `//` comment where the author wrote it.
- `docs/dev/compiler/ts-ir-readability-backlog.md` — A backlog of pain points in the TypeScript builder. Nothing here is actioned yet.
- `docs/dev/compiler/typechecker/README.md` — How bidirectional type checking works: the phases, the scopes, and the diagnostic registry.
- `docs/dev/compiler/typechecker/definite-returns-remaining-work.md` — What shipped for definite-return checking and which parts are still open.
- `docs/dev/compiler/typechecker/narrowing/README.md` — Flow-sensitive narrowing and exhaustiveness checking.
- `docs/dev/compiler/typescript-ir.md` — The `TsNode` tree that generated TypeScript is built from, instead of concatenating strings.
- `docs/dev/compiler/undefined-function-diagnostic.md` — The diagnostic for calling a function that does not exist, and how real JS interop avoids false positives.

### Agents (`agency agent`, the stdlib agents)

- `docs/dev/agents/agent-brains.md` — How `agency agent` splits into a harness and pluggable brains, and what each half owns.
- `docs/dev/agents/agent-sessions.md` — Save and resume for `agency agent`: a checkpoint between turns, why it is taken from TypeScript after the turn's frames return, where the restore runs, and what a restore does not bring back.
- `docs/dev/agents/approval-policies.md` — How approval policy rules match, and the matching rules that have caused surprises.
- `docs/dev/agents/promptRunner.md` — The small control-flow helper behind `runPrompt`.
- `docs/dev/agents/reply-attachments.md` — How a tool hands images back to the model, given that most providers reject image parts in tool results.
- `docs/dev/agents/self-writing-agent.md` — Investigation notes from the experiment behind that argument.
- `docs/dev/agents/tool-loop-guards.md` — The two refusals that stop a model wasting rounds: a repeated call, and an argument that is really tool-call markup.
- `docs/dev/agents/why-agents-write-code.md` — The argument for letting an agent write and run programs instead of giving it more tools.
- `docs/dev/agents/writing-rewrite-agent.md` — The rewrite agent over the writing reviewer: the passes loop, why a reviewer failure is not a clean pass, and how its eval suite shares the reviewer suite's files.

### Security

- `docs/dev/security/goal.md` — The goal of running untrusted Agency code with no operating-system sandbox, why the language design makes that possible, and what it demands of the compiler.
- `docs/dev/security/roadmap.md` — Every gap between today's code and that goal, grouped by which part of the argument it breaks, with the GitHub issue for each.

### Standard library

- `docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md` — The pattern for adding a stdlib module, including where files go and how docs are generated.
- `docs/dev/stdlib/aws.md` — S3 support with no AWS SDK, including the request signer and the safety contracts around it.
- `docs/dev/stdlib/data-connectors.md` — Writing a `std::data` connector that reads a public data source, and the conventions they all follow.
- `docs/dev/stdlib/std-agency-test.md` — `test()` and `testFile()` from `std::agency`, and the sandbox rules that are easy to get wrong.
- `docs/dev/stdlib/toolbox.md` — `std::toolbox`: tools an agent writes and keeps; the tool template, the writeTool pipeline, the review interrupt, and runTool.

### LLM plumbing

- `docs/dev/llm/llm-clients.md` — The `LLMClient` interface, for swapping smoltalk out for something else.
- `docs/dev/llm/local-model-integration.md` — The integration suite that downloads and runs a real local model.
- `docs/dev/llm/local-models.md` — How local-model support is wired, from the provider to model download and verification.
- `docs/dev/llm/smoltalk.md` — The external library Agency routes every LLM call through.
- `docs/dev/llm/speech-via-smoltalk.md` — Speech-to-text and text-to-speech, routed through the LLM client so they inherit cost accounting and tracing.

### CLI and terminal UI

- `docs/dev/cli/cli-arguments.md` — How one command line carries both agency's own flags and the program's.
- `docs/dev/cli/debugger-future-work.md` — The few debugger and TUI items still open.
- `docs/dev/cli/debugger-tests.md` — Driving the debugger headlessly in tests.
- `docs/dev/cli/debugger.md` — The interactive debugger: stepping, inspecting variables, and rewinding.
- `docs/dev/cli/doc-cache.md` — The incremental cache behind `agency doc`, and how it decides a page is stale.
- `docs/dev/cli/logs-viewer.md` — The interactive viewer for a single statelog trace, including the timeline.
- `docs/dev/cli/runs-explorer.md` — The cross-run table `agency logs` opens when pointed at several paths.
- `docs/dev/cli/test-cli-sandbox.md` — The flag combination that makes it safe to run Agency code you do not trust.
- `docs/dev/cli/tui.md` — The terminal UI toolkit the debugger, the viewer, and `std::ui` are built on.
- `docs/dev/cli/tui/dev/elements-and-builders.md` — The element tree and the builder functions that produce it.
- `docs/dev/cli/tui/dev/input-output.md` — The injected input and output interfaces that make the TUI testable.
- `docs/dev/cli/tui/dev/layout.md` — The flexbox-lite layout engine that assigns every element a position and size.
- `docs/dev/cli/tui/dev/rendering.md` — How a laid-out element tree becomes terminal output, HTML, or plain text.
- `docs/dev/cli/tui/dev/style-parser.md` — The inline `{bold}` style tag syntax, and the ANSI sequences the parser also understands.
- `docs/dev/cli/tui/guide/getting-started.md` — Writing a first TUI screen, and the builders available.
- `docs/dev/cli/tui/guide/terminal-usage.md` — Running a TUI against a real terminal: input, signals, and resizing.
- `docs/dev/cli/tui/guide/testing.md` — Testing a TUI with scripted input and recorded frames, no terminal needed.
- `docs/dev/cli/vendored-commander.md` — The vendored commander fork, what was changed in it, and the rules for keeping it in sync.

### Evals and optimizers

- `docs/dev/evals/agency-agent-suite.md` — The in-repo suite that reproduces terminal-bench failure patterns with our own Python tasks, run in Docker and checked by pytest files.
- `docs/dev/evals/eval-command-agents.md` — Running an arbitrary CLI as the eval agent instead of an `.agency` file.
- `docs/dev/evals/eval-grading.md` — Why running and grading are separate, joined only by the run directory.
- `docs/dev/evals/eval-labeling.md` — Answering a checklist about a group of runs by hand, and how those answers are recorded.
- `docs/dev/evals/eval-tracking.md` — Running a suite over several trials, then uploading the results to statelog for a trend.
- `docs/dev/evals/optimize-text-targets.md` — How a prompt travels between the source file and the mutator model, and why every `${...}` in a reply is an interpolation.
- `docs/dev/evals/run-directory.md` — The on-disk shape that observing, noting, labeling, grading, and optimizing all read and write.
- `docs/dev/evals/terminal-bench.md` — Benchmarking the coding agent against Terminal-Bench, and the results so far.
- `docs/dev/evals/writing-optimizers.md` — Adding a new `optimize` strategy alongside `greedy` and `gepa`.

### Hosting and statelog

- `docs/dev/hosting/hosted-agent-execution.md` — Deploying an agent to a hosted statelog instance and running it over HTTP.
- `docs/dev/hosting/how-hosted-serving-works.md` — The plain walkthrough of serving: deploy, compile, the four routes, and how an interrupt becomes an HTTP round trip. Read before `hosted-agent-execution.md`.
- `docs/dev/hosting/invocation-usage-accounting.md` — How a hosted invocation reports its full cost and token breakdown, including across a subprocess.
- `docs/dev/hosting/per-invocation-config.md` — Letting one invocation carry its own config override and trace id.
- `docs/dev/hosting/remote-secrets.md` — Managing a hosted project's secrets against a write-only store, and the rules that keep values out of argv and output.
- `docs/dev/hosting/schedule-remote-backend.md` — Managing schedules that live on a hosted statelog server rather than locally.
- `docs/dev/hosting/statelog-clients.md` — The sealed per-route clients the CLI uses to talk to statelog, over one shared transport.
- `docs/dev/hosting/statelog.md` — The observability system: what events are captured and where they are sent.

The same index is split into nine skills (`agency-language-docs`, `agency-compiler-docs`, `agency-runtime-docs`, `agency-agent-docs`, `agency-llm-docs`, `agency-evals-docs`, `agency-cli-docs`, `agency-stdlib-docs`, `agency-hosting-docs`); keep both in step when adding a doc.

Other references:

- `docs/misc/TESTING.md` — Full testing guide (unit tests, fixtures, execution tests, agency-js tests)
- `docs/misc/config.md` — `agency.json` configuration file
- `docs/misc/lifecycleHooks.md` — Lifecycle hooks and callbacks
- `docs/misc/stateStack.md` — State stack serialization/deserialization for interrupts
- `docs/misc/typeChecker.md` — Type checker usage
- `docs/misc/envFiles.md` — Environment variables and .env files
