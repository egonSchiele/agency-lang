# What hardening has shipped

`goal.md` states the goal: run untrusted Agency code safely with no
operating-system sandbox. `roadmap.md` lists every gap still between the code
and that goal. This directory is the third view: what we have already built.
The roadmap is the to-do list; this is the done list. When a roadmap item
merges, summarize it here and link the dev doc that explains it in depth, so
someone can see the whole hardening story in one place without reading a year
of commits.

## The model these pieces fit into

Think of two doors out of any run of untrusted code.

- **The front door is the policy.** Every world-touching standard-library
  function raises an interrupt before it acts, and the handler chain — with the
  runner's outermost handler having the last word — decides allow or reject.
  This is where all the *granularity* lives: "allow LLM calls, reject their raw
  network access", "allow writes under this one directory". Most hardening work
  is making sure this door cannot be walked around: that pure Agency code has no
  way to reach the world except through it, and that the runner's handler is
  always in the chain.

- **The back door is containment.** If code ever reaches the world *without*
  going through an interrupt — a hole in the language layer, a bug, a
  compromised dependency — containment is what limits the damage. Freezing the
  JavaScript object graph, spawning a locked-down child process, resource
  limits. This door is deliberately dumb: it does not understand what the code
  was trying to do, it just makes "went around the policy" yield as little as
  possible.

The two compose. The front door keeps its fine-grained decisions for every
legitimate effect; the back door is a coarse floor under everything that tried
to skip the front door. Losing granularity would only happen if containment
were the *only* door — it is not, and is not meant to be.

Everything below is grouped by which door it reinforces, matching the argument
in `goal.md`.

## Front door: the only path to the world is the standard library

### Layer 1 — the compile-time bind-check (#971, #973)

Under `--agency-only`, every free identifier in Agency source must resolve to
an Agency declaration, an import, the `std::index` prelude, or a short reviewed
allowlist of pure intrinsics (`Math`, `JSON`, `Number`, `Array`, ...). Anything
else is a compile error, not a warning. This is what stops pure Agency code
from naming `process`, `fetch`, `eval`, or `globalThis` and reaching the host
with no interrupt. The check also covers four positions a plain
identifier check misses: the callee of a `new` expression, the
`constructor`/`prototype`/`__proto__` property walk from a value, tag arguments
(`@validate(...)`), and array/object default parameter values.

Depth: `docs/dev/compiler/agency-only-bound-names.md`. It is defense in depth,
not the whole boundary — that doc explains what the check is and is not sound
against.

### Layer 2 — no code generation from strings (#975)

`agency run --agency-only` spawns the child Node process with
`--disallow-code-generation-from-strings`, so `eval` and the `Function`
constructor throw. This closes the one route layer 1 cannot see by reading the
source: a property key *built at runtime* that walks to `Function`
(`m[a + b]` where `a + b` computes to `"constructor"`). Layer 1 and layer 2
ship together for that reason — the syntactic check and the runtime flag cover
what the other cannot.

Wiring: `sandboxRuntimeNodeArgs` in `lib/cli/commands.ts`. The flag is on for
`agency run` today; forks (`std::agency.run` children) and the
`agency test --agency-only` grader path do not carry it yet — that is #974.

### Layer 3 — freeze the object graph (planned, not shipped)

Layers 1 and 2 do not change the JavaScript object graph: `Object`, `Array`,
`Function`, and every prototype are still shared and mutable. Layer 3 freezes
them with SES (`lockdown()`), and later runs untrusted modules in a Compartment
whose global holds only the standard-library facade. Feasibility is proven and
the implementation is planned but not built:
`docs/superpowers/specs/2026-08-30-ses-feasibility-investigation.md` and
`docs/superpowers/plans/2026-08-30-ses-layer3-plan.md`. Listed here because the
other two layers point forward to it; move it up when phase 1 merges.

## Front door: the runner's handler is always outermost

### Root policy handler installed before any user code (#966, #987)

Top-level Agency code — a module's initializers, `const x = read(...) with
approve` at the top level — used to run *before* the runner's policy handler
was installed, so it answered to only the author's own handlers and slipped
past `--reject '*'`. Now `initFreshExecCtx` installs the root policy handler and
the root budget first, before `__initAllRegistered` and any user code. The
resume path installs the policy before re-registering top-level callbacks, and
a `std::agency` subprocess never had the gap (its top-level init consults the
parent's chain over IPC like any other raise).

Test: `tests/agency-js/policy-top-level`. Residual: `rewindFrom` still runs a
replay without installing the policy first (#800, local/debugger-only).

### Host-supplied root policy for served invocations (#978)

A host serving an agent over HTTP can pass `InvocationOptions.policy`. It
installs as the outermost handler on the fresh run and again on every resume
leg, so every raise — including one made mid-resume — is decided by the host,
over the program's own approving handlers. This is the piece a hosted service
needs to reject `std::write`/`std::shell`/etc. for an uploaded agent regardless
of what the agent's own code approves.

Depth: `docs/dev/agents/approval-policies.md`,
`docs/dev/hosting/how-hosted-serving-works.md`. What remains open on the resume
leg is checkpoint integrity — see below and roadmap B2.

## Back door: the checkpoint cannot be tampered with undetected

A checkpoint is the serialized execution state a program resumes from. Because
a stateless resume restores whatever checkpoint the caller sends, the caller
controls every local the resumed code runs with. Three pieces harden that:

- **HMAC integrity checksum (#981).** A checkpoint can carry an HMAC keyed by a
  server secret; a host verifies it on resume and refuses a checkpoint whose
  state was altered. Depth: `docs/dev/runtime/checkpoint-integrity.md`.
- **Code fingerprints (#982).** A checkpoint records a fingerprint of the code
  of each module it is paused inside, and the runtime refuses to resume if that
  code has changed — so a resume cannot land old execution state into new,
  differently-behaving code. Depth:
  `docs/dev/runtime/checkpoint-code-fingerprints.md`.
- **Schema round-trip fidelity (#977).** The checkpoint schema no longer silently
  drops guards, cost, and drafts when a checkpoint is reloaded from JSON — a
  correctness fix with a safety edge, since a dropped cost guard is a dropped
  budget ceiling.

## Back door: resource limits on the child (partial)

`std::agency.run` already caps a child subprocess: wall-clock time, V8 heap,
IPC payload size, stdout size, LLM cost, and nesting depth, each killing the
child on breach (`run` in `stdlib/agency.agency`, `buildForkOptions` in
`lib/runtime/ipc.ts`). This is the containment unit for agent-written code run
through `run`. What is *not* yet done: the same defaults for the `--agency-only`
CLI child (roadmap G), an environment allowlist instead of inheriting the
parent's full environment (roadmap C4), and OS-level capability denial on the
child (`--permission`; see the roadmap).

## Related, older hardening

- **`--refuse-splices`** (#908, #910) refuses compile-time splice generators,
  which run arbitrary code at compile time. Available on `run`, `compile`,
  `typecheck`, `test`; making it the default outside explicit builds is roadmap
  A3. Depth: `docs/dev/language/splices.md`.
- **`@always` approve scopes** (#963) let an effect declaration mark scopes that
  are approved without prompting, as data on the effect rather than scattered in
  handlers. Depth: `docs/dev/language/effect-always-tag.md`.

## How to keep this current

When a roadmap item merges: add a short entry here under the right door, link
its dev doc, and tick it on `roadmap.md`. Keep this file a map to the depth
docs, not a copy of them — one paragraph per shipped item, with the code
reference and the doc link.
