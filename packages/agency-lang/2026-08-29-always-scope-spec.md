# Spec: the `@always` tag, which declares what "approve always here" means per effect

Date: 2026-08-29
Status: reviewed 2026-08-29; ready for a plan
Location: `/Users/adityabhargava/agency-lang/packages/agency-lang/2026-08-29-always-scope-spec.md`

## 1. The problem

When the agency agent wants to do something gated by an interrupt, the user
sees a prompt with five choices:

```
approve once
reject once
approve always (every future std::env)
approve always here (dir=/Users/adi/proj/**)     <- only for some effects
reject always
```

The fourth choice, "approve always here", is the useful one: it saves a
rule that approves this effect only when the interrupt's data matches what
was approved. Reads under one directory, for example, but not reads
anywhere.

The fourth choice is offered only for effects listed in a table in the
agent, `ALWAYS_FIELDS` in `lib/agents/agency-agent/lib/config.agency:46`.
That table lists ten effects: `std::read`, `std::write`, `std::edit`,
`std::ls`, `std::glob`, `std::grep` (scoped by `dir`), `std::copy` and
`std::move` (by `src` and `dest`), `std::exec` (by `command` and
`subcommand`), and `mcp::call` (by `server` and `tool`).

Every other effect gets only "approve always", which approves every future
instance. The example that prompted this spec: the agent needs the Brave
API key, so it raises `std::env` with `{ name: "BRAVE_API_KEY" }`. The user
can approve that one read, or approve reading every environment variable
forever. There is no way to say "always let it read `BRAVE_API_KEY`".

The same gap exists for shell commands, HTTP requests, opening URLs,
secrets, email, git writes, and about sixty other effects.

## 2. What we decided in the brainstorm

- The scope of "always" is a property of the effect. It belongs next to
  the effect's declaration in the stdlib. Today it lives in a table inside
  one agent.
- It is declared with a tag, `@always(...)`, on the existing
  `effect std::env { name: string }` declaration. Tags already attach to
  effect declarations, so there is no parser work.
- The policy matching vocabulary stays as it is: exact string match plus
  globs. We looked at Cedar, IAM, OPA, and Claude Code's permission rules.
  Cedar and IAM add comparisons and set membership; OPA is a full language;
  Claude Code, whose rules are mostly generated from approval prompts like
  ours, stops at globs. Rules that a prompt generates must be readable on
  one line. Anything a glob cannot say (approve if `amount < 100`) is what a
  `handle` block in Agency code is for, so the JSON policy does not grow a
  second language for it.
- Per-effect scope decisions: `bash` is exact `command` plus `cwd`; HTTP is
  `method` plus `baseUrl`; `openUrl` is the host.

## 3. Goals and non-goals

Goals:

1. Every stdlib effect whose data has a sensible "here" offers "approve
   always here", and the scope is declared on the effect itself.
2. Any program that uses `cliPolicyHandler` gets those scopes with no
   configuration. The agency agent's `ALWAYS_FIELDS` table goes away.
3. A generated rule matches exactly what the user approved. Today a
   literal value is pasted into a glob pattern unescaped.

Non-goals:

- No new match operators in policy files.
- No change to how a handler-chain resolves (any reject wins, and so on).
- No change to the built-in policies (`recommended`, `with-writes`, ...).

## 4. Background: how the pieces fit today

Reading order for a reviewer new to this area.

**Raising.** A stdlib function raises an interrupt with
`interrupt std::env("message", { name: name })` (`stdlib/system.agency:106`).
The effect name is the string after `interrupt`; the object is the
interrupt's `data`. The runtime builds an interrupt record
`{ effect, message, data, ... }` and walks the handler chain with it.

**Declaring.** `effect std::env { name: string }` (`stdlib/system.agency:31`)
declares the payload type. It exists so the typechecker can check the
`data` object at each raise site (`lib/typeChecker/effectPayloadCheck.ts`)
and so `agency doc` can list the effects a module raises. It is
compile-time only: `typescriptBuilder.ts:636` emits nothing for it.
There are 104 declarations across the stdlib.

**Tags.** A line like `@hidden` or `@validate(isEmail)` above a declaration
parses as a `Tag` node (`name` plus an `arguments: Expression[]` list). The
preprocessor attaches pending tags to the next declaration, and
`effectDeclaration` is already in its list of valid targets
(`lib/preprocessors/typescriptPreprocessor.ts:124`). Reading a tag off a
declaration is a one-line helper, like `isHidden` in `lib/utils/hiddenTag.ts`.

