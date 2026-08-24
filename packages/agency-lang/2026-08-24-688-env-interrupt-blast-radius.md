# What it costs to make `env()` ask permission (#688)

This is a measurement, not a merge candidate. The branch redoes the change that
was tried in #694 and reverted, and then walks the whole repository to find out
what actually breaks and how hard each break is to fix. Nothing here is meant to
ship as-is: seven test files are still red on purpose, because leaving them red
is what makes the size of the job visible.

## Background, for anyone picking this up cold

`env(name)` in `std::system` reads an environment variable. Today it just reads
it. Its neighbour `setEnv(name, value)`, seven lines further down the same file,
raises an interrupt first, which means the program pauses and something — a
`handle` block, a policy file, or a human at a prompt — gets to say yes or no
before the write happens.

The argument in #688 is that reading a secret deserves the same treatment as
writing one. A secret that gets read can be put in a log line, in a prompt sent
to a model, or baked into generated code that then gets committed, and none of
that is visible to whoever owns the secret.

An **interrupt** in Agency is a pause-and-ask. When one is raised the runtime
takes a **checkpoint**: it writes down where in the program we are, so the
program can be resumed later with the answer. Taking a checkpoint requires a
**state stack**, and the state stack only exists while a node is running.

That last sentence is the whole problem, and it is why the first attempt was
reverted.

## What was already known, and what this branch adds

The reverted attempt established that startup code breaks. A `static const` at
the top of a module runs once when the process starts, before any node exists,
so there is no state stack, so no checkpoint can be taken, so an interrupt there
fails outright with:

```
Cannot create checkpoint: no current node id in state stack.
```

The write-up on the issue treated that as fatal — "impossible by construction" —
and listed a real refactor of agent startup as the way out.

**That turns out not to be necessary.** The error message names its own escape
hatch, and it works:

```ts
export static const HOME_DIR = env("HOME") with approve
```

`x = f() with approve` answers the interrupt at the call site instead of routing
it to a handler. That works in a static initializer, which was the thing
believed to be impossible. Verified by running it.

So the static-initializer problem is not a refactor. It is one annotation per
site, and there are four sites in the entire repository.

## The catch, and it is a real one

`with approve` in a static initializer is the one place where the CLI's
`--reject` flag cannot override it. Measured both ways:

| Where the read happens | `agency run --reject std::env` |
| --- | --- |
| Inside a node, written `env("HOME") with approve` | Blocked. The call returns a failure. |
| In a `static const`, written `env("HOME") with approve` | Not blocked. The read goes through and returns the real value. |

Everywhere else, `--reject` beats `with approve`, which is what makes
`--policy` + `--reject` a real sandbox for untrusted Agency code. Static
initializers are outside that, because rejecting also needs the interrupt
machinery that startup does not have.

So `with approve` at startup buys visibility, not enforcement. The read is now
written down in the source where a reader and a reviewer can see it, and the
effect shows up in `raises` clauses and in the generated docs. It is not gated.
Whether that is worth having is the judgement call this measurement hands back.

## The thing the change is actually for

The motivating case from the issue — a compile-time splice generator reading a
secret and baking it into committed code — becomes a compile error, with a
message that explains itself:

```
AG8003: Generator 'leakKey' may raise std::env, so it cannot run at compile
time. Compilation installs no interrupt handlers, so those operations could
not complete anyway. Move the effectful work out of the generator.
```

That is the payoff, and it works. The `CHILD_ENV_ALLOWED` workaround in
`runGenerator.ts` still has to stay, because a generator can reach `process.env`
through an imported npm package, and no interrupt on an Agency function can see
that route.

## The inventory

Twenty-two executable call sites, plus eight more inside doc-comment examples.

**Fixed on this branch (4).** Each is a top-level initializer. `with approve`
does not parse inside a subexpression, so each one splits into two constants —
one for the guarded read, one for the expression that used it:

| File | Was |
| --- | --- |
| `stdlib/data/wikidata.agency:42` | `const wikidataUserAgent = env(...) ?? "…"` |
| `stdlib/data/finance/edgar.agency:50` | `const secUserAgent = env(...) ?? "…"` |
| `lib/agents/agency-agent/lib/config.agency:29` | `export static const POLICY_DIR = resolveAgentHome(env(...))` |
| `lib/agents/agency-agent/lib/trace.agency:21` | `let AGENT_DEBUG: boolean = env(...) == "1"` |

