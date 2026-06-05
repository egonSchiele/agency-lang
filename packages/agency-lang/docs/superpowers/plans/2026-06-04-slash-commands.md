# Slash Commands for the Agency Agent

## Background

Claude Code recently merged custom commands into skills: `.claude/commands/foo.md` and `.claude/skills/foo/SKILL.md` both produce `/foo`, share one frontmatter spec, and are described in the same docs page (`code.claude.com/docs/en/slash-commands`). The file format is unified, but the **runtime behavior** still splits:

- **Skills** — model-invoked, lazy. Description sits in the model's tool list; body loads only when the model (or user) picks it. We already support this via `skillsDir` in `stdlib/skills.agency`, which returns a `read.partial(dir: dir).describe(...)`-shaped tool.
- **Commands** — user-typed, eager. The body has `$ARGUMENTS` substituted and is injected as a user message into the conversation.

**v1 scope (explicit):** a command is a *pure prompt template*. The rendered body is appended to the current thread as a user message — exactly as if the user had typed the text manually. No `!`cmd`` shell injection, no `@<path>` file references, no `allowed-tools` pre-approval, no `model`/`effort` overrides. All of these are tracked as follow-ups (see "Out of scope"). This keeps the security picture trivial: commands cannot do anything the user couldn't do by typing.

The agency agent (`lib/agents/agency-agent/agent.agency`) currently hardcodes `/exit`, `/clear`, `/help` in `_runTurn` and exposes nothing extensible to users. We want users' existing `~/.claude/commands/` and project-local `.claude/commands/` files to work in the agency agent the same way they do in Claude Code.

This spec adds a `commandsDir(dir)` function to `stdlib/skills.agency`, alongside the existing `skillsDir`, and wires it into `lib/agents/agency-agent/agent.agency`.

## Decision: one module, two functions

`commandsDir` lives in `stdlib/skills.agency`, not a new `stdlib/commands.agency`. The shared work — `glob` a directory, parse frontmatter on each file — is the bulk of the code. The divergence is at the edges: skills render into a tool description; commands render into a dispatcher. Two surfaces over one private helper is the right shape.

A second-order benefit: when a user reads `std::skills`, they see both halves of the CC unification in one place.

## Public API

```agency
type Command = {
  name: string,         // "/foo" or "/ns:bar"
  description: string,  // from frontmatter, "" if absent
  argHint: string,      // from frontmatter argument-hint, "" if absent
}

type CommandSet = {
  entries: Command[],
  dispatch: (input: string) => Result<string, "no-match">,
}

export def commandsDir(dir: string): CommandSet
```