**The prompt.** `cliPolicyHandler(file:, fields:, policy:, interactive:)`
in `stdlib/policy.agency:915` is what the agent installs as its outermost
handler. On an interrupt no rule decides, `askUser` (`stdlib/policy.agency:681`)
shows the five choices. It offers "approve always here" only when
`fields[intr.effect]` is non-empty. On that answer, `recordScopedRule`
calls `buildScopedMatch` (`stdlib/policy.agency:277`), which reads each
configured field's value out of `intr.data` and builds a match object:

```
{ dir: "{/Users/adi/proj,/Users/adi/proj/**}" }    // matchSubpaths: true
{ command: "agency", subcommand: "typecheck" }     // matchSubpaths: false
```

That match object is appended to the policy file as
`{ match: ..., action: "approve" }`. Matching is glob-based (picomatch), so
a value with `*`, `{`, `,` or `[` in it is currently interpreted as a
pattern rather than a literal. `lib/runtime/builtinPolicies.ts` has an
`escapeGlob` for the built-in policies; generated rules do not use it.

**The agent.** `lib/agents/agency-agent/lib/turn.agency:942` builds the
handler with `fields: ALWAYS_FIELDS` from `config.agency`. That is the only
place the table is consumed.

## 5. Design

### 5.1 The `@always` tag

An effect declaration may carry an `@always(...)` tag, an `@alwaysUnder(...)` tag, or both. Their arguments name
the payload fields that a generated "always here" rule pins.

```
@always(name)
effect std::env { name: string }

@always(command, cwd)
effect std::bash { command: string, cwd: string, timeout: number, stdin: string }

@alwaysUnder(dir)
effect std::read { dir: string, filename: string, offset: number, limit: number }

@alwaysUnder(src, dest)
effect std::copy { src: string, dest: string }
```

Each argument is a bare identifier naming a payload field. `@always` pins
the exact value; `@alwaysUnder` pins the value and everything under it
(the existing `matchSubpaths: true` behaviour). A declaration may carry
both tags. Tag arguments cannot be function calls (`_identOrPfaParser` in
`lib/parsers/parsers.ts` rejects them on purpose), which is why there are
two tag names and no `subpaths(dir)` form. Neither form needs a parser
change.

An effect with neither tag offers no "approve always here" option, the
same as an effect missing from today's table.

Rules the typechecker enforces, each with a diagnostic pointing at the tag:

- every named field exists in the payload type;
- every argument is a bare identifier, and no field is named twice;
- at most one of each tag per declaration;
- an `@always` tag that attached to something other than an effect
  declaration is an error (reuse the stray-tag walk that `strayHiddenLines`
  uses).

Where an effect is declared in more than one module (the payload check
already merges those), the tags must agree or the checker reports
a conflict. In practice each stdlib effect is declared once.

### 5.2 Getting the scope to runtime

The policy handler runs at runtime and has no source to read, so the
compiler has to hand the scope over. Two choices were considered:

- **Emit a registration call from the declaration.** The effect
  declaration stops erasing and instead compiles to a call at module init,
  at module JS-load, next to the existing `__registerStaticInit(...)` line:
  `__registerAlwaysScope("std::env", [{ field: "name", subpaths: false }])`.
- **Emit a manifest per compilation unit.** Collect all declarations at
  link time and emit one table.

The first is chosen. It is local (one declaration, one line of output),
needs no new link-time step, and registers exactly the effects of the
modules the program imports, which is exactly the set that can raise. A
declaration with neither tag still erases.

The registry lives on the runtime context. It does not go in `GlobalStore`:
`GlobalStore` is serialized into checkpoints and restored on resume; the
scope table is static and is re-registered when modules initialize on
resume, so serializing it would only create a second copy that could
disagree with the code. The registry is a plain
`Record<string, ScopedField[]>` in `lib/runtime/alwaysScope.ts` behind two
functions, which live in different places because they have different
callers:

```ts
__registerAlwaysScope(effect: string, fields: ScopedField[]): void   // runtime only
alwaysScopeFor(effect: string): ScopedField[]                        // [] when unknown
```

