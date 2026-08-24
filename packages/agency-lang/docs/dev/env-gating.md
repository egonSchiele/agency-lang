# Reading the environment asks permission

`env(name)` in `std::system` raises `std::env` before it reads. This note says
why, what the rule is for deciding how any given call site answers it, and two
things about `with approve` that are easy to get wrong and are not written down
anywhere else.

Background: #688, and #694, which tried this once and was reverted.

## Why

`setEnv(name, value)` has always raised an interrupt. `env(name)`, seven lines
above it in the same file, used to just read. Reading a secret is at least as
sensitive as writing one: the value can go into a log line, into a prompt sent
to a model, or into generated code that then gets committed, and none of that is
visible to whoever owns the secret.

The sharpest case is a compile-time splice. A generator runs during compilation
and whatever it reads can be baked into the emitted JavaScript as a string
literal. That is now a compile error:

```
AG8003: Generator 'leakKey' may raise std::env, so it cannot run at compile
time. Compilation installs no interrupt handlers, so those operations could
not complete anyway. Move the effectful work out of the generator.
```

`CHILD_ENV_ALLOWED` in `lib/compiler/splice/runGenerator.ts` stays anyway. It
covers a different route: a generator that imports an npm package which reads
`process.env` directly, where no interrupt is involved at any point and no
change to an Agency function can help.

## The rule for a call site

Ask what happens to the value.

**The value leaves the function** — it is returned, printed, logged, put in a
prompt, or written to a file. Let the interrupt propagate. The program's handler
or policy decides, which is the whole point.

**The value cannot leave the function** — it is compared against `null` or `""`
and discarded, and what comes back is a boolean or a name. That is a presence
check, not a disclosure. Answer it at the site with `with approve` and say so in
a comment.

**The value goes straight into an operation that is itself gated.** Approve the
read and let the real interrupt do the asking. `stdlib/agents/lib/search.agency`
binds `TAVILY_API_KEY` into a search tool, but the search itself raises
`std::search` or `std::tavilySearch`, and that is the moment worth a prompt.
`fred.agency` reads `FRED_API_KEY` into a request gated by `std::fred`. Asking
twice for one decision trains people to say yes.

Everything the agent reads about itself — `AGENCY_AGENT_HOME`, `AGENT_DEBUG`,
which provider keys are set — falls in the second or third bucket. That matches
how the agent already treats its own configuration: `settings.agency` reads
`settings.json` with `with approve`, `grounding.agency` reads `AGENTS.md` the
same way.

## `with approve` works in a static initializer

This is the thing #694 concluded was impossible, and it is worth being precise
about why it looked that way.

An interrupt takes a **checkpoint**, which needs a **state stack**, which only
exists while a node is running. A `static const` initializer runs once at
process startup, before any node exists. So an interrupt there fails:

```
Cannot create checkpoint: no current node id in state stack.
```

But `with approve` answers the interrupt at the call site instead of routing it
to a handler, so no checkpoint is needed, and it works:

```ts
export static const HOME_DIR = env("HOME") with approve
```

There are four such sites in the repository — `config.agency`'s `POLICY_DIR`,
`shared.agency`'s `AGENCY_AGENT_DIR`, `trace.agency`'s `AGENT_DEBUG`, and the
user-agent constants in `wikidata.agency` and `edgar.agency`.

One syntax constraint: `with approve` attaches to a whole initializer and does
not parse inside a subexpression. `(env("X") with approve) ?? "default"` is a
parse error. Split it into two constants — one for the guarded read, one for the
expression that uses it.

## Two things about `with approve` that will surprise you

**It does not discharge the effect.** A `raises` clause still has to list
`std::env` even when every read under it is approved at the site, and callers
still get `AG3009` ("may throw interrupts [std::env] but is not inside a
handler"). `with approve` is a runtime answer, not a static one. This is why
`fredSeries` and `fredSeriesInfo` declare `raises <std::fred, std::env,
std::http::fetchJSON>` despite approving both reads internally, and why the
agent still carries `std::env` in its existing AG3009 warnings.

**In a static initializer, `--reject` cannot override it.** Everywhere else
`agency run --reject std::env` beats `with approve` and turns the call into a
failure, which is what makes `--policy` plus `--reject` a real sandbox. Startup
is outside that, because rejecting needs the same interrupt machinery startup
does not have:

| Where the read happens | `agency run --reject std::env` |
| --- | --- |
| Inside a node | Blocked. The call returns a failure. |
| In a `static const` | Not blocked. The read returns the real value. |

So the four startup reads get visibility, not enforcement: they are written down
where a reviewer can see them, and they show up in `raises` clauses and the
generated docs, but they are not gated. One of them is `POLICY_DIR`, the root of
the agent's own policy chain. Being discussed separately.

## What the build cannot catch

`AG7003` refuses an `interrupt` written literally inside a static initializer.
It does not follow calls, so it cannot see an interrupt one call away inside
`env()`. That is why #694 built clean and then failed in CI. A transitive
version of that check would catch this whole class, for any future gating of an
existing stdlib function, and is worth its own issue.

## Testing it

The obvious test does not work. `env()`'s body is `return interrupt std::env(...)`
followed by `return _env(name)`, and nothing in the source says which of those
the caller gets. Asserting the result is non-null passes either way.

`tests/agency/env-interrupt.agency` does a round trip instead: `setEnv` a known
value, read it back through `env`, assert the string. That is what pins the
claim that an approved read resumes into the real `_env(name)` and the signature
stays `string | null`. A second node asserts a rejected read comes back as a
failure even though the variable is set.

## Related

- `docs/dev/interrupts.md` — how interrupts resume inside blocks
- `docs/dev/effect-propagation.md` — how a function's effect set is computed
- `docs/dev/splices.md` — compile-time splices and the generator environment
- `docs/dev/test-cli-sandbox.md` — `--policy` and `--reject`