`dispatch(input)` returns a [`Result`](https://agency-lang.com/guide/error-handling.html):

- `failure("no-match")` if `input` doesn't start with `/<name>` (with optional whitespace + args after).
- `success(body)` if it matches. `body` is the rendered command body: frontmatter stripped, `$ARGUMENTS` substituted, ready to feed to `route()` as the user message. `body` MAY be the empty string (a legitimate command that renders to nothing); callers must check the Result tag, not truthiness.

We use `Result` rather than `string | null` because the empty-string case is meaningful and `?? msg` fall-through would silently send the raw `/foo` to the LLM if a command rendered to `""`.

`entries` is for the UI: `agent.agency` splices `name` into `repl()`'s `paletteCommands` (with `description` as the menu text and `argHint` displayed after it) so users get autocomplete.

## File discovery

Mirror CC's layout:

- `<dir>/foo.md` → `/foo`
- `<dir>/<ns>/<bar>.md` → `/<ns>:<bar>` (one level of nesting only — CC supports the same)
- Both `.md` and `.markdown` extensions

Implementation: two `glob` calls, since `_glob` in `lib/stdlib/shell.ts` supports one level of brace expansion but not the `**` star you'd want for "any depth":

```agency
const flat   = glob("*.{md,markdown}",   dir)    // → /foo
const nested = glob("*/*.{md,markdown}", dir)    // → /<ns>:<bar>
```

Verified against `globToRegExp` at [lib/stdlib/shell.ts:367](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/stdlib/shell.ts#L367) — single-level `{a,b}` works; nested braces explicitly rejected.

Skip files with parse failures silently (same posture as `skillsDir` — `frontmatter ... catch {}`).

## Body preprocessing

The body is everything after the frontmatter block. Only one transform happens: `$ARGUMENTS`-family substitution.

### `$ARGUMENTS` family

Given user input `/foo "hello world" second`:
- `$ARGUMENTS` → `"hello world" second` (the raw arg string verbatim, quotes preserved)
- `$ARGUMENTS[N]` and `$N` (1-indexed, matching shell + CC) → the Nth tokenized arg. So `$1` = `hello world`, `$2` = `second`. `$0` is undefined → leave the literal `$0` in place.
- Out-of-range `$N` → leave the literal token in place (don't silently substitute `""`; that masks template bugs).

If the body contains no `$ARGUMENTS` token (and no `$N`) and the user passed args, append `\n\nARGUMENTS: <raw>` to the rendered body. Matches CC behavior — gives the LLM access to the input even if the template author forgot a placeholder.

#### Tokenizer — explicit definition

Match CC exactly. CC's documented behavior (cross-referenced with [anthropics/claude-code#8406](https://github.com/anthropics/claude-code/issues/8406)):

1. Split on runs of whitespace (` `, `\t`, `\n`).
2. A double-quoted span (`"..."`) groups everything between the quotes into one token, including whitespace. Quotes are stripped from the token; the raw form keeps them.
3. **No other quoting or escapes.** No single quotes, no backslash escapes, no env-var expansion. This is intentionally minimal and matches CC — users who hit it are vocal about it (see #8406), but matching CC means existing command files work without surprises.
4. An unterminated `"` consumes to end-of-input.

Concrete examples:
| Input                              | Tokens                          |
|------------------------------------|---------------------------------|
| `/foo a b c`                       | `["a", "b", "c"]`               |
| `/foo "hello world" x`             | `["hello world", "x"]`          |
| `/foo 'single' x`                  | `["'single'", "x"]`             |
| `/foo a\ b`                        | `["a\\", "b"]`                  |
| `/foo "unterminated x y`           | `["unterminated x y"]`          |

The tokenizer is a small inline function (~20 lines) in `stdlib/skills.agency`. `std::args` doesn't expose a string tokenizer — `parseArgs` takes `argv: string[]` already split by the OS — so there's no shared code to lift.

**Wiggle room for mistakes:** none in v1. If a user wants single-quoted or `<arg>...</arg>` delimited args (a real ask — see #8406 in CC), we add it as a follow-up rather than diverging from CC silently.

### `!`cmd`` shell injection — **out of scope (v1)**

Tracked as follow-up. When added, every shell exec MUST go through `cliPolicyHandler` (Agency's universal handler boundary) rather than the static-frontmatter pre-approval model CC uses. See [handlers guide](https://agency-lang.com/guide/handlers.html). Note that CC's shell-injection permission flow has a longstanding bug ([anthropics/claude-code#3662](https://github.com/anthropics/claude-code/issues/3662)) where prompts don't fire from inside commands — going through `cliPolicyHandler` from day one avoids that class of bug.

### `@<path>` file references — **out of scope (v1)**

Defer. Not strictly a command feature; it's a general CC input affordance and warrants its own design pass.

### `allowed-tools` / `model` / `effort` / `context: fork` — **out of scope (v1)**

These all need first-class hooks in `route()` or `cliPolicyHandler` that don't exist yet. Silently ignored on read; the command still runs with the agent's default tools and model. Documented in the `commandsDir` docstring.

## Frontmatter fields we honor

Of CC's ~15 frontmatter fields, only these map cleanly to the agency agent in v1:

| Field           | Behavior                                                 |
|-----------------|----------------------------------------------------------|
| `description`   | Shown in palette entries                                 |
| `argument-hint` | Shown in palette entries after the description           |

Note that CC does **not** document an `arguments:` (list of names) frontmatter field — earlier drafts of this spec included one, but it isn't a real CC affordance. Positional refs are always `$1`/`$2`/`$ARGUMENTS[N]`. Adding named-arg support would diverge from CC's file format and is not in v1.

Everything else (`allowed-tools`, `disallowed-tools`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell`) is silently ignored. None of them have a clean mapping into agency-agent's two-thread `route()` architecture, and the failure mode of ignoring them is benign (the command still runs, just without the extra constraint). Documented in the `commandsDir` docstring.

## Wiring into `agent.agency`

```agency
import { commandsDir } from "std::skills"

static const userCommands    = commandsDir("${env("HOME")}/.claude/commands") with approve
static const projectCommands = commandsDir(".claude/commands") with approve

// Built-ins win over both. Among file commands, project beats user.
// Final precedence: built-ins > project > user.
def mergePalette(): Record<string, string> {
  const out: Record<string, string> = {}
  for (cmd in userCommands.entries)    { out[cmd.name] = cmd.description }
  for (cmd in projectCommands.entries) { out[cmd.name] = cmd.description }
  out["/exit"]  = "Exit the agent"
  out["/clear"] = "Clear the conversation transcript"
  out["/help"]  = "Show available slash commands"
  return out
}

def _runTurn(msg: string): boolean {
  // Built-ins first — they always win.
  if (msg == "/exit" || msg == "/quit") { return false }
  if (msg == "/clear") { clearMessages(); return true }
  if (msg == "/help")  { /* ... */ return true }

  // Project then user, matching mergePalette() precedence.
  let prompt = msg
  const projHit = projectCommands.dispatch(msg)
  if (projHit is success(body)) {
    prompt = body
  } else {
    const userHit = userCommands.dispatch(msg)
    if (userHit is success(body)) {
      prompt = body
    }
  }
  // If neither matched and `msg` started with `/`, we still pass it
  // through to route() as a literal user message. CC does the same —
  // unknown slash commands are surfaced to the model rather than
  // silently swallowed.

  const reply = route({ ... }, prompt)
  pushMessage(highlight("${reply}\n", language: "markdown"))
  return true
}
```

Notes:
- `static const ... with approve` auto-approves the two `glob` calls during module init. Because v1 has no `!`cmd`` shell execution, dispatch itself never touches the policy handler — it's pure string transformation.
- `static const` runs at load time. New `.md` files added mid-session are *not* picked up. Acceptable for v1; tracked as a follow-up.
- Precedence: built-ins > project > user. CC's published precedence for *skills* is enterprise > personal > project, but for *commands* the "closer wins" rule is the intuitive one and matches what users expect from layered configs.

### Non-interactive (`--print` / piped) path

The existing non-interactive branch in `main()` ([agent.agency:326-371](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/agents/agency-agent/agent.agency#L326-L371)) bypasses `_runTurn` entirely — it builds a prompt and calls `route()` directly. To keep behavior consistent, dispatch must also run there:

```agency
const prompt = projectCommands.dispatch(piped) is success(body) ? body
             : userCommands.dispatch(piped)    is success(body) ? body
             : piped
```

Built-ins (`/exit`, `/clear`, `/help`) are meaningless in one-shot mode and are not checked. This lets users do `pnpm run agency agent /myCommand arg1 arg2` and have it work the same as typing it in the REPL.

## Edge cases worth nailing

- **Empty directory / missing directory** — `glob` returns failure → `entries: []`, `dispatch` always returns `failure("no-match")`. Same posture as `skillsDir`.
- **Command name collision with built-ins (`/exit`, `/clear`, `/help`)** — built-ins win, because `_runTurn` checks them before calling `dispatch`. Document this. A user who wants to override `/clear` would have to edit the agent.
- **Command with no `$ARGUMENTS` and no args passed** — body renders as-is, no `ARGUMENTS:` suffix.
- **Command with args but body has only `$1`, no `$ARGUMENTS`** — `$1` substitutes; treat as "no `$ARGUMENTS` token" → append the suffix. Matches CC.
- **A command file with no frontmatter at all** — body is the entire file; `description` = "", `argHint` = "". Should still dispatch.
- **Command that renders to the empty string** — `dispatch` returns `success("")`. Caller must use the Result tag, not truthiness (see "Public API").
- **User types `/notACommand`** — neither set matches → fall through to `route()` with `msg` unchanged. The LLM sees a literal `/notACommand` user message and can respond "I don't recognize that command". Matches CC.
- **Unicode/emoji in args** — strings, not bytes; pass through verbatim. Tokenizer is whitespace-only so non-ASCII is fine.

## Testing

Two layers:

1. **Unit tests** (`tests/unit/commandsTokenizer.test.ts` or co-located with the runtime helper if we extract one) — pure-string-in / pure-string-out, no I/O. Cover:
   - tokenizer: whitespace splits, double-quoted spans, unterminated quote, single quotes left literal, backslash left literal
   - `$ARGUMENTS` substitution with and without args
   - `$1`/`$ARGUMENTS[1]` substitution; out-of-range left literal; `$0` left literal
   - "no `$ARGUMENTS` + args present" → suffix appended
   - "no `$ARGUMENTS` + no args" → no suffix
   - malformed frontmatter → body falls back to whole file
2. **Agency execution test** (`tests/agency/commands-dir.agency`) using a fixture directory under `tests/agency/commands-dir-fixture/`. Mirror the shape of the existing `tests/agency/skills-dir.agency` + `tests/agency/skills-dir-fixture/` pair. Use `with approve` to auto-approve the `glob`/`read` calls.

Fixture files to include:
- `simple.md` — body, no frontmatter, no args
- `with-args.md` — `$ARGUMENTS` and `$1`/`$2`
- `ns/scoped.md` — verify `/ns:scoped` dispatch
- `bad-frontmatter.md` — verify graceful skip (still dispatches with empty description)

Agency-test assertions to include:
- Missing dir → `entries.length == 0`, `dispatch("/anything")` returns `failure("no-match")`.
- `entries` length matches fixture count (3, excluding bad-frontmatter if we drop it; 4 if we keep it dispatchable).
- `dispatch("/simple")` returns `success` with the literal body.
- `dispatch("/with-args foo bar")` substitutes correctly.
- `dispatch("/notExist")` returns `failure("no-match")`.
- `dispatch("/ns:scoped")` resolves the namespaced command.

## Out of scope (follow-ups)

- ``!`cmd`` shell injection — when added, must route through `cliPolicyHandler` (not frontmatter pre-approval).
- `@<path>` file references.
- Live reload when files change mid-session.
- `allowed-tools` → Agency policy mapping (would need a `cliPolicyHandler` integration to scope pre-approvals per-command).
- `model:` / `effort:` / `context: fork` — would need `route()` to accept per-turn overrides.
- Built-in command override from user files.
- Configurable arg delimiters (e.g. `<arg>...</arg>`) — see [anthropics/claude-code#8406](https://github.com/anthropics/claude-code/issues/8406). Match CC's whitespace+`"` tokenizer for v1 to stay compatible.
- Named-arg frontmatter (`arguments: [issue, branch]` + `$issue` refs). Not a CC affordance; would diverge from the unified file format.

## Implementation order

Revised: build `commandsDir` standalone first, then factor out a shared helper. This keeps the working `skillsDir` untouched until we have a concrete second consumer to design against, shrinking blast radius.

1. **Tokenizer + arg substituter** (`stdlib/skills.agency` or extracted to a TS helper for unit-testability). Pure functions, vitest-covered.
2. **`commandsDir`** — its own glob/parse loop (duplicating `skillsDir`'s walker for now), returning `CommandSet`. Returns a `Result`-typed `dispatch`.
3. **Agency execution test** + fixtures. Confirms end-to-end behavior before touching the agent.
4. **Wire into `lib/agents/agency-agent/agent.agency`** — both `_runTurn` (REPL path) and the non-interactive branch in `main()`. Rebuild bundled agent (`pnpm run build && make agents`). Smoke-test by typing a `/myCommand` into the running agent.
5. **Refactor**: extract the shared directory-walker between `skillsDir` and `commandsDir` into a private helper. Verify existing `skills-dir.agency` test still passes — no skill-side behavior change.
6. **Docs**: update `docs/site/guide/` (find the right page or add a short one); update the `commandsDir` docstring with the ignored-frontmatter-fields note; mention the `--print` / piped dispatch behavior in the agency-agent README.