`__registerAlwaysScope` is called by generated code, so it is exported from
`agency-lang/runtime` and added to
`lib/templates/backends/typescriptGenerator/imports.mustache`, next to
`__registerStaticInit` and `__globals`. No Agency source imports it. A
stdlib module cannot import it from `std::policy` for this: the compiler
would be inserting an import the source never wrote, and `std::policy`
imports `std::shell`, which declares effects, so it would be a cycle.

`alwaysScopeFor` is an Agency function exported from `std::policy`,
wrapping the runtime read the same way `std::policy` already wraps
`lib/stdlib/policy.ts`. Its readers are `cliPolicyHandler`,
`buildScopedMatch`, and programs that build their own approval prompt,
which is the audience `std::policy` already serves. It does not go in
`std::index`: that would put a handler-author function in every program's
prelude.

`ScopedField` is the type `std::policy` already exports
(`{ field: string; matchSubpaths: boolean }`). The runtime becomes the
owner of that type and `std::policy` re-exports it.

Registration is idempotent. A module initializes once per process, but
subprocesses (`std::run`) and in-process resumes both re-run module init,
so registering the same effect twice with the same fields is fine; twice
with different fields is a thrown error, because it means two modules
disagree and the typechecker missed it.

Effects raised from TypeScript rather than Agency (`mcp::call` from
`lib/stdlib/mcpGate.ts`) are covered as long as the effect is declared in
an Agency module that gets imported. `mcp::call` is declared in
`stdlib/mcp.agency:23`, which every MCP user imports.

### 5.3 `std::policy` reads the registry

`cliPolicyHandler`'s `fields` parameter becomes optional and means
"override". Resolution order for one effect:

1. `fields[effect]` if the caller passed one (including an empty list to
   suppress the option);
2. otherwise `alwaysScopeFor(effect)`.

`buildScopedMatch` takes the same resolution, so the "here" option and the
rule it writes always agree. `askUser` computes `scopedAvailable` from the
resolved list. `describeScopedMatch`, which renders the option label, is
unchanged.

A new exported function `defaultScopedFields(): ScopedRuleFields` returns
the whole registry, for programs that build their own prompt UI.

### 5.4 Generated rules are literal

`buildScopedMatch` escapes glob metacharacters in the value before it
builds the pattern, for both exact and subpath fields. The `escapeGlob` in
`lib/runtime/builtinPolicies.ts` moves into the policy matcher module so
both callers share it. After this change, approving `bash` with
`command: "ls *.md"` saves a rule that matches only that command.

Hand-written rules in a policy file are still patterns. Only generated
rules are escaped, which is the same split Claude Code settled on.

### 5.5 Raise sites that compute their scope field

One of the agreed scopes is not a payload field today. The raise site includes the field it wants "here" to mean, so the scope
table never has to derive a value. Handlers that users write get the same field to
match on, which they would want anyway.

**`std::openUrl`** gains `host`, the hostname of `url`, since only the host
is a useful scope and it is not a payload field today:

```
@always(host)
effect std::openUrl { url: string, host: string }
```

**`std::http::fetch` / `fetchJSON` / `fetchMarkdown`** need no new field.
Their payload already has `method`, `baseUrl`, and `path`; the scope pins
the first two:

```
@always(method, baseUrl)
effect std::http::fetch { baseUrl: string, path: string, method: string }
```

So one approval covers every later request with the same method to the
same base URL, whatever the path:

```
approve always here (method=GET, baseUrl=https://api.search.brave.com)
```

A scope that also pins `path` for non-GET requests was considered and set
aside: it needs a scope that depends on the value, which this spec avoids.
If a per-endpoint scope turns out to matter, adding `path` to the tag is a
one-line change and only makes the rule tighter.

### 5.6 The table of scopes

Every stdlib effect, with the `@always` it gets. "none" means the effect
keeps only the whole-effect "approve always" choice. Effects already
approved by the `recommended` policy are still tagged, so users on
`minimal` benefit.

Files and shell (`stdlib/index.agency`, `stdlib/fs.agency`, `stdlib/shell.agency`, `stdlib/agency.agency`):

