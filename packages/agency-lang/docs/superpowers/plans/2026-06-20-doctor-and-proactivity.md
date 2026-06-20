# Doctor Command + Agent Proactivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agency doctor <file>` command that launches the agency agent to diagnose a problem file, built on two new *generic* agent flags (`--interactive` and `--agent`), and make the agent more proactive (read files itself instead of asking the user to paste them).

**Architecture:** The agent gains two reusable CLI flags: `--interactive`/`-i` (run a given prompt as the first turn of an interactive REPL session, then hand the REPL to the user) and `--agent <name>` (route the starting prompt's first turn directly to a named subagent). `agency doctor` is a thin CLI wrapper that builds a diagnosis prompt and invokes the bundled agent with `--interactive --agent code -- <prompt>`. No separate "doctor" subagent — the existing code subagent already owns every diagnostic tool. A "Syntax gotchas" section is added to the bundled troubleshooting docs and the doctor prompt points the agent at it. A "Be proactive" section is added to the code + main agent system prompts.

**Tech Stack:** TypeScript CLI (commander) in `lib/cli/` + `scripts/agency.ts`; Agency code in `lib/agents/agency-agent/`; Markdown docs in `docs/site/guide/`. Bundled agent rebuilt with `make agents`.

## Global Constraints

- Agency syntax rules (verbatim from CLAUDE.md): `def foo(): T { ... }`, `node main() { ... }`, `if (cond) { ... }`, `for (x in xs) { ... }`, `let`/`const` before use, braces not Python colons. Verify snippets against `docs/site/guide/basic-syntax.md`.
- NEVER use dynamic imports. Use objects over maps, arrays over sets, types over interfaces.
- After editing any `.agency` file under `lib/agents/` or `stdlib/`, you MUST run `make agents` (compiled `agent.js` etc. are gitignored and regenerated). Editing `docs/site/guide/*` also requires `make agents` (or the doc-copy step) so the bundled copy under `dist/lib/agents/docs/` is refreshed.
- Do NOT run the full agency test suite. Testing of this feature is intentionally deferred (owner decision).
- Commit messages / PR bodies go in a file, not inline on the command line (apostrophe issue). End commit messages with the Co-Authored-By trailer.
- Work on a feature branch, never directly on `main`.

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main**

```bash
git checkout -b feat/doctor-command
```

- [ ] **Step 2: Confirm clean start**

Run: `git status`
Expected: on branch `feat/doctor-command`, no staged changes from this work yet.

---

### Task 1: Generic `--interactive` / `--agent` flags in the agent

Add the reusable flags and the seed-turn / subagent-dispatch machinery to the agent. This is the foundation `doctor` builds on.

**Files:**
- Modify: `lib/agents/agency-agent/agent.agency`

**Interfaces:**
- Produces:
  - `agentReplyVia(target: string, userMsg: string): string` — expand slash commands, then dispatch one turn to the named subagent (`"code"|"research"|"oracle"|"explorer"|"review"`) or the coordinator (any other value, including `""`/`"main"`).
  - `agentReply(userMsg: string): string` — unchanged public behavior; now delegates to `agentReplyVia("", userMsg)`.
  - `oneShotAgent(target: string, prompt: string): string` — one-shot run targeting `target`.
  - `START_AGENTS: string[]` — valid `--agent` values (`["main","code","research","oracle","explorer","review"]`).
- Consumes: existing imports already present in `agent.agency` (`codeAgent`, `researchAgent`, `oracleAgent`, `explorerAgent`, `reviewAgent`, `expandSlash`, `repl`, `pushMessage`, `highlight`, `setupSession`, `renderEditDiff`, `_runTurn`, `_buildStatus`, `mergedPalette`, `HISTORY_PATH`, `setTitle`, `clearScreen`, `printHeader`, `isTTY`, `readStdin`, `color`). All five subagents share the signature `(userMsg: string, allowHandoff: boolean)`.

- [ ] **Step 1: Add the valid-targets constant**

In `lib/agents/agency-agent/agent.agency`, add this near the other module-level constants (e.g. just above `let first = true` on line ~250):

```
// Valid `--agent` targets. Empty / "main" routes through the coordinator;
// the rest route the starting prompt's first turn directly to that
// subagent. Used to validate the flag and to dispatch in `agentReplyVia`.
static const START_AGENTS = ["main", "code", "research", "oracle", "explorer", "review"]
```

- [ ] **Step 2: Replace `agentReply` with `agentReplyVia` + thin `agentReply`**

Find the existing definition (lines ~438-440):

```
export def agentReply(userMsg: string): string {
  return mainAgent(expandSlash(userMsg, projectCommands))
}
```

Replace it with:

```
// Dispatch one turn. `target` empty (or "main") runs the coordinator
// `mainAgent`, which routes as usual; any subagent name routes the turn
// directly to that subagent. All subagents share `(userMsg, allowHandoff)`
// and the seed turn never hands off (allowHandoff: false). Used by both
// the one-shot path and the interactive seed turn.
export def agentReplyVia(target: string, userMsg: string): string {
  const expanded = expandSlash(userMsg, projectCommands)
  if (target == "code") {
    return codeAgent(expanded, false)
  }
  if (target == "research") {
    return researchAgent(expanded, false)
  }
  if (target == "oracle") {
    return oracleAgent(expanded, false)
  }
  if (target == "explorer") {
    return explorerAgent(expanded, false)
  }
  if (target == "review") {
    return reviewAgent(expanded, false)
  }
  return mainAgent(expanded)
}

// The agent's core turn, decoupled from the terminal. The REPL
// (`main` / `_runTurn`) owns input, output, and built-in commands;
// everything the *agent* does for a user message lives here, so it can be
// driven and tested without a terminal. See `tests/agentTurn.agency`.
export def agentReply(userMsg: string): string {
  return agentReplyVia("", userMsg)
}
```

(Delete the old block comment above the original `agentReply` if it duplicates the new one — keep a single explanatory comment.)

- [ ] **Step 3: Thread a target through `oneShotAgent`**

Find `oneShotAgent` (lines ~574-585):

```
def oneShotAgent(prompt: string): string {
  _isInteractive = false
  const handler = setupSession(false)
  let reply: string = ""
  handle {
    reply = agentReply(prompt)
  } with (data) {
    renderEditDiff(data)
    return handler(data)
  }
  return reply
}
```

Replace with:

```
def oneShotAgent(target: string, prompt: string): string {
  _isInteractive = false
  const handler = setupSession(false)
  let reply: string = ""
  handle {
    reply = agentReplyVia(target, prompt)
  } with (data) {
    renderEditDiff(data)
    return handler(data)
  }
  return reply
}
```

- [ ] **Step 4: Add the seed-turn helper and `startInteractive`**

Add these two defs immediately after `oneShotAgent` (before `node main()`):

```
// Render one seeded turn into the REPL scroll area: echo the auto-run
// prompt so the user sees what was asked, then push the agent's reply.
// Mirrors the reply-rendering half of `_runTurn`.
def _runSeedTurn(target: string, msg: string) {
  pushMessage(color.dim("> ${msg}"))
  const reply = agentReplyVia(target, msg)
  if (reply != "" && reply != null && reply != undefined) {
    pushMessage(highlight("${reply}\n", language: "markdown"))
  } else {
    pushMessage(color.red("No reply generated."))
  }
}

// Start the interactive REPL. When `seedPrompt` is non-empty it is run as
// the first turn (routed via `seedTarget`) *inside* the handle block so
// its interrupts reach the policy `handler`; the user is then left at the
// prompt. `seedPrompt == ""` is the plain REPL with no seed. Subsequent
// turns always go through `_runTurn` (the coordinator) regardless of
// `seedTarget` — the target only kicks off the first turn.
def startInteractive(handler: any, seedTarget: string, seedPrompt: string) {
  handle {
    if (seedPrompt != "") {
      _runSeedTurn(seedTarget, seedPrompt)
    }
    repl(
      status: _buildStatus,
      onSubmit: _runTurn,
      prompt: "> ",
      historyFile: HISTORY_PATH,
      historyMax: 1000,
      paletteCommands: mergedPalette(),
    )
  } with (data) {
    renderEditDiff(data)
    return handler(data)
  }
  print(color.cyan("\nGoodbye!"))
}
```

- [ ] **Step 5: Add the two flags to `parseArgs`**

In `node main()`, inside the `flags: { ... }` object passed to `parseArgs` (after the `provider` flag, ~line 624), add:

```
,
      interactive: {
        type: "boolean",
        short: "i",
        description: "Run the given prompt as the first turn of an interactive session, then hand over the REPL (instead of one-shot)"
      },
      agent: {
        type: "string",
        description: "Route the starting prompt to a named subagent: code, research, oracle, explorer, review (default: coordinator)"
      }
```

(Ensure the preceding `provider: { ... }` entry is comma-separated correctly — the snippet above leads with a comma to append after it.)

- [ ] **Step 6: Rewrite the mode-selection tail of `main()`**

Replace the block from `const positionalQuery = ...` through the end of `node main()` (lines ~653-702) with:

```
  const positionalQuery = args.positionals.join(" ")
  const hasQuery = positionalQuery != ""
  const startAgent = args.flags.agent ?? ""
  const wantInteractive = args.flags.interactive

  // Validate the target subagent name up front (empty = coordinator).
  if (startAgent != "" && !START_AGENTS.includes(startAgent)) {
    print(color.red("Unknown --agent value: ${startAgent}. Valid: ${START_AGENTS.join(", ")}"))
    process.exit(1)
  }

  // Seeded interactive: run the given prompt as the first turn, then hand
  // the REPL to the user. Requires a TTY (the REPL reads stdin); without
  // one we fall through to one-shot below.
  if (wantInteractive && hasQuery && isTTY()) {
    setTitle("Agency Agent")
    clearScreen()
    printHeader()
    const seededHandler = setupSession(true)
    startInteractive(seededHandler, startAgent, positionalQuery)
    process.exit(0)
  }

  // One-shot: print the reply and exit. Entered by --print/-p, a positional
  // query, --interactive without a TTY, or a non-TTY stdin pipe. The prompt
  // comes from the positional when present, otherwise from stdin.
  const forceOneShot = args.flags.print || hasQuery || wantInteractive
  if (forceOneShot || !isTTY()) {
    let prompt = positionalQuery
    if (!hasQuery) {
      const fromStdin = readStdin()
      if (fromStdin == null || fromStdin == "") {
        process.exit(0)
      }
      prompt = fromStdin
    }
    print(oneShotAgent(startAgent, prompt))
    process.exit(0)
  }

  // Plain interactive REPL (no seed).
  setTitle("Agency Agent")
  clearScreen()
  printHeader()
  const handler = setupSession(true)
  startInteractive(handler, "", "")
}
```

Notes for the implementer:
- This removes the old standalone `handle { repl(...) } with (...)` at the bottom of `main()`; `startInteractive` now owns it. Make sure the old block is fully deleted (no duplicate `repl(...)`).
- `args.flags.agent` is a string flag → may be `undefined`; `?? ""` normalizes (agency's `== null` does not match `undefined`, so use `??`, matching the existing `args.flags.model ?? ""` pattern).
- `args.flags.interactive` is boolean → safe to use directly in a condition.

- [ ] **Step 7: Build the agent and verify it compiles**

Run: `make agents 2>&1 | tee /tmp/make-agents-task1.log`
Expected: completes without a compile/type error referencing `agent.agency`. Inspect the log if it fails.

- [ ] **Step 8: Smoke-test one-shot still works (no LLM-dependent assertion)**

Run: `pnpm run agency compile lib/agents/agency-agent/ 2>&1 | tee /tmp/compile-agent-task1.log`
Expected: compiles cleanly. (A full interactive run needs an API key + TTY and is out of scope for automated verification here.)

- [ ] **Step 9: Commit**

```bash
git add lib/agents/agency-agent/agent.agency
git commit -F /tmp/commit-task1.txt
```

where `/tmp/commit-task1.txt` contains a message like:

```
Add generic --interactive and --agent flags to the agency agent

--interactive/-i runs the given prompt as the first turn of an
interactive REPL session (seed, then hand over the prompt). --agent
routes that starting prompt's first turn directly to a named subagent.
Refactor: agentReplyVia(target, msg) dispatch, oneShotAgent(target,
prompt), and a shared startInteractive() helper.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 2: `agency doctor` CLI command

A thin wrapper that builds the diagnosis prompt and launches the bundled agent with `--interactive --agent code -- <prompt>`.

**Files:**
- Create: `lib/cli/doctor.ts`
- Modify: `scripts/agency.ts`

**Interfaces:**
- Produces: `doctor(config: AgencyConfig, file: string, opts: { symptom?: string }): void`, `buildDoctorPrompt(file: string, symptom?: string): string`.
- Consumes: `runBundledAgent` from `./runBundledAgent.js` (same as `lib/cli/agent.ts`).

- [ ] **Step 1: Create `lib/cli/doctor.ts`**

```ts
import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";

// Build the diagnosis prompt the doctor seeds the agent with. Kept pure
// and exported so it can be unit-tested without launching the agent.
export function buildDoctorPrompt(file: string, symptom?: string): string {
  const symptomLine =
    symptom && symptom.trim() !== ""
      ? `They described the problem as: "${symptom}".`
      : "They did not describe the specific problem.";
  return [
    `The user is having trouble with the Agency file \`${file}\` and wants you to investigate.`,
    symptomLine,
    "",
    "Investigate the file and figure out what is wrong. Read the file first, " +
      "then use your diagnostic tools — `typecheck`, `parseAST`, and " +
      '`agencyCli(["ast", ...])` / `agencyCli(["typecheck", ...])` — to ' +
      "surface parse, syntax, and type errors.",
    "",
    "Agency has a number of parser and language gotchas that new users " +
      "frequently hit (for example, comments are not allowed inside object " +
      'literals). Before you conclude, read the bundled Troubleshooting ' +
      'guide\'s "Syntax gotchas" section (via `docSkill`) and check the file ' +
      "against those known gotchas.",
    "",
    "Report what you found and, if you can, how to fix it.",
  ].join("\n");
}

// `agency doctor <file> [--symptom <text>]` — launch the agency agent in
// interactive mode, seeded with a diagnosis prompt routed to the code
// subagent. A thin wrapper over the generic --interactive/--agent flags.
export function doctor(
  config: AgencyConfig,
  file: string,
  opts: { symptom?: string } = {},
): void {
  const prompt = buildDoctorPrompt(file, opts.symptom);
  // `--` ends flag parsing so the prompt (which may start with `-`) is
  // treated as a positional by the agent's std::args parser.
  runBundledAgent(config, "agency-agent", [
    "--interactive",
    "--agent",
    "code",
    "--",
    prompt,
  ]);
}
```

- [ ] **Step 2: Register the command in `scripts/agency.ts`**

Add the import near the other CLI imports (after `import { agent } from "@/cli/agent.js";`, ~line 39):

```ts
import { doctor } from "@/cli/doctor.js";
```

Register the command — add it right after the `agent` command block (after line ~858, before the `review` command):

```ts
  program
    .command("doctor")
    .description("Diagnose problems with an Agency file using the agency agent")
    .argument("<file>", "Path to the .agency file to diagnose")
    .option("--symptom <text>", "Optional description of the problem you are seeing")
    .action((file: string, opts: { symptom?: string }) => {
      const config = getConfig();
      doctor(config, file, opts);
    });
```

- [ ] **Step 3: Build the TypeScript CLI**

Run: `pnpm run build 2>&1 | tee /tmp/build-task2.log`
Expected: no TypeScript errors. Confirm `dist/lib/cli/doctor.js` exists:
Run: `ls dist/lib/cli/doctor.js`

- [ ] **Step 4: Verify the command is wired**

Run: `pnpm run agency doctor --help 2>&1 | tee /tmp/doctor-help.log`
Expected: usage shows `<file>` argument and `--symptom <text>` option. (This does not launch the agent.)

- [ ] **Step 5: Commit**

```bash
git add lib/cli/doctor.ts scripts/agency.ts
git commit -F /tmp/commit-task2.txt
```

Message (in file):

```
Add `agency doctor <file> [--symptom <text>]` command

A thin wrapper that launches the agency agent interactively, seeded with
a diagnosis prompt routed to the code subagent, via the generic
--interactive/--agent flags.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 3: "Syntax gotchas" docs section

Add the gotchas list to the bundled troubleshooting guide so the doctor prompt can point the agent at it.

**Files:**
- Modify: `docs/site/guide/troubleshooting.md`

- [ ] **Step 1: Append the gotchas section**

At the end of `docs/site/guide/troubleshooting.md`, add:

```markdown

## Syntax gotchas

Agency's parser has a few rules that surprise people coming from other
languages. If a file fails to parse or typecheck, check it against these
first:

- **No comments inside object or array literals.** A `//` or `/* */`
  comment placed *between* entries of an object/array literal fails to
  parse, and the reported error location is often misleading (it points
  at the enclosing declaration, not the comment). Move the comment above
  the literal.

  ```
  // BAD — comment between entries fails to parse
  const x = {
    a: 1,
    // the b field
    b: 2,
  }

  // GOOD — comment above the literal
  // the b field
  const x = { a: 1, b: 2 }
  ```

- **`if` / `while` / `for` require parentheses around the condition and
  braces around the body.** `if x > 5 { ... }` and `if (x > 5): ...` are
  both wrong; write `if (x > 5) { ... }`. `for` loops use `in`:
  `for (item in items) { ... }`.

- **No Python-style `def`/`node` headers.** Use
  `def foo(x: number): string { ... }` and `node main() { ... }`, not
  `function foo() -> string:` or `node main -> end:`.

- **Variables must be declared before use.** Bare assignment (`x = 5`)
  without a prior `let`/`const` is not allowed; write `let x = 5`.

- **Pattern binders can't bind inside a boolean expression.**
  `return r is success(v) && v.ok` is a parse error ("binder has nowhere
  to bind"). Use a statement form instead:

  ```
  if (r is success(v)) {
    return v.ok
  }
  ```

- **Avoid literal backslashes in string literals.** A backslash in a
  string literal can currently compile to invalid JavaScript. Prefer a
  regex character class (e.g. `re/[^a-zA-Z0-9]+/g`) over a string like
  `"\\"` when sanitizing text.

When in doubt, check the [Basic Syntax](/guide/basic-syntax) guide or run
`agency ast <file>` to see whether the file parses.
```

- [ ] **Step 2: Refresh the bundled copy**

Run: `make agents 2>&1 | tee /tmp/make-agents-task3.log`
Expected: completes; the doc is copied to `dist/lib/agents/docs/guide/troubleshooting.md`.
Verify:
Run: `grep -l "Syntax gotchas" dist/lib/agents/docs/guide/troubleshooting.md`

- [ ] **Step 3: Commit**

```bash
git add docs/site/guide/troubleshooting.md
git commit -F /tmp/commit-task3.txt
```

Message (in file):

```
docs: add a Syntax gotchas section to the troubleshooting guide

Lists the parser/language gotchas new users hit (comments in object
literals, paren/brace requirements, declaration-before-use, the
is-binder rule, backslash codegen). The `agency doctor` prompt points
the agent at this section.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 4: "Be proactive" prompt sections

Make the agent read files itself instead of asking the user to paste them.

**Files:**
- Modify: `lib/agents/agency-agent/subagents/code.agency`
- Modify: `lib/agents/agency-agent/agent.agency`

- [ ] **Step 1: Add "Be proactive" to the code subagent prompt**

In `lib/agents/agency-agent/subagents/code.agency`, find the end of the `## Answer before action` section in `codeSysPrompt` (it ends with `...before reaching for \`write\` or \`edit\`.`) and the start of `## Hard rules`. Insert this new section between them:

```
## Be proactive

Your job is to help the user, not to hand work back to them. If you can
find something out yourself, do it — don't ask the user to do it for you.

- If the user asks you to look at, debug, or change a file or some code,
  **read it yourself** with your `read` tool. Never ask the user to paste
  or "share the contents" of a file you can read.
- You don't need absolute paths. Your file and shell tools resolve
  relative paths against the user's working directory automatically, so a
  bare name like `foo.agency` just works — pass it straight through. Don't
  ask the user for the full or absolute path.
- If a relative path doesn't resolve, use `glob` / `ls` to locate the file
  before giving up. Asking the user where it is is a last resort, not a
  first move.
- Only ask the user for something when you genuinely cannot get it with
  the tools you have. Show initiative.

```

- [ ] **Step 2: Add a "Be proactive" mirror to the main agent prompt**

In `lib/agents/agency-agent/agent.agency`, in `mainAgentSystemPrompt`, insert this section immediately before the `## Answer before action` section (which is the last section in the prompt):

```
## Be proactive

When the user asks you to look at, debug, or change a file or some code,
**delegate to `codeAgent` to do it** — don't ask the user to paste a file
or describe code a subagent could read. The code agent has `read`, `glob`,
and `ls` and resolves relative paths against the user's working directory
automatically, so a bare filename like `foo.agency` is enough. Only ask
the user for information you genuinely cannot obtain through a subagent.

```

- [ ] **Step 3: Rebuild the agent**

Run: `make agents 2>&1 | tee /tmp/make-agents-task4.log`
Expected: completes without errors.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/agency-agent/subagents/code.agency lib/agents/agency-agent/agent.agency
git commit -F /tmp/commit-task4.txt
```

Message (in file):

```
Make the agency agent more proactive

Add a "Be proactive" section to the code and main agent system prompts:
read/delegate-to-read files instead of asking the user to paste them, use
relative paths (tools resolve them), and fall back to glob/ls before
asking the user.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 5: Final build + branch wrap-up

**Files:** none (build + git)

- [ ] **Step 1: Full build to confirm everything is consistent**

Run: `make 2>&1 | tee /tmp/make-final.log`
Expected: full build (templates, TS build, stdlib, agents, docs) completes with no errors.

- [ ] **Step 2: Re-verify the CLI command and agent compile**

Run: `pnpm run agency doctor --help` (usage prints)
Run: `grep -c "agentReplyVia\|startInteractive\|START_AGENTS" lib/agents/agency-agent/agent.agency` (expect ≥ 4 references)

- [ ] **Step 3: Finish the branch**

Use superpowers:finishing-a-development-branch to verify state and choose merge/PR. (Testing is deferred, so the test-verification gate is satisfied by the build steps above; note this when presenting options.)

---

## Self-Review

**Spec coverage:**
- `agency doctor <file> [--symptom <text>]` → Task 2. ✓
- Wrapper over generic flags (not bespoke `--doctor`/`--symptom`) → Tasks 1 + 2. ✓
- `--interactive` flag controlling one-shot vs seeded interactive → Task 1 (Steps 5-6). ✓
- `--agent` targeting a subagent → Task 1 (Steps 1-2, 6). ✓
- Reuse code subagent (no new doctor subagent) → Task 2 routes via `--agent code`. ✓
- Gotchas in a bundled docs page + prompt pointer → Task 3 + the pointer in `buildDoctorPrompt` (Task 2). ✓
- Proactivity prompt in code + main agents → Task 4. ✓
- Testing deferred → no test tasks (intentional). ✓

**Type/name consistency:**
- `agentReplyVia(target, msg)` used by `oneShotAgent`, `_runSeedTurn`, and `agentReply` — same signature everywhere. ✓
- `oneShotAgent(target, prompt)` — both call sites in `main()` pass a target (`startAgent`). ✓
- `startInteractive(handler, seedTarget, seedPrompt)` — both call sites pass all three args. ✓
- `START_AGENTS` referenced in the validation guard and the dispatch covers the same names (`code/research/oracle/explorer/review` + `main`). ✓
- CLI: `doctor(config, file, opts)` and `buildDoctorPrompt(file, symptom?)` names match between `doctor.ts` and its registration. ✓

**Placeholder scan:** No TBD/TODO; every code step contains the actual content. ✓

**Risk notes:**
- The seeded-interactive path is genuine terminal behavior and is not automatically verified here (consistent with the deferred-testing decision). The build/compile steps catch syntax/type regressions but not runtime REPL behavior.
- `make agents` is required after editing the agent `.agency` files and the bundled doc; each task that touches them runs it.
