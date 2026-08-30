# Roadmap: what has to change before untrusted Agency code is safe to run

Read `goal.md` first; this document is the list of gaps between the code
today and that goal. Each entry says what is wrong, how to see it, and what
the fix looks like. Tick entries off here as they merge, and add new ones
when a fresh hole is found. Every entry that has a GitHub issue links it.

The entries are grouped by which part of the argument in `goal.md` they
break. Within a group they are in the order to do them.

## A. The only door is the standard library

### A1. Pure Agency code can reach any JavaScript global (#971)

**Layer 1 (the bind-check) DONE** — `jsGlobals: "sandbox"`, `SANDBOX_JS_GLOBALS`,
and `checkSandboxNames` refuse free identifiers, `new` callees, the
constructor/prototype walk (best-effort), tag arguments, and default values;
see `docs/dev/compiler/agency-only-bound-names.md`.

**Layer 2 (disable code-generation-from-strings) — shipped for `agency run`.**
`agency run --agency-only` spawns the child Node process with
`--disallow-code-generation-from-strings` (`sandboxRuntimeNodeArgs` in
`lib/cli/commands.ts`), so `eval`, the `Function` constructor, and a
constructor walk through a runtime-computed key (`m[a + b]` where `a + b` is
`"constructor"`, which layer 1's syntactic check cannot see) all throw
`EvalError`. Forks (`std::agency.run` children, whose `execArgv` is set
explicitly in `buildForkOptions`, `lib/runtime/ipc.ts`) and the `agency test
--agency-only` grader path do not carry the flag yet; both follow in #974.

The flag is not a full ban on generating code: `vm.runInThisContext` and
`vm.Script` still run under it. Reaching `vm` needs `require` or
`getBuiltinModule`, which layer 1 refuses by name, so there is no path today —
but layer 3 should not assume the flag alone closes every route to new code.

Layer 3 (freeze intrinsics) still open.

<https://github.com/egonSchiele/agency-lang/issues/971>. An identifier the compiler does not know is emitted verbatim, so
`process.env.HOME`, `process.getBuiltinModule("fs")`, `fetch(...)`,
`eval("...")`, and `globalThis` all work from pure Agency, with no interrupt,
under `--agency-only --reject '*'`. The typechecker's AG4004 is a warning,
`run` ignores warnings, and it only inspects calls, so `process.env` gets no
diagnostic at all.

Fix, in three layers, cheapest first:

1. **Bind-check under `--agency-only`.** Every free identifier must resolve
   to an Agency declaration, an import, the `std::index` prelude, or a
   short reviewed allowlist of pure intrinsics (`Math`, `JSON`, `Number`,
   `String`, `Array`, `Object`, `Set`, `Map`, `Date`, `parseInt`, ...).
   Anything else is a compile error, for value accesses as well as calls.
   This also covers every name the import template puts in scope
   (`readFileSync`, `writeFileSync`, `__process`, `path`, `os`, `z`,
   `smoltalk`), since none of them is Agency-bound. Two positions a plain
   bind-check misses, both found by review and both in scope for this layer:
   the callee of a `new` expression (`new Function(...)`, `new Proxy(...)`,
   `new WebSocket(...)` — the last two are not code-from-strings, so layer 2
   never covers them); the property names `constructor`, `prototype`,
   `__proto__` reached from a value (`x.constructor.constructor`), spelled or
   as a string-literal computed key; tag arguments (`@validate(...)`,
   `@jsonSchema({ ... })`), whose expressions are emitted verbatim and
   executed at module load; and array/object default parameter values
   (`def f(xs = [process.env.HOME])`) — all reproduced leaking under
   `--agency-only --reject '*'`. The position list is by-hand and not proven
   complete; the plan's final phase audits the generator. Design:
   `docs/superpowers/specs/2026-08-29-agency-only-bound-names-design.md`
   (revised after review).
2. **`--disallow-code-generation-from-strings`** on the child Node process
   for `--agency-only` runs (shipped for `agency run`; forks and `agency test`
   in #974 — `sandboxRuntimeNodeArgs` in `lib/cli/commands.ts`). This is the
   REAL boundary for reaching `Function`
   and calling it with a string — via `eval`, `new Function`, or any
   constructor walk including `m[a + b]["constructor"]…` with a runtime-
   computed key, which layer 1's syntactic property check cannot catch
   (verified). So layer 2 ships WITH or immediately after layer 1; layer 1
   alone must not be described as closing code-from-strings. Layer 1 still
   carries what layer 2 cannot see: `new Proxy`/`new WebSocket` (not
   code-from-strings; `className` is a literal, so soundly refused). Grep the
   runtime for `eval`/`new Function` first.
3. **Confinement of the object graph.** After 1 and 2, the remaining
   question is whether an Agency value can be walked to a capability:
   `.constructor`, `__proto__`, `Object.getPrototypeOf`, or a runtime object
   that leaks into user-visible values (a `Result`, interrupt `data`, a
   function object like `read`). The known solution is Hardened JavaScript:
   freeze the intrinsics (`ses` `lockdown()`) and load user modules into a
   Compartment whose globals are the stdlib facade. This needs a design
   note, whose first task is an audit of which runtime objects reach Agency
   values.

Tests to add: the programs in the issue are refused under `--agency-only`;
a positive control (`Math.floor`, `JSON.parse`, `arr.push`) still compiles.

### A2. Review the JavaScript interop allowlist

`JS_GLOBALS` in `lib/typeChecker/resolveCall.ts` was built to avoid false
positives in interop code. It was never reviewed as a security list. Once A1 makes it load-bearing, review
every entry: keep pure value helpers, remove anything that can reach the
host (`Function`, `eval`, `globalThis`, `Reflect`, `Proxy`, `process`,
`fetch`, `require`, `import`, `setTimeout` if it can run strings). No issue
yet; file one when A1 starts.

### A3. Compile-time code execution via splices

Known and documented (`docs/dev/language/splices.md`): `agency tc`, the
language server, `ast`, `fmt`, `doc`, `preprocess`, and `interrupts` all run
splice generators, and only `run`, `compile`, `typecheck`, and `test` offer
`--refuse-splices`. The `recommended` policy approves
`exec("agency tc ...")`, so untrusted code under that policy can reach a
generator through the shell. The roadmap should decide
whether `--refuse-splices` becomes the default for anything that is not an
explicit build, and whether generators run through `compileSandboxed`.
No issue yet.

## B. The runner's handler is outermost and always present

### B1. Top-level `with approve` runs before the root policy exists (#966)

<https://github.com/egonSchiele/agency-lang/issues/966>. `lib/runtime/node.ts`
runs global init and imported modules' top-level code, then installs the
policy handler. A top-level `const x = read(...) with approve` therefore has
only the author's approve in the chain and succeeds under `--reject '*'`.
The per-invocation host policy (`InvocationOptions.policy`, B2) installs at
the same bootstrap site, so it shares this gap: a hosted module's top-level
initializer runs before the host policy exists.
Fix: install the root policy handler and root budget before any user code,
including `__initAllRegistered`; check the resume path in `interrupts.ts`
for the same ordering; add an agency-js test that a top-level read is
rejected.

### B2. The resume leg: raise-time policy shipped; checkpoint integrity open

The host-supplied root policy
(`docs/superpowers/specs/2026-08-29-serve-host-interrupt-policy-design.md`)
is built: `InvocationOptions.policy` installs the outermost handler on the
fresh run and again on every resume leg, so every **raise** — including one
made during a resume — is decided by the host, over the program's own
approving handlers (`tests/agency-js/serve-policy`).

A policy re-check of the caller's responses on resume would add nothing:
the echoed interrupt data is display-only (the resumed program resolves
responses by id and re-reads nothing from the interrupt object), and
anything a policy would reject was already rejected at the raise. What
remains open on the resume leg is **checkpoint integrity**: a stateless
resume restores whatever checkpoint the caller
sends, so the caller controls every local the resumed code runs with (the
budget ceiling is already re-asserted by hand; nothing else is). The fixes
are checkpoint signing with a server key, or host-side checkpoint storage
with the caller holding only an id plus replay protection on that id — see
"who can change it" in `docs/dev/hosting/how-hosted-serving-works.md`. Not
filed yet.

### B3. The sandbox flags do not imply a policy (#970)

<https://github.com/egonSchiele/agency-lang/issues/970>. `--agency-only`
and `--refuse-splices` make effects visible as interrupts; neither blocks
one. With no `--policy`/`--reject`, the author's own `with approve` is the
only handler. Decide one of: `--agency-only` implies a propagate-everything
root handler unless a policy is given; a single `--untrusted` flag that
bundles the right set; or at least a warning and accurate help text.

## C. Nothing reaches the process by accident

### C1. `node_modules` beside the untrusted file shadows `agency-lang` (#967)

<https://github.com/egonSchiele/agency-lang/issues/967>. Generated code
imports `agency-lang/...` as bare specifiers; Node resolves them from the
program's directory first, and the resolver shim
(`lib/cli/runShim/resolver.mjs`) is only a fallback. A planted
`node_modules/agency-lang/` runs arbitrary JS before any handler. Fix: the
shim resolves `agency-lang` and `agency-lang/*` from the install root first,
unconditionally. About five lines.

### C2. `agency.json` in the untrusted tree loads provider modules (#968)

<https://github.com/egonSchiele/agency-lang/issues/968>. Config is found by
walking up from cwd; `client.providerModules` is a list of JS files loaded
with a dynamic import at bootstrap. Fix: under `--agency-only`, never load
provider modules named by a config discovered under the tree being run;
longer term, find a pattern for provider modules that is not "a JS path in
project config".

### C3. `agency.json` in the untrusted tree redirects `llm()`; `--agency-only` ignores the runner's config (#969)

<https://github.com/egonSchiele/agency-lang/issues/969>. `client.baseUrl.*`
plus `defaultProvider` sends every prompt, and the key for that provider,
wherever the tree's config says. Separately, `compileValidatedClosure.ts`
never loads config at all, which is why `--agency-only` happens to be
immune, and why it also ignores the runner's own `agency.json`. Fix: load
the runner's config through the normal path, refuse the tree's explicitly.

### C4. The child's environment (no issue yet)

`withRootCarriers` (`lib/cli/childEnv.ts`) scrubs the four policy and
budget variables from the child's environment and nothing else. A child
running untrusted code should get an allowlist, not the parent's full
environment minus four names; after A1 this matters less, but it is the
right default and it is what statelog needs (see D). File an issue when C1
to C3 are done.

## D. Hosted execution (statelog)

Statelog compiles uploads with plain `compileSource` and imports the result
into the web server process (`src/backend/lib/agencyCompiler.ts`,
`src/backend/lib/serveHost.ts`). Project secrets are injected into the real
`process.env` for the invocation (`src/backend/lib/secrets/projectSecrets.ts`),
and invocations run concurrently. With A1 open, any deployer can read the
database URL, the secrets key, other tenants' in-flight secrets, and the
Cloud Run metadata token. The upload route calls this "trusted single-tenant
v1" (`upload.ts`, containment tracked as statelog #11).

In order:

1. **Say it in the product.** Until the items below ship, only people the
   server owner trusts may deploy. That fact lives in a source comment
   today.
2. **Compile as untrusted.** `compileSandboxed` instead of `compileSource`
   at upload and serve: no TS, no `pkg::`, no splices, imports contained to
   the project directory (also closes statelog #11).
3. **One child process per invocation**, using the `std::agency.run`
   machinery (`lib/runtime/ipc.ts`): `--disallow-code-generation-from-strings`,
   an allowlisted environment carrying only that project's secrets, and the
   interrupt forwarding the child already does. Secrets then never touch
   the server's `process.env`, which ends the cross-tenant window.
4. **Host-owned root policy** per invocation (shipped in agency-lang, B2):
   reject `std::write`, `std::rm`, `std::shell`, `std::run`, and anything
   not on a short hosted allowlist; `std::env` approved only for that
   project's secret names. The reject lands at the raise, so a refused
   effect never reaches `/resume` at all.
5. **Network.** Block link-local addresses (the metadata server) and
   internal services at the network layer, or route `std::http` through a
   broker with an egress allowlist.

Each of these needs a statelog spec; the serve-host policy spec's companion
is the place to start. No statelog issues are filed yet.

## E. Keeping it true

- Every codegen, import-template, and effectful-stdlib change gets a test
  that would fail if the boundary broke.
- `docs/dev/cli/test-cli-sandbox.md` currently claims code before the
  handler "cannot raise an interrupt at all" and that under `--agency-only`
  "every effect the code can perform is an interrupt". Both are false until
  A1 and B1 land; correct the doc when they do, and not before.
- Before hosting strangers' code on the strength of the language, someone
  spends a day trying to break it with this list in hand.

## Status

| Item | Issue | State |
|---|---|---|
| A1 JS globals reachable | #971 | open |
| A2 review `JS_GLOBALS` | — | not filed |
| A3 splice execution in non-build commands | — | not filed, known |
| B1 top-level `with approve` before policy | #966 | open |
| B2 raise-time host policy / checkpoint integrity | spec | policy shipped; integrity open |
| B3 sandbox flags imply no policy | #970 | open |
| C1 `node_modules` shadowing | #967 | open |
| C2 provider modules from tree config | #968 | open |
| C3 `llm()` redirect; `--agency-only` ignores config | #969 | open |
| C4 child env allowlist | — | not filed |
| D statelog hosted execution | statelog #11 (containment only) | open |