| effect | `@always` |
|---|---|
| `std::read`, `std::readBinary`, `std::readImage` | `@alwaysUnder(dir)` |
| `std::write`, `std::writeBinary`, `std::edit` | `@alwaysUnder(dir)` |
| `std::ls`, `std::glob`, `std::grep` | `@alwaysUnder(dir)` |
| `std::mkdir` | `@alwaysUnder(dir)` |
| `std::remove` | `@alwaysUnder(target)` |
| `std::copy`, `std::move` | `@alwaysUnder(src, dest)` |
| `std::applyPatch` | none (a patch names many files) |
| `std::exec` | `@always(command, subcommand)` |
| `std::bash` | `@always(command, cwd)` |
| `std::run` | none (already whole-effect in `recommended`; the subprocess raises its own effects) |

Git (`stdlib/git.agency`): all seventeen `std::git::*` effects get
`@alwaysUnder(cwd)`. This matches how `with-writes` scopes them.

Environment and secrets (`stdlib/system.agency`, `stdlib/auth/*.agency`):

| effect | `@always` |
|---|---|
| `std::env` | `@always(name)` |
| `std::setEnv` | `@always(name)` |
| `std::getSecret`, `std::setSecret`, `std::deleteSecret` | `@always(service, key)` |
| `std::authorize`, `std::getAccessToken`, `std::revokeAuth` | `@always(name)` |
| `std::authorizeCalendar` | `@always(clientId)` |

Network (`stdlib/http.agency`, `stdlib/system.agency`, `stdlib/web/*.agency`, `stdlib/wikipedia.agency`, `stdlib/weather.agency`, `stdlib/data/**`):

| effect | `@always` |
|---|---|
| `std::http::fetch`, `fetchJSON`, `fetchMarkdown` | `@always(method, baseUrl)` |
| `std::openUrl` | `host` (new field, 5.5) |
| `std::search`, `std::tavilySearch`, `std::wikipedia::*`, `std::weather`, `std::browserUse` | none |
| data connectors (`std::fred`, `edgar`, `dbnomics`, `usaspending`, `wikidata`, `gdelt`, `littlesis`, `hackernews`, `yc`, `bluesky`) | none |

Outward messages (`stdlib/messaging/*.agency`, `stdlib/system.agency`, `stdlib/speech.agency`, `stdlib/clipboard.agency`):

| effect | `@always` |
|---|---|
| `std::sendEmail`, `std::sendSms`, `std::sendIMessage` | `@always(to)` |
| `std::notify`, `std::say`, `std::synthesizeSpeech`, `std::transcribe`, `std::record`, `std::screenshot`, `std::clipboardCopy`, `std::clipboardPaste` | none |

Agent machinery (`stdlib/mcp.agency`, `stdlib/skills.agency`, `stdlib/toolbox.agency`, `stdlib/memory.agency`, `stdlib/calendar.agency`, `stdlib/notes/apple.agency`):

| effect | `@always` |
|---|---|
| `mcp::call` | `@always(server, tool)` |
| `std::skills::skillsDir`, `std::skills::commandsDir`, `std::toolbox::scan` | `@alwaysUnder(dir)` |
| `std::memory::*` | none |
| `std::listEvents`, `createEvent`, `updateEvent`, `deleteEvent` | `@always(calendarId)` |
| `std::notes::*` | `@always(folder)` |
| `std::question`, `std::toolbox::review`, `std::agents::planApprove` | none, and see 5.7 |
| `std::exit` | none (whole-effect "always" stays available) |

### 5.7 Interrupts that ask a question, not a permission

`std::question`, `std::toolbox::review`, and `std::agents::planApprove`
return a value to the raise site: an answer, a review verdict, a plan
decision. "Approve always" makes no sense for them; the runtime already
knows they expect a value (`expectsValue` on the interrupt record, used by
`lib/runtime/interruptResolution.ts`). `askUser` drops the "approve always"
and "reject always" choices when the interrupt expects a value, and offers
only once-approve, once-reject, and free text.

This is a behaviour change independent of `@always`, small enough to ship
in the same PR.

### 5.8 The agent

`ALWAYS_FIELDS` and its import are deleted from
`lib/agents/agency-agent/lib/config.agency`; `policyHandlerFor` in
`lib/agents/agency-agent/lib/turn.agency` stops passing `fields:`. Every
effect the table listed is covered by a declaration in 5.6, including
`mcp::call`. The agent's `tests/*Policy.agency` tests that assert the
"here" option keep passing because the scope now comes from the registry.

### 5.9 `agency doc`

