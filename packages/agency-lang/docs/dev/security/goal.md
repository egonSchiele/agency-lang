# The goal: the language decides what runs, a cheap process contains it

Companion: `roadmap.md` lists every gap between the current code and this
goal. `hardening/README.md` lists what has already shipped.

This document used to state the goal as "run untrusted Agency code with no
sandbox at all — the language enforces the rule by itself." That was the wrong
target. It made every line of generated code, every runtime value, and every
config-discovery path a security boundary that had to be perfect, forever, with
no floor under a single mistake. The revised goal keeps what is genuinely
Agency's advantage and drops the part that was a trap.

## The two things we actually want

There are two separate motivations, and they have very different difficulty.

1. **Run agent-written Agency code on my own machine with confidence it will
   not do something harmful.** The code was written by an agent I am running,
   not by an adversary. The threat is a confused or prompt-injected agent, not
   someone crafting an exploit. This is close to reachable and most of it lives
   in this codebase.

2. **Host a service that runs third parties' Agency code.** The code is written
   by strangers, some of whom are adversaries actively trying to break out. This
   is a much larger project, and most of it is not language work at all — it is
   cloud isolation, multi-tenancy, network egress control, and resource
   fairness. See "Hosting strangers" below for why it is a different order of
   problem.

The rest of this document is mostly about (1), because that is the goal the
language work serves directly. (2) reuses the same policy layer but sits on top
of standard cloud isolation rather than replacing it.

## What we want, concretely

Someone hands you an Agency program. You run it. It cannot touch anything (a
file, the network, an environment variable, a shell) unless it asks first, and
you get to say no — and you can say no with precision: allow LLM calls but not
their raw network access, allow writes under one directory but nowhere else,
approve each shell command by hand. This command line should be enough:

```
agency run --agency-only --reject '*' their-program.agency
```

Two mechanisms make it safe, and they do different jobs.

- **The language decides.** Every world-touching standard-library function
  raises an interrupt before it acts, and the handler chain — with the runner's
  outermost handler having the last word — allows or rejects it. This is the
  fine-grained part, and it is what no sandbox can do: a sandbox can say
  "network on or off", it cannot say "this tool yes, that tool no, this
  directory yes, that file no, ask a human for the rest."

- **A cheap process contains what slips past.** The program runs in a plain,
  disposable Node child with its capabilities restricted at the operating-system
  level (filesystem scoped to a workdir, no child processes, an allowlisted
  environment, resource limits). If code ever reaches the world *without* going
  through an interrupt — a hole in the language layer, a runtime bug, a
  compromised dependency — the child is a floor under the damage.

These compose instead of competing. The language keeps its full granularity for
every legitimate effect, because legitimate effects go through the interrupt
door, not the sandbox. The sandbox is a coarse backstop for exactly the things
that tried to skip the interrupt door — which are the things you want stopped
bluntly. You lose granularity only if the sandbox is your *only* door. It is
not.

## Why this is Agency's advantage

Every other language needs a sandbox to run untrusted code because every other
language has *ambient authority*: any line can open a file or a socket, so the
only control is a coarse wall around the whole process — network yes or no,
filesystem yes or no. Agency funnels every effect through the standard library
and reifies it as an interrupt a handler decides. That gives a control surface
sandboxes cannot express: per-tool, per-argument, per-directory, with a human in
the loop.

The old framing tried to turn that advantage into "so we need no sandbox at
all." That does not follow, and it rests on a stale premise — that sandboxes are
heavy. They are not anymore. Node's own permission model (`--permission`) denies
filesystem, child-process, and native-addon access with a spawn flag and no
container. gVisor, V8 isolates, and microVMs (Firecracker boots in ~125ms) are
all light enough to use per run. So the cost of keeping a containment floor is
low, and paying it removes the requirement that the language layer be flawless
before we can trust the system. The advantage was never the absence of a
sandbox; it was the granularity of the policy. We keep the policy and add a
cheap floor.

## What the policy layer needs to be true ("holds all the way down")

For the interrupt door to be the only way legitimate code reaches the world,
three things must hold. These are the front-door work, and they are what most of
the roadmap is about.