`trace.agency` is new information — it was not in the write-up on the issue.

**Left alone, and this is the remaining work (18).** All of these are inside a
function or a node, so the interrupt mechanism works; they simply have nobody
answering it yet. Each needs a `handle` block, a `with approve`, or a `raises`
clause, depending on what the surrounding code wants:

- `lib/agents/agency-agent/lib/search.agency` — 4 sites reading `TAVILY_API_KEY` and `BRAVE_API_KEY`
- `lib/agents/agency-agent/shared.agency:63` — reads `AGENCY_AGENT_HOME`
- `stdlib/data/finance/fred.agency` — 2 sites; the `raises <std::env>` clauses these need are already on the branch
- 9 sites across 7 test files
- 3 more in `tests/integration/`

**Doc-comment examples that now show incomplete code (8)** in
`stdlib/calendar.agency`, `stdlib/auth/oauth.agency`, and `stdlib/policy.agency`.
These compile fine — they are inside comments — but they teach a pattern that no
longer works without a handler, so they would want updating before this ships.

## What the build catches, and what it does not

`make` is clean. That is not as reassuring as it sounds: the build was clean on
the reverted attempt too, right up until the tests ran.

`AG7003` refuses an `interrupt` written literally inside a static initializer,
but it does not follow calls, and here the interrupt is one call away inside
`env()`. So the build cannot see the problem class at all. A transitive version
of that check would turn this from a test failure into a compile error, and
would do the same for any future gating of an existing stdlib function. Worth
its own issue either way.

What the build does report is 20 new `AG3009` warnings ("may throw interrupts
[std::env] but is not inside a handler") across 5 files, all under
`lib/agents/agency-agent/`. Warnings, not errors, so they do not stop anything.

Effect propagation reached three public stdlib functions, which now advertise
`std::env` in their generated docs: `llm.agency`'s `firstAvailableProvider` and
two in `agents/lib/search.agency`. That is a small public-API surface, and it is
the effect system working correctly.

## Test results

Two things were fixed relative to the reverted attempt, both from the follow-up
comment on the issue:

- `effect std::env { name: string }` is now declared alongside `std::setEnv`, so
  the typechecker can validate the payload and an inline handler sees a typed
  `e.data`.
- `env` is marked `idempotent`, matching how the codebase marks other pure
  reads.

The new test is a round trip, because the previous one could not tell the two
possible outcomes apart. It sets `AGENCY_ENV_TEST` to `"hello"` through
`setEnv`, reads it back through `env`, and asserts the string. That pins the
claim that the signature stays `string | null` and that an approved read resumes
into the real `_env(name)` call rather than returning whatever the interrupt
resolved to. A second node asserts that a rejected read comes back as a failure
even though the variable is set. Both pass.

Of the seven previously-red files:

| Test | Before the static-init fixes | After |
| --- | --- | --- |
| `agent-home-resolve` | checkpoint error | **passes** |
| `agent-home-sandbox` | checkpoint error | unhandled interrupt |
| `stdlib/env-basic` | unhandled interrupt | unhandled interrupt |
| `stdlib/env-empty-vs-unset` | unhandled interrupt | unhandled interrupt |
| `stdlib/setenv-roundtrip` | unhandled interrupt | unhandled interrupt |
| `agents/extraTools` | unhandled interrupt | unhandled interrupt |
| `agents/oracleExplorer` (5 cases) | unhandled interrupt | unhandled interrupt |

The distinction in that table is the point. "Checkpoint error" means the
mechanism cannot work there at all. "Unhandled interrupt" means it works fine
and nobody has answered it yet — ordinary call-site work, deliberately not done
here.

After the four static-init fixes, **no checkpoint errors remain anywhere.**

The targeted unit suites (`lib/analysis`, `lib/compiler/splice`,
`tests/typescriptGenerator`) pass: 114 tests, 9 files. The full unit suite was
not run.

## So what does it take

- Four static-initializer sites, each a two-line split. Not a refactor.
- Eighteen ordinary call sites needing a handler, a `with approve`, or a
  `raises` clause.
- Eight doc-comment examples to update.
- One open question that this measurement cannot answer: whether `with approve`
  at startup, which `--reject` cannot override, is acceptable for the four sites
  that need it — including `POLICY_DIR`, which is the root of the agent's own
  policy chain.

That last one is the decision. The mechanical cost is small. Whether the four
ungated startup reads undercut the point of the change is a judgement about what
#688 is for.