Unchanged. The scope is an approval-prompt detail, and the prompt itself
shows it at the moment it matters. `agency doc` keeps listing effects and
payloads as it does today.

## 6. What the user sees afterwards

The Brave key case:

```
Are you sure you want to read this environment variable?
  name: BRAVE_API_KEY

  (a)  approve once
  (r)  reject once
  (aa) approve always (every future std::env)
  (ap) approve always here (name=BRAVE_API_KEY)
  (rr) reject always
```

Choosing `(ap)` writes to `~/.agency-agent/policy.json`:

```json
"std::env": [{ "match": { "name": "BRAVE_API_KEY" }, "action": "approve" }]
```

A shell command:

```
  (ap) approve always here (command=pnpm test:run, cwd=/Users/adi/proj)
```

## 7. Testing

Compiler:

- Parser fixture: an effect declaration with `@always(name)`,
  `@alwaysUnder(dir)`, and a two-field tag round-trips through the
  formatter unchanged.
- Typechecker tests in `lib/typeChecker/effectPayloadCheck.test.ts`: unknown
  field, malformed argument, two tags, stray tag, and the agreeing and
  disagreeing multi-declaration cases. Each asserts the diagnostic code and
  location.
- Codegen fixture in `tests/typescriptGenerator/`: a tagged declaration
  emits the registration call; an untagged one emits nothing.

Runtime:

- `registerAlwaysScope` twice with equal fields is a no-op; with different
  fields throws.

`std::policy` (Agency tests in `tests/agency/`):

- With no `fields:` argument, an interrupt whose effect is registered
  offers "approve always here" and the saved rule pins the declared fields.
- `fields:` overrides the registry, and an explicit empty list suppresses
  the option.
- `buildScopedMatch` escapes `*`, `{`, `,`, `[` in values; a saved `bash`
  rule for `ls *.md` does not match `ls a.md`.
- A value-expecting interrupt shows no "always" choices.

Agent:

- `tests/readPolicy.agency`, `execPolicy.agency`, `gitPolicy.agency`,
  `mcpGating.agency` pass with `ALWAYS_FIELDS` removed.
- One new test: a `std::env` interrupt under the agent's handler offers the
  "here" option scoped to `name`.

Stdlib coverage check: a test that walks every `effect` declaration in
`stdlib/` and asserts the set with an `@always` tag equals the set in 5.6.
It fails when someone adds an effect without deciding its scope.

## 8. Files touched

Compiler and runtime:

- `lib/types/effectDeclaration.ts` (no change; tags already on the type)
- `lib/utils/alwaysTag.ts` (new): read and validate the tag, shared by the
  typechecker and codegen
- `lib/typeChecker/effectPayloadCheck.ts`: the checks in 5.1
- `lib/typeChecker/diagnostics/*`: new diagnostic codes with explanations
- `lib/backends/typescriptBuilder.ts:636` and a new typestache template for
  the registration call
- `lib/runtime/alwaysScope.ts` (new): the registry; `__registerAlwaysScope`
  exported from `lib/runtime/index.ts`
- `lib/templates/backends/typescriptGenerator/imports.mustache`: import
  `__registerAlwaysScope`
- `lib/runtime/policy.ts`: `escapeGlob` moves here

Stdlib:

- `stdlib/policy.agency`: `alwaysScopeFor`, `defaultScopedFields`, registry
  fallback,
  escaping, the value-expecting prompt change
- `stdlib/system.agency`: the `host` field on `std::openUrl`
- every stdlib file with an `effect` declaration in 5.6: one tag line each

Agent:

- `lib/agents/agency-agent/lib/config.agency`: delete `ALWAYS_FIELDS`
- `lib/agents/agency-agent/lib/turn.agency`: drop `fields:`

Docs (dev, same PR):

- `docs/dev/agents/approval-policies.md`: a section on `@always`, the
  registry, and escaping
- `docs/dev/language/` : a short note on the tag, linked from the effects
  doc

## 9. Decisions made in review

- Value-expecting interrupts (5.7) lose their "always" choices in this
  same change.
- `std::exit` stays approvable with whole-effect "always".
- `std::bash` scope is exact `command` plus `cwd`. A command whose
  arguments change each time never matches twice, which is intended.
- HTTP keeps its three payload fields and pins `method` and `baseUrl`. No
  conditional scoping for non-GET requests.
- `agency doc` does not render the scope.