1. **The only door is the standard library.** Pure Agency code has no other way
   to reach the world. Agency compiles to JavaScript, an unknown identifier is
   emitted as-is, and `process`, `fetch`, `globalThis`, and `eval` are one bare
   name away (#971). The `--agency-only` bind-check closes this; see the
   hardening doc for what has shipped.
2. **Every door raises an interrupt first, with a truthful payload.** This is a
   property of the standard library's TypeScript, kept true by review. The
   standard library is the trusted computing base; keeping it small and reviewed
   is the whole point of funnelling effects through it.
3. **The runner's handler is outermost, and always in the chain.** Top-level
   code once ran before the root policy was installed (#966, fixed); resumed
   interrupts must be decided by the chain too.

There is a fourth condition that is not about the language: the process must not
hand the code anything by accident. A `node_modules` directory, an
`agency.json`, or the parent's environment beside the untrusted file are all
ways in without an `import` (#967, #968, #969). This is where the front door and
the containment floor meet — the environment allowlist and the capability-denied
child both belong to it.

## Why the floor is not optional

Even with all three front-door conditions true, two problems are unreachable by
any capability rule, and only a killable, limited process solves them:

- A `while (true) {}` or a memory balloon in a shared process stalls or starves
  everyone on it. Only a separate child with resource limits fixes that.
- A bug in the trusted computing base (compiler, runtime, stdlib, Node itself)
  is a full compromise of whatever shares the process. A process boundary caps
  it to one run.

So the goal is **one plain, capability-restricted Node child per untrusted
run**, with an allowlisted environment, resource limits, and its
operating-system capabilities denied down to what the policy actually needs. The
child machinery already exists (`std::agency.run`, `lib/runtime/ipc.ts`) and
already carries resource limits; what it does not yet carry is capability
denial and the environment allowlist (roadmap C4, G, and the `--permission`
work).

The strongest version of this floor is **brokering**: the child performs no
effects itself, it only *requests* them, and the parent performs each approved
effect and passes back the result. Then the child can be denied all filesystem
and network access, because it never needed any — everything real happens in the
parent, after the policy said yes. Agency is unusually suited to this because
effects are already reified as interrupts that already cross the child-to-parent
boundary for the decision; brokering moves the *action* to the parent side of a
message that already exists. That is a bounded, later project (roadmap), not a
prerequisite.

## What the goal demands of us

The compiler becomes a security boundary. What that changes:

- The rule "every free identifier is bound by Agency, or the compile fails" has
  to be sound. A typechecker warning does not stop a run.
- The list of JavaScript globals Agency code may use (`JS_GLOBALS` in
  `lib/typeChecker/resolveCall.ts`) is an attack surface and is reviewed as one.
  `Math` and `JSON` are fine; anything that reaches the host is not.
- Changes to code generation, the import template
  (`lib/templates/backends/typescriptGenerator/imports.mustache`), and the
  stdlib's effectful functions need a test that would fail if the boundary
  broke, not only a test that the feature works.
- The invariant is written down (this document, `roadmap.md`, and
  `hardening/README.md`) and someone tries to break it before we rely on it.

## What the floor still does not buy

Two harms survive containment, because they operate through channels the policy
approved, and they are worth naming so nobody reads "sandboxed" as "safe":

- **Exfiltration and misuse through allowed channels.** A prompt-injected agent
  does not need a hole; it needs one allowed tool whose arguments it controls.
  Data the agent legitimately read can leave through an approved LLM call or an
  approved web request. The defense is at the policy layer (inspect the
  arguments, allowlist egress destinations), not the sandbox.
- **Booby-trapped output.** The agent's job is producing artifacts you will run
  later with your own privileges — a committed file, a generated script, a
  `package.json`. Nothing harmful happens inside the sandbox; it happens when
  you run the output tomorrow. Only review addresses this.

These are policy-and-review problems, permanently outside what any sandbox
catches.

## Hosting strangers

Motivation (2) is a different and larger project, and most of it is not in this
repo. Running third parties' code in a hosted service exposes the entire
deployment environment, much of which is not obvious until it bites: cloud
metadata endpoints (169.254.169.254 and internal service URLs) that hand out
credentials via SSRF, same-VPC internal services that trust "inside the
network", the container's own mounted secrets and service-account identity,
noisy-neighbor resource abuse, cross-tenant leakage through any shared state,
and the build/deploy path itself (compiling untrusted source can execute code —
splices). None of these is a language bug; they are properties of running
untrusted code in a real cloud.

So a hosting service should not try to make the language sound enough to be the
*only* boundary. It should run each invocation under standard cloud isolation
(per-invocation gVisor or microVM, network egress allowlist, per-tenant resource
quotas, secrets never in shared `process.env`) and use Agency's policy layer for
the fine-grained control those platforms do not offer. Agency's pitch to a host
is the policy layer, not the absence of isolation.

## Until then

Until the roadmap is done, `--agency-only` reduces attack surface but is not a
containment boundary on its own, and statelog's hosted execution is
single-tenant and trusted: only people the server owner trusts may deploy. Say
so wherever a user could believe otherwise.
