# Slash Commands v2 — TDD-First, Minimal Implementation

## Why a fresh PR

PR #266 over-engineered this. It built a parallel architecture (new types, dispatch closures, hand-rolled tokenizer, full CC arg-grammar) when the actual requirement is: **read a markdown file from a directory, substitute `$ARGUMENTS`, send the result as a user message.** The right code is a thin wrapper on the existing `skillsDir` pattern.

This plan throws away PR #266 and builds the 55-line version against a test suite that probes the contract, not the happy path.

## Working branch + worktree

- **Throw away** branch `slash-commands` after this PR merges (or close PR #266 without merging).
- **New branch**: `slash-commands-v2` off latest `main`.
- **Worktree**: `~/agency-lang/.worktrees/slash-commands-v2`. Use the `using-git-worktrees` skill to set it up.
- Do **not** copy code from PR #266. Re-read this plan and `stdlib/skills.agency`'s existing `skillsDir`, then write fresh.

## Scope

**In v1:**
- Read `.md` files under a project-local `.claude/commands/` directory.
- Substitute `$ARGUMENTS` (the only placeholder).
- Inject the rendered body as a user message into the current agent thread.
- Surface command names + descriptions in the `/` palette.
- Built-in commands (`/exit`, `/clear`, `/help`) take precedence.

**Explicitly out of v1** (and stay out unless someone asks):
- `$N` / `$ARGUMENTS[N]` positional refs — defer until a real user wants them
- Namespaced commands (`/ns:scoped`)
- `.markdown` extension (just `.md`)
- `!`cmd`` shell injection
- `@<path>` file references
- `allowed-tools` / `model` / `effort` / any other frontmatter field besides `description` and `argument-hint`
- User-level (`~/.claude/commands/`) commands — start with project-only, add user-level if asked
- Live reload

The fewer surfaces, the fewer bugs. Every deferred feature is a follow-up PR if and only if a real workflow needs it.

## TDD: tests first

Write tests + fixtures before any production code. Run the suite — it should fail to compile (the module under test doesn't exist) or fail loudly (function not found). That's the green light to start implementing.

### File layout

```
tests/agency/commands-dir-fixture/
  simple.md
  with-args.md
  no-frontmatter.md
  empty-frontmatter.md
  description-only.md
tests/agency/commands-dir.agency
tests/agency/commands-dir.test.json
```

### Fixtures

Each fixture body is short enough to assert via `==`. Watch for trailing newlines — `read()` preserves them. Decide one rule and stick to it: **the implementation strips a single trailing `\n` from `body` at load time**, so test assertions never need to think about it.

**`simple.md`** (no args, plain body):
```
---
description: A simple command with no args
---
Just say hello.
```
Expected loaded `body`: `"Just say hello."` (no trailing newline).

**`with-args.md`** (substitutes `$ARGUMENTS`):
```
---
description: Greet someone
argument-hint: [name]
---
Greet $ARGUMENTS politely.
```
Expected for `/with-args alice`: `"Greet alice politely."`
Expected for `/with-args`: `"Greet  politely."` (empty rawArgs → bare spaces left; this is fine, matches what users would get if they used the placeholder with no arg).

**`no-frontmatter.md`** (whole file is body):
```
This file has no frontmatter at all.
```
Expected loaded `body`: `"This file has no frontmatter at all."`
Expected `description`: `""`, `argHint`: `""`.

**`empty-frontmatter.md`** (frontmatter present but no recognized fields — common in real CC files with only `allowed-tools`):
```
---
allowed-tools: Read
---
A command that ignores its frontmatter.
```
Expected `description`: `""`, `argHint`: `""`. Both are strings, neither is `undefined`.

**`description-only.md`** (verify `argHint` defaults when only `description` is set):
```
---
description: No argument hint here
---
Some body.
```
Expected `description`: `"No argument hint here"`, `argHint`: `""`.

### Test nodes (`tests/agency/commands-dir.agency`)

Every assertion uses `==` (exact match), not `.includes(...)`. Every node returns a boolean.

```agency
import { commandsDir, expandSlash } from "std::skills"

def loadFixture() {
  return commandsDir("commands-dir-fixture") with approve
}

// ---------- discovery ----------

node entriesCount(): number {
  return loadFixture().length
}
// Expected: 5

node simpleHasDescription(): boolean {
  for (cmd in loadFixture()) {
    if (cmd.name == "simple") {
      return cmd.description == "A simple command with no args"
    }
  }
  return false
}

node simpleHasEmptyArgHint(): boolean {
  for (cmd in loadFixture()) {
    if (cmd.name == "simple") {
      return cmd.argHint == ""
    }
  }
  return false
}

node emptyFrontmatterHasEmptyDefaults(): boolean {
  for (cmd in loadFixture()) {
    if (cmd.name == "empty-frontmatter") {
      // Critical: must be the EMPTY STRING, never null/undefined.
      // If undefined leaks through, "${cmd.description}" would render
      // "undefined" and palette would show "undefined undefined".
      return cmd.description == "" && cmd.argHint == ""
    }
  }
  return false
}

node noFrontmatterHasEmptyDefaults(): boolean {
  for (cmd in loadFixture()) {
    if (cmd.name == "no-frontmatter") {
      return cmd.description == "" && cmd.argHint == ""
    }
  }
  return false
}

node descriptionOnlyHasEmptyArgHint(): boolean {
  for (cmd in loadFixture()) {
    if (cmd.name == "description-only") {
      return cmd.description == "No argument hint here" && cmd.argHint == ""
    }
  }
  return false
}

node missingDirReturnsEmpty(): boolean {
  const cmds = commandsDir("commands-dir-fixture-does-not-exist") with approve
  return cmds.length == 0
}

// ---------- expansion ----------
// `expandSlash(msg, commands)` returns the rendered body if `msg` is
// a `/name ...` invocation matching one of `commands`. Otherwise
// returns `msg` unchanged.

node simpleExpandsToBody(): boolean {
  const out = expandSlash("/simple", loadFixture())
  return out == "Just say hello."
}

node withArgsSubstitutes(): boolean {
  const out = expandSlash("/with-args alice", loadFixture())
  return out == "Greet alice politely."
}

node withArgsMultiArgRawString(): boolean {
  // $ARGUMENTS gets the whole raw string verbatim, including any quoting.
  const out = expandSlash(`/with-args "alice the great" bob`, loadFixture())
  return out == `Greet "alice the great" bob politely.`
}

node noArgsCommandIgnoresExtraText(): boolean {
  // /simple has no $ARGUMENTS placeholder. Passing args should NOT
  // mangle the body; CC behavior is to append `\n\nARGUMENTS: <raw>`
  // so the LLM can still see the args.
  const out = expandSlash("/simple extra stuff", loadFixture())
  return out == "Just say hello.\n\nARGUMENTS: extra stuff"
}

node noArgsCommandNoSuffixIfNoArgs(): boolean {
  // /simple invoked with no args → body unchanged, no suffix.
  const out = expandSlash("/simple", loadFixture())
  return out == "Just say hello."
}

node unknownCommandReturnsLiteral(): boolean {
  // Unknown /foo → pass through to the LLM verbatim. CC does the same.
  const out = expandSlash("/does-not-exist arg", loadFixture())
  return out == "/does-not-exist arg"
}

node nonSlashReturnsLiteral(): boolean {
  const out = expandSlash("hello world", loadFixture())
  return out == "hello world"
}

node emptyInputReturnsLiteral(): boolean {
  const out = expandSlash("", loadFixture())
  return out == ""
}

// ---------- whitespace tolerance ----------

node trailingNewlineDispatches(): boolean {
  // Piped stdin (`echo /simple | agency agent`) yields "/simple\n".
  // Must still match.
  const out = expandSlash("/simple\n", loadFixture())
  return out == "Just say hello."
}

node leadingWhitespaceDispatches(): boolean {
  const out = expandSlash("  /simple", loadFixture())
  return out == "Just say hello."
}

node trailingWhitespaceDispatches(): boolean {
  const out = expandSlash("/simple   ", loadFixture())
  return out == "Just say hello."
}

node tabDelimitsArgs(): boolean {
  // Tab between command and arg should work the same as space.
  const out = expandSlash("/with-args\talice", loadFixture())
  return out == "Greet alice politely."
}

// ---------- defensive contract ----------

node descriptionsAreStringsNotUndefined(): boolean {
  // Every entry's description and argHint MUST be a string. This is
  // the contract that prevents the "undefined undefined" palette bug.
  for (cmd in loadFixture()) {
    if (cmd.description == null) { return false }
    if (cmd.argHint == null) { return false }
  }
  return true
}
```

### Test runner JSON (`commands-dir.test.json`)

One entry per node above. All `expectedOutput` are `"true"` except `entriesCount` which is `"5"`.

### What these tests catch

| Test | Bug it catches |
|------|----------------|
| `entriesCount` | regression in discovery |
| `simpleHasDescription` / `simpleHasEmptyArgHint` | frontmatter not parsed |
| `emptyFrontmatterHasEmptyDefaults` | **undefined leaks into palette (E2)** |
| `noFrontmatterHasEmptyDefaults` | crash on missing frontmatter |
| `descriptionOnlyHasEmptyArgHint` | argHint default broken |
| `missingDirReturnsEmpty` | crash on missing dir |
| `simpleExpandsToBody` | trailing-newline handling broken |
| `withArgsSubstitutes` | `$ARGUMENTS` substitution broken |
| `withArgsMultiArgRawString` | raw-string preservation broken |
| `noArgsCommandIgnoresExtraText` | CC-compatible suffix fallback broken |
| `noArgsCommandNoSuffixIfNoArgs` | suffix appended when it shouldn't be |
| `unknownCommandReturnsLiteral` | unknown command swallowed |
| `nonSlashReturnsLiteral` / `emptyInputReturnsLiteral` | non-command input mangled |
| `trailingNewlineDispatches` | **piped stdin broken (C3)** |
| `leadingWhitespaceDispatches` / `trailingWhitespaceDispatches` | whitespace intolerance |
| `tabDelimitsArgs` | tab not accepted as delimiter |
| `descriptionsAreStringsNotUndefined` | **undefined contract violation (E2)** |

### What's deliberately NOT tested

- `$N` / `$ARGUMENTS[N]` — not implemented
- Namespaced commands — not implemented
- `.markdown` extension — not implemented
- Shell injection / file refs — not implemented
- Anything in `agent.agency` — covered by manual smoke test only (one-time integration check, not an ongoing test)

If a deferred feature lands later, its tests come with it.

## Implementation plan

After all tests are red, implement against them.

### Step 1 — `commandsDir` in `stdlib/skills.agency`

Add **one** exported function and **one** exported expander. Mimic the shape of `skillsDir`. No new types.

```agency
/**
 * Discover slash commands under `dir`. Each `.md` file becomes one
 * command. Returns an array of `{ name, description, argHint, body }`
 * records. Files with no frontmatter still dispatch — `description`
 * and `argHint` default to "".
 *
 * Use with `expandSlash(msg, commandsDir(dir))` in your agent's
 * per-turn handler to expand `/myCommand args` into the rendered
 * body before passing it to the LLM.
 *
 * Defers to Claude Code's `.claude/commands/` format. Only the
 * `description` and `argument-hint` frontmatter fields are read;
 * `allowed-tools`, `model`, etc. are ignored — `commandsDir` is a
 * pure prompt-template loader, not an executor.
 *
 * @param dir - Directory containing .md command files (absolute path
 *   recommended; relative paths resolve against the calling module's
 *   directory, which is rarely what you want for project-level
 *   commands).
 */
export def commandsDir(dir: string): any[] {
  """
  Discover .md files under `dir` and parse each as a slash-command
  template. Returns [] if `dir` is missing or empty.

  @param dir - Directory containing command markdown files.
  """
  const pathsResult = glob("*.md", dir)
  if (!(pathsResult is success(paths))) {
    return []
  }
  return map(paths) as p {
    const raw = read(p, dir) catch ""
    const fm = frontmatter(raw) catch null
    return {
      name: p.replace(".md", ""),
      description: (fm != null && fm.description != null) ? "${fm.description}" : "",
      argHint: (fm != null && fm["argument-hint"] != null) ? "${fm["argument-hint"]}" : "",
      body: stripFm(raw)
    }
  }
}
```

`stripFm(raw)` is a private helper, **3 lines max**:

```agency
def stripFm(raw: string): string {
  // No frontmatter → whole file (less one trailing \n).
  if (!raw.startsWith("---\n")) {
    return raw.endsWith("\n") ? raw.slice(0, raw.length - 1) : raw
  }
  // Frontmatter present → everything after the closing `---\n`.
  const idx = raw.indexOf("\n---\n", 4)
  if (idx == -1) { return "" }
  let body = raw.slice(idx + 5)
  if (body.startsWith("\n")) { body = body.slice(1) }
  if (body.endsWith("\n")) { body = body.slice(0, body.length - 1) }
  return body
}
```

That's it. No `splitFrontmatter`, no `loadCommand`, no `Command` type. Just a function returning an array of records.

### Step 2 — `expandSlash` in `stdlib/skills.agency`

```agency
/**
 * Expand a user-typed slash command against a `commandsDir` result.
 * Returns the rendered command body when `msg` matches `/<name>`
 * (with optional whitespace + args). Returns `msg` verbatim
 * otherwise — unknown commands fall through to the LLM as plain text.
 *
 * Substitutes the literal `$ARGUMENTS` token in the body with the
 * raw arg string (quotes preserved). If the body has no `$ARGUMENTS`
 * token and args were passed, appends `\n\nARGUMENTS: <raw>` so the
 * LLM still sees the input. Matches Claude Code.
 *
 * @param msg - The raw input line (e.g. "/foo bar baz\n").
 * @param commands - Result of `commandsDir(...)`.
 */
export def expandSlash(msg: string, commands: any[]): string {
  const trimmed = msg.trim()
  if (!trimmed.startsWith("/")) { return msg }
  // Split on first run of whitespace.
  let nameEnd = trimmed.length
  let i = 1
  while (i < trimmed.length) {
    const c = trimmed[i]
    if (c == " " || c == "\t" || c == "\n") {
      nameEnd = i
      break
    }
    i = i + 1
  }
  const name = trimmed.slice(1, nameEnd)
  const rawArgs = nameEnd == trimmed.length ? "" : trimmed.slice(nameEnd + 1).trim()
  for (cmd in commands) {
    if (cmd.name == name) {
      let out = cmd.body.replaceAll("$ARGUMENTS", rawArgs)
      if (!cmd.body.includes("$ARGUMENTS") && rawArgs != "") {
        out = out + "\n\nARGUMENTS: ${rawArgs}"
      }
      return out
    }
  }
  return msg
}
```

That's the whole substitution logic. `$ARGUMENTS` → rawArgs via `replaceAll`. No tokenizer. No `$N`. No `$ARGUMENTS[N]`. ~20 lines including comments.

### Step 3 — wire into `lib/agents/agency-agent/agent.agency`

Minimal changes:

```agency
import { commandsDir, expandSlash } from "std::skills"
import { cwd, env, isTTY, readStdin } from "std::system"

// ... existing code ...

// Load commands from the project's .claude/commands/ directory.
// Absolute path via cwd() because Agency resolves relative dirs
// against the agent's source directory, not the user's project.
static const projectCommands = commandsDir("${cwd()}/.claude/commands") with approve

def builtinPalette(): Record<string, string> {
  return {
    "/exit":  "Exit the agent",
    "/clear": "Clear the conversation transcript",
    "/help":  "Show available slash commands"
  }
}

def mergedPalette(): Record<string, string> {
  let out: Record<string, string> = {}
  for (cmd in projectCommands) {
    const label = cmd.argHint == "" ? cmd.description : "${cmd.description} ${cmd.argHint}"
    out["/${cmd.name}"] = label
  }
  const builtins = builtinPalette()
  for (key in builtins) {
    out[key] = builtins[key]
  }
  return out
}

def _runTurn(msg: string): boolean {
  // built-ins win
  if (msg == "/exit" || msg == "/quit") { return false }
  if (msg == "/clear") { clearMessages(); return true }
  if (msg == "/help")  { pushMessage("Commands: /exit, /clear, /help"); return true }

  const prompt = expandSlash(msg, projectCommands)
  // ... existing route() call using `prompt` instead of `msg` ...
}
```

And in the one-shot `main()` branch, before the `route()` call:
```agency
const onePrompt = expandSlash(piped, projectCommands)
// ... use onePrompt instead of piped ...
```

Update `repl(...)` to use `paletteCommands: mergedPalette()`.

That's the entire agent wiring. ~25 lines added.

### Step 4 — `cwd()` at module-init check

`static const` runs at load time. Verify `cwd()` is callable that early. If it isn't:

- Move `projectCommands` into `main()` as a `let projectCommands` declared before the REPL/one-shot branches.
- Pass it explicitly to `_runTurn` (or capture via a module-level mutable, ugly but works).
- Update `mergedPalette` to take `projectCommands` as a parameter.

If `cwd()` works at static-const time, keep the cleaner shape.

### Step 5 — manual smoke test

```bash
mkdir -p /tmp/cmd-smoke/.claude/commands
cat > /tmp/cmd-smoke/.claude/commands/echo.md <<'EOF'
---
description: Echo back the args
---
Please repeat this verbatim: $ARGUMENTS
EOF
cd /tmp/cmd-smoke
pnpm --prefix ~/agency-lang/.worktrees/slash-commands-v2/packages/agency-lang run agent -p '/echo hello'
```

Confirm the LLM receives `Please repeat this verbatim: hello`, not `/echo hello`.

## What to do — checklist

- [ ] Set up `~/agency-lang/.worktrees/slash-commands-v2` worktree off `main`
- [ ] Write all fixtures listed under "Fixtures"
- [ ] Write `tests/agency/commands-dir.agency` with all nodes listed under "Test nodes"
- [ ] Write `tests/agency/commands-dir.test.json` mapping every node
- [ ] Run `pnpm run agency test tests/agency/commands-dir.agency > /tmp/red.txt 2>&1` — confirm all tests fail (function doesn't exist)
- [ ] Implement `stripFm`, `commandsDir`, `expandSlash` in `stdlib/skills.agency`
- [ ] Run tests, save output. Iterate until **every** test green
- [ ] Run `pnpm run agency test tests/agency/skills-dir.agency` — confirm no regression
- [ ] Wire `commandsDir` + `expandSlash` into `lib/agents/agency-agent/agent.agency` per Step 3
- [ ] `make` — clean build
- [ ] Manual smoke test per Step 5
- [ ] Commit. **Stop and ask the user** before pushing.

## What NOT to do

- **Don't** create a `Command` type or `CommandSet` type. The record is structural. Agency's `any[]` is fine here.
- **Don't** write a tokenizer. There is no `$N`, no `$ARGUMENTS[N]`, no quoted-arg tokenization. Just `replaceAll("$ARGUMENTS", rawArgs)`.
- **Don't** create a `dispatch` closure on a record. Use `expandSlash(msg, commands)` as a free function.
- **Don't** add `.partial(...)` gymnastics to make a closure work. Free functions need no partial application.
- **Don't** write a custom frontmatter parser. Use `std::markdown.frontmatter`.
- **Don't** support `.markdown` until someone asks. Only `.md`.
- **Don't** support namespaced commands (`/ns:scoped`) until someone asks.
- **Don't** support user-level (`~/.claude/commands`) commands until someone asks. Project-only for v1.
- **Don't** support `!`cmd`` shell injection. Not in v1, not as a stub.
- **Don't** support `@<path>` file references.
- **Don't** support `allowed-tools` / `model` / `effort` / any frontmatter field besides `description` / `argument-hint`.
- **Don't** add live-reload of files.
- **Don't** parse frontmatter beyond what's needed for `description` and `argument-hint`.
- **Don't** define helper functions you only call once. Inline them.
- **Don't** define helper types. Records are structural.
- **Don't** assert with `.includes(...)` in tests. Always `==`.
- **Don't** add tests for behavior you didn't implement. The deferred features get their tests with their PRs.
- **Don't** spend more than 30 minutes implementing the production code. If it's taking longer, you're over-engineering — re-read this plan.
- **Don't** commit before all tests green.
- **Don't** push without explicit user approval.

## Expected line counts

| File | Lines added |
|------|-------------|
| `stdlib/skills.agency` | ~50 (commandsDir 15, expandSlash 25, stripFm 10) |
| `lib/agents/agency-agent/agent.agency` | ~25 (static const + mergedPalette + 3 lines in _runTurn + 2 in main) |
| `tests/agency/commands-dir.agency` | ~120 (19 nodes) |
| `tests/agency/commands-dir.test.json` | ~25 |
| `tests/agency/commands-dir-fixture/*.md` | ~25 (5 small fixtures) |
| **Total production code** | **~75 lines** |
| **Total test code** | **~170 lines** |

PR #266 was ~580 lines production + tests. If v2 grows past ~250 lines total, stop and figure out what's being over-built.

## Commit + PR

One commit, one PR, clean diff. Suggested message (write to `/tmp/commit.txt`, never inline on the CLI per AGENTS.md):

```
Add slash commands to the agency agent (v2)

`commandsDir(dir)` discovers `.md` files in a directory and returns
records with `name`, `description`, `argHint`, `body`.

`expandSlash(msg, commands)` substitutes `$ARGUMENTS` in the matched
command's body. Unknown `/foo` inputs pass through to the LLM
unchanged, matching Claude Code.

Wired into the agency agent's REPL and one-shot paths. Project-local
`.claude/commands/foo.md` becomes `/foo` in the agent. Built-ins
(`/exit`, `/clear`, `/help`) win over file commands.

v1 is intentionally a pure prompt-template loader: no shell
injection, no `$N` positional refs, no namespaced commands, no
`allowed-tools` pre-approval. Each of those is a follow-up PR if
someone needs them.

19 execution tests, all assertions exact-equality. Replaces PR #266
(closed unmerged) with a minimal implementation.
```

PR description should list every deferred feature explicitly, so reviewers see what's left out and don't ask about it.

## Risk register

- **`cwd()` at module init may not work.** Mitigation: Step 4. If it fails, fall back to per-`main()` init.
- **`raw.startsWith("---\n")` may miss CRLF line endings** if a Windows-edited file is dropped in. Mitigation: optional — strip `\r` from `raw` before any parsing. Add only if a test breaks.
- **Empty `$ARGUMENTS` substitution leaves double spaces** like `"Greet  politely."`. Mitigation: this is acceptable v1 behavior — matches what CC produces — but document it in the docstring.
- **`replaceAll("$ARGUMENTS", rawArgs)` substitutes literal `$ARGUMENTS` anywhere in the body**, including inside code blocks. This is consistent with CC and is the contract. Don't try to be clever about escaping.

## When you're tempted to add abstraction

Re-read this plan section. Every helper / type / wrapper you're about to add: is there a test that would fail without it? If not, don't add it.
