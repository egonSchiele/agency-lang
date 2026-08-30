# The goal: running untrusted Agency code without a sandbox

Companion: `roadmap.md` in this directory lists every issue that stands
between the current code and this goal.

## What we want

Someone hands you an Agency program you have never read. You run it. It
cannot touch anything (a file, the network, an environment variable, a
shell) unless it asks first, and you get to say no. That holds with no
container, no virtual machine, and no operating-system sandbox around the
process. The language enforces the rule.

Concretely, this command line should be enough:

```
agency run --agency-only --reject '*' their-program.agency
```

and a host like statelog should be able to run an uploaded agent in a plain
Node child process and give it only the effects that project is allowed.

## Why we want this

Every other language needs a sandbox to run code you do not trust, because
every other language has *ambient authority*: any line of code can open a
file or a socket, so the only way to stop it is to wrap the whole process.
Sandboxes are slow to start, cost money to run, and add operational weight.

Agency was designed differently. The only way for Agency code to affect the
world is through the standard library, and every world-touching function in
the standard library raises an interrupt before it acts. An interrupt is
decided by the handler chain, and in that chain a reject from an outer
handler beats an approve from an inner one (`mergeChainOutcomes` in
`lib/runtime/interrupts.ts`: reject > propagate > approve). So whoever runs the
program, and installs the outermost handler, has the last word over
everything the program does.

If that property holds all the way down, Agency does not need a sandbox.
Hosted agents can then start in milliseconds, run in one process, and cost
nothing extra to isolate.

## What "holds all the way down" means

The argument above has three parts, and each has to be true:

1. **The only door is the standard library.** Pure Agency code has no other
   way to reach the world. Today this is false. Agency compiles to
   JavaScript, an unknown identifier is emitted as-is, and `process`,
   `fetch`, `globalThis`, and `eval` are one bare name away (#971). Closing
   this is most of the work.
2. **Every door raises an interrupt first, with a truthful payload.** This is
   a property of the standard library's TypeScript, kept true by review.
   The standard library is the trusted computing base; keeping it small and
   reviewed is the whole point of funnelling effects through it.
3. **The runner's handler is outermost, and always in the chain.**
   Today top-level code runs before the root policy handler is installed
   (#966), and resumed interrupts are answered before the chain runs
   (`docs/superpowers/specs/2026-08-29-serve-host-interrupt-policy-design.md`).

There is a fourth condition that is not about the language at all: the
process the code runs in must not hand it anything by accident. A
`node_modules` directory, an `agency.json`, or the parent's environment
beside the untrusted file are all ways code gets in without an `import`
(#967, #968, #969).

## What a language cannot buy, and what we keep

Language-level security has a track record (Joe-E for Java, Caja and
Hardened JavaScript for JavaScript, which MetaMask and Agoric use to run
strangers' code in-process). All of them still needed one thing outside the
language: a unit of execution that can be limited and killed.

- A `while (true) {}` in a shared process stalls everyone on that event
  loop. No capability rule fixes that; only a separate worker or child
  process with resource limits does.
- A bug in the trusted computing base (compiler, runtime, stdlib, Node
  itself) is a full compromise of whatever shares the process. A process
  boundary caps that to one run.

So the goal is **no operating-system sandbox** and **one plain Node child
process per untrusted run**, with an allowlisted environment and resource
limits. A child process is a `fork()`. The machinery for it already exists (`std::agency.run`, `lib/runtime/ipc.ts`). We keep it for
budgets and cancellation anyway.

## What the goal demands of us

The compiler becomes a security boundary. What that changes about how we
work on it:

- The rule "every free identifier is bound by Agency, or the compile fails"
  has to be sound. A typechecker warning does not stop a run.
- The list of JavaScript globals Agency code may use (`JS_GLOBALS` in
  `lib/typeChecker/resolveCall.ts`) is an attack surface and is reviewed as
  one. `Math` and `JSON` are fine; anything that reaches the host is not.
- Changes to code generation, the import template
  (`lib/templates/backends/typescriptGenerator/imports.mustache`), and the
  stdlib's effectful functions need a test that would fail if the boundary
  broke, not only a test that the feature works.
- The invariant is written down (this document and `roadmap.md`) and
  someone tries to break it before we rely on it for strangers' code.

## Until then

Until the roadmap is done, `--agency-only` reduces attack surface but is not
a sandbox, and statelog's hosted execution is single-tenant and trusted:
only people the server owner trusts may deploy. Say so wherever a user
could believe otherwise.
